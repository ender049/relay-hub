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
  if (msg.type === 'RELAY_READ_SITE_TOKENS') {
    readSiteTokens(msg.siteUrl).then(sendResponse);
    return true;
  }
  return false;
});

async function readSiteTokens(siteUrl) {
  try {
    if (!chrome.scripting || !chrome.scripting.executeScript) throw new Error('当前浏览器不支持读取页面令牌');
    const expectedUrl = parseHttpUrl(siteUrl);
    if (!expectedUrl) throw new Error('请先填写 Sub2API 站点地址');
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.id || !tab.url) throw new Error('请先切换到已登录的 Sub2API 站点标签页');
    const currentUrl = parseHttpUrl(tab.url);
    if (!currentUrl) throw new Error('请先切换到已登录的 Sub2API 站点标签页');
    if (!siteHostsMatch(currentUrl.hostname, expectedUrl.hostname)) {
      throw new Error(`当前标签页域名 ${currentUrl.hostname} 与渠道站点 ${expectedUrl.hostname} 不匹配`);
    }
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        auth_token: localStorage.getItem('auth_token') || '',
        access_token: localStorage.getItem('access_token') || '',
        refresh_token: localStorage.getItem('refresh_token') || '',
        token_expires_at: localStorage.getItem('token_expires_at') || ''
      })
    });
    return { ok: true, siteUrl: expectedUrl.href, pageUrl: currentUrl.href, ...(result && result.result ? result.result : {}) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
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
    const res = await fetch(url, fetchOptions);
    console.info('[Relay Hub fetch]', kind, payload.method || 'GET', parsed.href, res.status);
    const responseHeaders = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
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
    console.warn('[Relay Hub fetch failed]', payload && payload.url, err);
    return { ok: false, status: 0, error: err && err.message ? err.message : String(err) };
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
  const out = {};
  Object.entries(input || {}).forEach(([key, value]) => {
    const name = String(key || '').trim();
    const lower = name.toLowerCase();
    if (!name || value == null) return;
    if (lower.startsWith('proxy-') || lower.startsWith('sec-') || FORBIDDEN_REQUEST_HEADERS.has(lower)) return;
    out[name] = String(value);
  });
  return out;
}

function setDefaultHeader(headers, name, value) {
  const lower = name.toLowerCase();
  if (!Object.keys(headers).some(key => key.toLowerCase() === lower)) headers[name] = value;
}
