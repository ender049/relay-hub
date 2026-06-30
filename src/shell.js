const frame = document.getElementById('app');
const shellSideBtn = document.getElementById('shellSideBtn');

const STORE_KEYS = ['apm_s', 'apm_ch', 'apm_tab', 'apm_font', 'relay_theme', 'apm_ar'];
const OPEN_MODE_KEY = 'relay_open_mode';

function readStore() {
  const data = {};
  for (const key of STORE_KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) data[key] = value;
  }
  return data;
}

function sendStore() {
  frame.contentWindow.postMessage({ type: 'RELAY_STORE_DATA', data: readStore() }, '*');
}

function normalizeOpenMode(value) {
  return value === 'sidepanel' ? 'sidepanel' : 'popup';
}

async function readOpenMode() {
  try {
    const data = await chrome.storage.local.get(OPEN_MODE_KEY);
    return normalizeOpenMode(data[OPEN_MODE_KEY]);
  } catch {
    return normalizeOpenMode(localStorage.getItem(OPEN_MODE_KEY));
  }
}

async function writeOpenMode(value) {
  const mode = normalizeOpenMode(value);
  localStorage.setItem(OPEN_MODE_KEY, mode);
  await chrome.storage.local.set({ [OPEN_MODE_KEY]: mode });
  return mode;
}

async function sendOpenMode() {
  const mode = await readOpenMode();
  frame.contentWindow.postMessage({ type: 'RELAY_OPEN_MODE_DATA', mode }, '*');
}

function sendInitialData() {
  sendStore();
  sendOpenMode();
}

frame.addEventListener('load', sendInitialData);
setTimeout(sendInitialData, 0);

async function openSidePanelFromShell() {
  if (!chrome.sidePanel || !chrome.sidePanel.open) throw new Error('当前浏览器不支持侧边栏');
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0] || !tabs[0].id) throw new Error('未找到当前标签页');
  await chrome.sidePanel.open({ tabId: tabs[0].id });
}

if (shellSideBtn) {
  shellSideBtn.addEventListener('click', async () => {
    let response = { ok: true };
    try {
      await openSidePanelFromShell();
    } catch (err) {
      response = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    frame.contentWindow.postMessage({ type: 'RELAY_OPEN_SIDEPANEL_RESULT', response }, '*');
  });
}

window.addEventListener('message', async event => {
  const msg = event.data;
  if (msg && msg.type === 'RELAY_STORE_GET') {
    sendStore();
    return;
  }
  if (msg && msg.type === 'RELAY_STORE_SET' && msg.key) {
    localStorage.setItem(msg.key, msg.value ?? '');
    return;
  }
  if (msg && msg.type === 'RELAY_OPEN_MODE_GET') {
    await sendOpenMode();
    return;
  }
  if (msg && msg.type === 'RELAY_OPEN_MODE_SET') {
    const mode = await writeOpenMode(msg.mode);
    frame.contentWindow.postMessage({ type: 'RELAY_OPEN_MODE_DATA', mode }, '*');
    return;
  }
  if (msg && msg.type === 'RELAY_OPEN_SIDEPANEL') {
    let response = { ok: true };
    try {
      await openSidePanelFromShell();
    } catch (err) {
      response = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    frame.contentWindow.postMessage({ type: 'RELAY_OPEN_SIDEPANEL_RESULT', response }, '*');
    return;
  }
  if (msg && msg.type === 'RELAY_COPY_TEXT') {
    let ok = true;
    let error = '';
    try {
      await navigator.clipboard.writeText(String(msg.text || ''));
    } catch (err) {
      ok = false;
      error = err && err.message ? err.message : String(err);
    }
    frame.contentWindow.postMessage({ type: 'RELAY_COPY_TEXT_RESULT', ok, error }, '*');
    return;
  }
  if (msg && msg.type === 'RELAY_OPEN_EXTERNAL') {
    window.open(String(msg.url || ''), '_blank', 'noopener,noreferrer');
    return;
  }
  if (msg && msg.type === 'RELAY_READ_SITE_TOKENS') {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'RELAY_READ_SITE_TOKENS', siteUrl: msg.siteUrl });
      if (!response) response = { ok: false, error: '扩展后台无响应' };
    } catch (err) {
      response = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    frame.contentWindow.postMessage({ type: 'RELAY_READ_SITE_TOKENS_RESULT', response }, '*');
    return;
  }
  if (!msg || msg.type !== 'CPA_CHANNEL_FETCH' || !msg.id) return;
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: 'CPA_CHANNEL_FETCH',
      payload: msg.payload
    });
    if (!response) response = { ok: false, status: 0, error: '扩展后台无响应' };
  } catch (err) {
    response = { ok: false, status: 0, error: err && err.message ? err.message : String(err) };
  }
  frame.contentWindow.postMessage({
    type: 'CPA_CHANNEL_FETCH_RESULT',
    id: msg.id,
    response
  }, '*');
});

window.addEventListener('storage', event => {
  if (STORE_KEYS.includes(event.key)) sendStore();
  if (event.key === OPEN_MODE_KEY) sendOpenMode();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[OPEN_MODE_KEY]) sendOpenMode();
});
