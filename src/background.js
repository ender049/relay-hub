const OPEN_MODE_KEY = 'relay_open_mode';
const POPUP_PATH = 'pages/popup.html';

applyOpenMode();
chrome.runtime.onInstalled.addListener(applyOpenMode);
chrome.runtime.onStartup.addListener(applyOpenMode);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[OPEN_MODE_KEY]) applyOpenMode();
});

async function applyOpenMode() {
  try {
    const data = await chrome.storage.local.get(OPEN_MODE_KEY);
    const mode = normalizeOpenMode(data[OPEN_MODE_KEY]);
    if (mode === 'sidepanel' && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      await chrome.action.setPopup({ popup: '' });
    } else {
      await chrome.action.setPopup({ popup: POPUP_PATH });
      if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      }
    }
  } catch (err) {
    console.warn('[Relay Hub open mode failed]', err);
  }
}

function normalizeOpenMode(value) {
  return value === 'sidepanel' ? 'sidepanel' : 'popup';
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'CPA_CHANNEL_FETCH') {
    handleExtensionFetch(msg.payload || {}).then(sendResponse);
    return true;
  }
  if (msg.type === 'RELAY_OPEN_SITE_LOGIN') {
    openSiteLogin(msg.payload || {}).then(sendResponse);
    return true;
  }
  if (msg.type === 'RELAY_READ_SITE_TOKENS') {
    readSiteTokens(msg.siteUrl, msg.siteType).then(sendResponse);
    return true;
  }
  return false;
});

async function openSiteLogin(payload = {}) {
  try {
    if (!chrome.scripting || !chrome.scripting.executeScript) throw new Error('当前浏览器不支持登录页代填');
    const url = loginUrl(payload.siteUrl || '', payload.siteType || '');
    const tab = await chrome.tabs.create({ url });
    if (tab && tab.id) {
      await waitForTabComplete(tab.id, 12000).catch(() => {});
      await injectAutofill(tab.id, payload.username || '', payload.password || '').catch(() => {});
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(false), timeoutMs || 10000);
    const finish = ok => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      ok ? resolve() : reject(new Error('等待登录页加载超时'));
    };
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) return;
      if (tab && tab.status === 'complete') finish(true);
    });
  });
}

async function injectAutofill(tabId, username, password) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: autofillLoginInPage,
    args: [username || '', password || '']
  });
}

function autofillLoginInPage(username, password) {
  const visible = el => !!(el && el.offsetParent !== null && !el.disabled && !el.readOnly);
  const setValue = (el, value) => {
    if (!el || !value) return false;
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const findUser = () => Array.from(document.querySelectorAll('input')).find(el => visible(el) && /^(email|text|tel|search)$/i.test(el.type || 'text') && /(user|email|mail|account|login|name|账号|邮箱|用户名)/i.test(`${el.name} ${el.id} ${el.placeholder} ${el.autocomplete}`)) || Array.from(document.querySelectorAll('input')).find(el => visible(el) && /^(email|text)$/i.test(el.type || 'text'));
  const findPass = () => Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
  let tries = 0;
  let timer = null;
  const fill = () => {
    tries += 1;
    const okUser = setValue(findUser(), username) || !username;
    const okPass = setValue(findPass(), password) || !password;
    if (((okUser && okPass) || tries >= 20) && timer) clearInterval(timer);
  };
  fill();
  timer = setInterval(fill, 400);
}

async function readSiteTokens(siteUrl, siteType) {
  try {
    if (!chrome.scripting || !chrome.scripting.executeScript) throw new Error('当前浏览器不支持读取页面令牌');
    const expectedUrl = parseHttpUrl(siteUrl);
    if (!expectedUrl) throw new Error('请先填写渠道站点地址');
    const tab = await findSiteTab(expectedUrl, '读取令牌');
    const currentUrl = parseHttpUrl(tab.url);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractSiteTokensInPage,
      args: [siteType || '']
    });
    return { ok: true, siteUrl: expectedUrl.href, pageUrl: currentUrl.href, ...(result && result.result ? result.result : {}) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function loginUrl(siteUrl, siteType) {
  const url = parseHttpUrl(siteUrl);
  if (!url) throw new Error('请先填写有效的渠道站点地址');
  const path = url.pathname.replace(/\/+$/, '');
  if (!path || path === '/' || path.startsWith('/api') || (siteType === 'sub2api' && path.endsWith('/api/v1'))) {
    url.pathname = '/login';
  }
  url.search = '';
  url.hash = '';
  return url.href;
}

async function findSiteTab(expectedUrl, action) {
  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = active.find(tab => tab && tab.id && tab.url && tabMatchesSite(tab, expectedUrl));
  if (activeTab) return activeTab;
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find(item => item && item.id && item.url && tabMatchesSite(item, expectedUrl));
  if (tab) return tab;
  throw new Error(`${action}需要先打开并登录 ${expectedUrl.hostname} 标签页`);
}

function tabMatchesSite(tab, expectedUrl) {
  const currentUrl = parseHttpUrl(tab.url);
  return !!(currentUrl && siteHostsMatch(currentUrl.hostname, expectedUrl.hostname));
}

async function extractSiteTokensInPage(siteType) {
  const dump = store => {
    const out = {};
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      out[key] = store.getItem(key);
    }
    return out;
  };
  const safeJson = value => {
    try { return JSON.parse(value); } catch (_) { return value; }
  };
  const flatten = value => {
    const out = [];
    const walk = (path, item) => {
      if (item == null) return;
      if (typeof item === 'string') {
        out.push([path, item]);
        const parsed = safeJson(item);
        if (parsed !== item) walk(path, parsed);
      } else if (typeof item === 'number' || typeof item === 'boolean') {
        out.push([path, String(item)]);
      } else if (Array.isArray(item)) {
        item.forEach((child, index) => walk(`${path}.${index}`, child));
      } else if (typeof item === 'object') {
        Object.entries(item).forEach(([key, child]) => walk(path ? `${path}.${key}` : key, child));
      }
    };
    walk('', value);
    return out;
  };
  const normalize = value => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const useful = value => {
    const text = String(value || '').trim();
    return text && text !== 'null' && text !== 'undefined' && text !== '0';
  };
  const pick = (values, names) => {
    const wanted = names.map(normalize);
    for (const [key, value] of values) {
      const leaf = String(key || '').split('.').pop();
      if (wanted.includes(normalize(leaf)) && useful(value)) return String(value).trim();
    }
    for (const [key, value] of values) {
      const normalized = normalize(key);
      if (wanted.some(name => normalized.includes(name)) && useful(value)) return String(value).trim();
    }
    return '';
  };
  const pickJwt = values => {
    const hit = values.find(([, value]) => {
      const text = String(value || '').trim();
      return text.length > 24 && (text.match(/\./g) || []).length === 2 && /^[A-Za-z0-9._=-]+$/.test(text);
    });
    return hit ? String(hit[1]).trim() : '';
  };
  const findUserId = value => {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(findUserId).find(Boolean) || '';
    if (typeof value !== 'object') return '';
    for (const key of ['id', 'user_id', 'userId', 'uid']) {
      const item = value[key];
      if (typeof item === 'string' && item.trim()) return item.trim();
      if (typeof item === 'number') return String(item);
    }
    return Object.values(value).map(findUserId).find(Boolean) || '';
  };

  const storage = {
    localStorage: Object.fromEntries(Object.entries(dump(localStorage)).map(([key, value]) => [key, safeJson(value)])),
    sessionStorage: Object.fromEntries(Object.entries(dump(sessionStorage)).map(([key, value]) => [key, safeJson(value)])),
    documentCookie: document.cookie || ''
  };
  const values = flatten(storage);
  String(document.cookie || '').split(';').forEach(part => {
    const index = part.indexOf('=');
    if (index > 0) values.push([part.slice(0, index).trim(), part.slice(index + 1).trim()]);
  });

  let token = pick(values, ['auth_token', 'authToken', 'access_token', 'accessToken', 'bearerToken', 'jwt', 'token']) || pickJwt(values);
  const refresh = pick(values, ['refresh_token', 'refreshToken', 'refresh']);
  const expires = pick(values, ['token_expires_at', 'tokenExpiresAt', 'accessTokenExpiresAt', 'expires_at', 'expiresAt', 'expireAt']);
  let userId = pick(values, ['user_id', 'userId', 'uid', 'id']);

  if (siteType === 'newapi' && !userId) {
    try {
      const headers = {};
      if (token) headers.Authorization = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
      const res = await fetch('/api/user/self', { headers, credentials: 'include', cache: 'no-store' });
      const json = await res.json();
      userId = findUserId(json);
    } catch (_) {}
  }

  return {
    auth_token: token,
    access_token: token,
    refresh_token: refresh,
    cookie: document.cookie || '',
    token_expires_at: expires,
    user_id: userId,
    userId
  };
}

function parseHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return /^https?:$/i.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function siteHostsMatch(currentHost, expectedHost) {
  const current = normalizeHost(currentHost);
  const expected = normalizeHost(expectedHost);
  if (!current || !expected) return false;
  if (current === expected) return true;
  if (current.endsWith('.' + expected) || expected.endsWith('.' + current)) return true;
  return registrableHost(current) === registrableHost(expected);
}

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

function registrableHost(host) {
  const labels = normalizeHost(host).split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  const multiPartSuffixes = new Set([
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.hk', 'com.tw',
    'co.uk', 'org.uk', 'com.au', 'net.au', 'co.jp', 'co.kr', 'com.sg'
  ]);
  return multiPartSuffixes.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

async function handleExtensionFetch(payload) {
  try {
    if (!payload.url) throw new Error('Missing request URL');
    const url = payload.url;
    const parsed = new URL(url);
    const kind = payload.kind || 'channel';
    if (kind === 'channel' && payload.browserFetch === true) {
      return handleBrowserFetch(payload, parsed);
    }
    const headers = sanitizeHeaders(payload.headers || {});
    if (kind === 'channel') {
      setDefaultHeader(headers, 'Accept', 'application/json, text/plain, */*');
      setDefaultHeader(headers, 'Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
    }
    const body = payload.bodyBase64 ? base64ToBytes(payload.bodyBase64) : (payload.body || undefined);
    const fetchOptions = {
      method: payload.method || 'GET',
      headers,
      body,
      cache: 'no-store'
    };
    if (kind === 'channel') fetchOptions.credentials = 'include';
    const startedAt = Date.now();
    const res = await fetch(url, fetchOptions);
    const responseHeaders = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    if (payload.streamTiming === true) {
      return collectStreamTimingResponse(res, responseHeaders, startedAt);
    }
    if (payload.responseType === 'base64') {
      const bytes = new Uint8Array(await res.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return { ok: res.ok, status: res.status, headers: responseHeaders, body: btoa(binary) };
    }
    return { ok: res.ok, status: res.status, headers: responseHeaders, body: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, error: err && err.message ? err.message : String(err) };
  }
}

async function handleBrowserFetch(payload, parsedUrl) {
  if (!chrome.scripting || !chrome.scripting.executeScript) throw new Error('当前浏览器不支持浏览器请求模式');
  if (payload.responseType === 'base64' || payload.bodyBase64) throw new Error('浏览器请求模式暂不支持二进制请求或响应');
  const expectedUrl = parseHttpUrl(payload.siteUrl || payload.url);
  if (!expectedUrl) throw new Error('浏览器请求模式缺少有效的渠道站点地址');
  if (!siteHostsMatch(parsedUrl.hostname, expectedUrl.hostname)) {
    throw new Error(`请求域名 ${parsedUrl.hostname} 与渠道站点 ${expectedUrl.hostname} 不匹配`);
  }
  const headers = sanitizeBrowserFetchHeaders(payload.headers || {});
  if (payload.kind === 'channel') {
    setDefaultHeader(headers, 'Accept', 'application/json, text/plain, */*');
    setDefaultHeader(headers, 'Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
  }
  let session = await findSiteTab(expectedUrl, '浏览器请求模式')
    .then(tab => ({ tab, created: false }))
    .catch(() => openLoginSessionTab(payload, expectedUrl, false));
  let response = await runBrowserFetchInTab(session.tab, payload, parsedUrl, headers);
  if (isCloudflareChallengeResponse(response)) {
    const retry = session.created
      ? { tab: await prepareLoginSessionTab(session.tab, payload, expectedUrl, false), created: true }
      : await openLoginSessionTab(payload, expectedUrl, false);
    response = await runBrowserFetchInTab(session.created ? retry.tab : session.tab, payload, parsedUrl, headers);
    if (isCloudflareChallengeResponse(response)) {
      await focusTab(retry.tab.id).catch(() => {});
      return browserSessionExpiredResponse(expectedUrl);
    }
    if (retry.created && !session.created) await chrome.tabs.remove(retry.tab.id).catch(() => {});
  }
  return response;
}

async function runBrowserFetchInTab(tab, payload, parsedUrl, headers) {
  const currentTab = tab && tab.id ? await chrome.tabs.get(tab.id).catch(() => tab) : tab;
  const currentUrl = parseHttpUrl(currentTab && currentTab.url);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id },
    func: browserFetchInPage,
    args: [{
      url: parsedUrl.href,
      method: payload.method || 'GET',
      headers: { ...(headers || {}) },
      body: payload.body || null,
      siteType: payload.siteType || '',
      streamTiming: payload.streamTiming === true
    }]
  });
  const response = result && result.result ? result.result : { ok: false, status: 0, error: '浏览器请求没有返回结果' };
  return { ...response, pageUrl: currentUrl ? currentUrl.href : '' };
}

async function openLoginSessionTab(payload, expectedUrl, active) {
  const tab = await chrome.tabs.create({ url: loginUrl(payload.siteUrl || expectedUrl.href, payload.siteType || ''), active: !!active });
  return { tab: await prepareLoginSessionTab(tab, payload, expectedUrl, active), created: true };
}

async function prepareLoginSessionTab(tab, payload, expectedUrl, active) {
  const tabId = typeof tab === 'number' ? tab : tab.id;
  const update = { url: loginUrl(payload.siteUrl || expectedUrl.href, payload.siteType || '') };
  if (active) update.active = true;
  let next = await chrome.tabs.update(tabId, update);
  await waitForTabComplete(tabId, 15000).catch(() => {});
  await injectAutofill(tabId, payload.username || '', payload.password || '').catch(() => {});
  await waitForCloudflareChallengeToSettle(tabId, 14000).catch(() => {});
  await injectAutofill(tabId, payload.username || '', payload.password || '').catch(() => {});
  next = await chrome.tabs.get(tabId).catch(() => next);
  return next;
}

async function waitForCloudflareChallengeToSettle(tabId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(600);
    try {
      const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: cloudflareChallengeActiveInPage });
      if (!result || result.result === false) return true;
    } catch (_) {}
  }
  return false;
}

function cloudflareChallengeActiveInPage() {
  if (document.readyState === 'loading') return true;
  const root = document.documentElement;
  const text = `${document.title || ''}\n${document.body ? document.body.innerText : ''}\n${root ? root.innerHTML.slice(0, 20000) : ''}`;
  return /(just a moment|verify you are human|verifying you are human|checking your browser|managed challenge|challenge-platform|cdn-cgi\/challenge-platform|__cf_chl|cf-browser-verification|cloudflare ray id)/i.test(text);
}

function isCloudflareChallengeResponse(response) {
  if (/BROWSER_SESSION_REVALIDATION_REQUIRED/i.test(String(response && response.error || ''))) return true;
  const headers = response && response.headers || {};
  const header = name => {
    const lower = String(name).toLowerCase();
    const key = Object.keys(headers).find(item => item.toLowerCase() === lower);
    return key ? String(headers[key] || '') : '';
  };
  if (header('cf-mitigated').toLowerCase().includes('challenge')) return true;
  const status = Number(response && response.status) || 0;
  const body = String(response && response.body || '');
  const lower = body.toLowerCase();
  const contentType = header('content-type').toLowerCase();
  const html = contentType.includes('text/html') || lower.includes('<html');
  return [403, 429, 503].includes(status) && html && /(just a moment|verify you are human|verifying you are human|checking your browser|managed challenge|challenge-platform|cdn-cgi\/challenge-platform|__cf_chl|cf-chl|cf-turnstile|cf-browser-verification|cloudflare ray id)/i.test(body);
}

function browserSessionExpiredResponse(expectedUrl) {
  return { ok: false, status: 0, headers: {}, body: '', error: `BROWSER_SESSION_REVALIDATION_REQUIRED: ${expectedUrl.hostname} 浏览器会话验证已过期，请在已打开的浏览器标签页完成验证后重试` };
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab && tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function collectStreamTimingResponse(res, responseHeaders, startedAt) {
  if (!res.body || !res.body.getReader) {
    const body = await res.text();
    return { ok: res.ok, status: res.status, headers: responseHeaders, body, streamTiming: { firstTokenMs: null, totalMs: Date.now() - startedAt, sample: streamSample(body) } };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let body = '', firstTokenMs = null, sample = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    body += chunk;
    if (firstTokenMs === null) {
      const firstSample = streamSample(body);
      if (firstSample) firstTokenMs = Date.now() - startedAt;
    }
  }
  body += decoder.decode();
  sample = streamSample(body);
  return { ok: res.ok, status: res.status, headers: responseHeaders, body, streamTiming: { firstTokenMs, totalMs: Date.now() - startedAt, sample } };
}

function streamSample(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const json = JSON.parse(data);
      (json.choices || []).forEach(choice => {
        const content = choice.delta?.content ?? choice.message?.content ?? choice.text ?? '';
        if (content) out.push(String(content));
      });
    } catch (_) {
      out.push(data);
    }
  });
  if (!out.length) {
    try {
      const json = JSON.parse(String(text || ''));
      (json.choices || []).forEach(choice => {
        const content = choice.message?.content ?? choice.delta?.content ?? choice.text ?? '';
        if (content) out.push(String(content));
      });
    } catch (_) {}
  }
  return out.join('').slice(0, 240);
}

async function browserFetchInPage(payload) {
  const setHeader = (headers, name, value) => {
    if (!value) return;
    const lower = name.toLowerCase();
    Object.keys(headers).forEach(key => {
      if (key.toLowerCase() === lower) delete headers[key];
    });
    headers[name] = String(value);
  };
  const collectPageAuth = async siteType => {
    const dump = store => {
      const out = {};
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        out[key] = store.getItem(key);
      }
      return out;
    };
    const safeJson = value => {
      try { return JSON.parse(value); } catch (_) { return value; }
    };
    const flatten = value => {
      const out = [];
      const walk = (path, item) => {
        if (item == null) return;
        if (typeof item === 'string') {
          out.push([path, item]);
          const parsed = safeJson(item);
          if (parsed !== item) walk(path, parsed);
        } else if (typeof item === 'number' || typeof item === 'boolean') {
          out.push([path, String(item)]);
        } else if (Array.isArray(item)) {
          item.forEach((child, index) => walk(`${path}.${index}`, child));
        } else if (typeof item === 'object') {
          Object.entries(item).forEach(([key, child]) => walk(path ? `${path}.${key}` : key, child));
        }
      };
      walk('', value);
      return out;
    };
    const normalize = value => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const useful = value => {
      const text = String(value || '').trim();
      return text && text !== 'null' && text !== 'undefined' && text !== '0';
    };
    const pick = (values, names) => {
      const wanted = names.map(normalize);
      for (const [key, value] of values) {
        const leaf = String(key || '').split('.').pop();
        if (wanted.includes(normalize(leaf)) && useful(value)) return String(value).trim();
      }
      for (const [key, value] of values) {
        const normalized = normalize(key);
        if (wanted.some(name => normalized.includes(name)) && useful(value)) return String(value).trim();
      }
      return '';
    };
    const pickJwt = values => {
      const hit = values.find(([, value]) => {
        const text = String(value || '').trim();
        return text.length > 24 && (text.match(/\./g) || []).length === 2 && /^[A-Za-z0-9._=-]+$/.test(text);
      });
      return hit ? String(hit[1]).trim() : '';
    };
    const findUserId = value => {
      if (value == null) return '';
      if (Array.isArray(value)) return value.map(findUserId).find(Boolean) || '';
      if (typeof value !== 'object') return '';
      for (const key of ['id', 'user_id', 'userId', 'uid']) {
        const item = value[key];
        if (typeof item === 'string' && item.trim()) return item.trim();
        if (typeof item === 'number') return String(item);
      }
      return Object.values(value).map(findUserId).find(Boolean) || '';
    };
    const storage = {
      localStorage: Object.fromEntries(Object.entries(dump(localStorage)).map(([key, value]) => [key, safeJson(value)])),
      sessionStorage: Object.fromEntries(Object.entries(dump(sessionStorage)).map(([key, value]) => [key, safeJson(value)])),
      documentCookie: document.cookie || ''
    };
    const values = flatten(storage);
    String(document.cookie || '').split(';').forEach(part => {
      const index = part.indexOf('=');
      if (index > 0) values.push([part.slice(0, index).trim(), part.slice(index + 1).trim()]);
    });
    const token = pick(values, ['auth_token', 'authToken', 'access_token', 'accessToken', 'bearerToken', 'jwt', 'token']) || pickJwt(values);
    const userId = pick(values, ['user_id', 'userId', 'uid', 'id']);
    return { token, userId };
  };

  try {
    const headers = { ...(payload.headers || {}) };
    const pageAuth = await collectPageAuth(payload.siteType || '');
    if (pageAuth.token) setHeader(headers, 'Authorization', /^Bearer\s+/i.test(pageAuth.token) ? pageAuth.token : 'Bearer ' + pageAuth.token);
    if (payload.siteType === 'newapi' && pageAuth.userId) setHeader(headers, 'New-Api-User', pageAuth.userId);
    const init = {
      method: payload.method || 'GET',
      headers,
      credentials: 'include',
      cache: 'no-store'
    };
    if (payload.body != null && !/^(GET|HEAD)$/i.test(init.method)) init.body = payload.body;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 25000) : null;
    if (controller) init.signal = controller.signal;
    let res;
    const startedAt = Date.now();
    try {
      res = await fetch(payload.url, init);
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('浏览器请求超时');
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const responseHeaders = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    if (payload.streamTiming === true) {
      const streamSample = text => {
        const out = [];
        String(text || '').split(/\r?\n/).forEach(line => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) return;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') return;
          try {
            const json = JSON.parse(data);
            (json.choices || []).forEach(choice => {
              const content = choice.delta?.content ?? choice.message?.content ?? choice.text ?? '';
              if (content) out.push(String(content));
            });
          } catch (_) {
            out.push(data);
          }
        });
        return out.join('').slice(0, 240);
      };
      if (!res.body || !res.body.getReader) {
        const body = await res.text();
        return { ok: res.ok, status: res.status, headers: responseHeaders, body, streamTiming: { firstTokenMs: null, totalMs: Date.now() - startedAt, sample: streamSample(body) } };
      }
      const reader = res.body.getReader(), decoder = new TextDecoder();
      let body = '', firstTokenMs = null, sample = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        body += chunk;
        if (firstTokenMs === null) {
          const firstSample = streamSample(body);
          if (firstSample) firstTokenMs = Date.now() - startedAt;
        }
      }
      body += decoder.decode();
      sample = streamSample(body);
      return { ok: res.ok, status: res.status, headers: responseHeaders, body, streamTiming: { firstTokenMs, totalMs: Date.now() - startedAt, sample } };
    }
    return { ok: res.ok, status: res.status, headers: responseHeaders, body: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, headers: {}, body: '', error: err && err.message ? err.message : String(err) };
  }
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers',
  'access-control-request-method', 'connection', 'content-length', 'cookie',
  'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
  'permissions-policy', 'referer', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'user-agent', 'via'
]);

function sanitizeHeaders(input) {
  return sanitizeHeadersWithForbidden(input, FORBIDDEN_REQUEST_HEADERS);
}

function sanitizeBrowserFetchHeaders(input) {
  const forbidden = new Set([...FORBIDDEN_REQUEST_HEADERS, 'cookie']);
  return sanitizeHeadersWithForbidden(input, forbidden);
}

function sanitizeHeadersWithForbidden(input, forbidden) {
  const out = {};
  Object.entries(input || {}).forEach(([key, value]) => {
    const name = String(key || '').trim();
    const lower = name.toLowerCase();
    if (!name || value == null) return;
    if (lower.startsWith('proxy-') || lower.startsWith('sec-') || forbidden.has(lower)) return;
    out[name] = String(value);
  });
  return out;
}

function setDefaultHeader(headers, name, value) {
  const lower = name.toLowerCase();
  if (!Object.keys(headers).some(key => key.toLowerCase() === lower)) headers[name] = value;
}
