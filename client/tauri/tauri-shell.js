const frame = document.getElementById('app');
const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;
const INITIAL_DATA_RETRY_DELAYS = [0, 60, 180, 400, 800, 1400, 2200];
let initialDataTimers = [];
const HOST_CAPABILITIES = {
  platform: 'tauri',
  nativeFetch: true,
  openSidePanel: false,
  siteLogin: true,
  siteTokenRead: true,
  browserFetch: true,
  browserFetchContext: 'tauri-webview',
  loginAutofill: true,
  loginTargetName: 'WebView2 登录窗口',
  tokenSourceName: 'WebView2 登录窗口'
};

function sendToApp(message) {
  if (frame && frame.contentWindow) frame.contentWindow.postMessage(message, '*');
}

async function sendStore() {
  const data = await invoke('relay_store_get');
  sendToApp({ type: 'RELAY_STORE_DATA', data });
}

async function sendOpenMode() {
  const mode = await invoke('relay_open_mode_get');
  sendToApp({ type: 'RELAY_OPEN_MODE_DATA', mode });
}

function sendCapabilities() {
  sendToApp({ type: 'RELAY_HOST_CAPABILITIES', capabilities: HOST_CAPABILITIES });
}

function sendInitialData() {
  sendStore();
  sendOpenMode();
  sendCapabilities();
}

function clearInitialDataTimers() {
  initialDataTimers.forEach(timer => clearTimeout(timer));
  initialDataTimers = [];
}

function scheduleInitialData() {
  clearInitialDataTimers();
  initialDataTimers = INITIAL_DATA_RETRY_DELAYS.map(delay => setTimeout(sendInitialData, delay));
}

frame.addEventListener('load', scheduleInitialData);
scheduleInitialData();

listen('relay-store-data', event => {
  sendToApp({ type: 'RELAY_STORE_DATA', data: event.payload || {} });
});

listen('relay-open-mode-data', event => {
  sendToApp({ type: 'RELAY_OPEN_MODE_DATA', mode: event.payload || 'popup' });
});

window.addEventListener('message', async event => {
  const msg = event.data;
  if (msg && msg.type === 'RELAY_STORE_GET') {
    await sendStore();
    return;
  }
  if (msg && msg.type === 'RELAY_STORE_SET' && msg.key) {
    await invoke('relay_store_set', { key: msg.key, value: msg.value ?? '' });
    return;
  }
  if (msg && msg.type === 'RELAY_OPEN_MODE_GET') {
    await sendOpenMode();
    return;
  }
  if (msg && msg.type === 'RELAY_HOST_CAPABILITIES_GET') {
    sendCapabilities();
    return;
  }
  if (msg && msg.type === 'RELAY_OPEN_MODE_SET') {
    const mode = await invoke('relay_open_mode_set', { mode: msg.mode });
    sendToApp({ type: 'RELAY_OPEN_MODE_DATA', mode });
    return;
  }
  if (msg && msg.type === 'RELAY_OPEN_SIDEPANEL') {
    const response = await invoke('relay_open_sidepanel');
    sendToApp({ type: 'RELAY_OPEN_SIDEPANEL_RESULT', response });
    return;
  }
  if (msg && msg.type === 'RELAY_COPY_TEXT') {
    let result;
    try {
      result = await invoke('relay_copy_text', { text: String(msg.text || '') });
    } catch (err) {
      result = { ok: false, error: String(err) };
    }
    sendToApp({ type: 'RELAY_COPY_TEXT_RESULT', ok: !!result.ok, error: result.error || '' });
    return;
  }
  if (msg && msg.type === 'RELAY_OPEN_SITE_LOGIN') {
    let response;
    try {
      response = await invoke('relay_open_site_login', { payload: msg.payload || {} });
    } catch (err) {
      response = { ok: false, error: String(err) };
    }
    sendToApp({ type: 'RELAY_OPEN_SITE_LOGIN_RESULT', response });
    return;
  }
  if (msg && msg.type === 'RELAY_READ_SITE_TOKENS') {
    let response;
    try {
      response = await invoke('relay_read_site_tokens', { siteUrl: msg.siteUrl, siteType: msg.siteType || '' });
    } catch (err) {
      response = { ok: false, error: String(err) };
    }
    sendToApp({ type: 'RELAY_READ_SITE_TOKENS_RESULT', response });
    return;
  }
  if (msg && msg.type === 'RELAY_OPEN_EXTERNAL') {
    await invoke('relay_open_external', { url: msg.url || '' });
    return;
  }
  if (!msg || msg.type !== 'CPA_CHANNEL_FETCH' || !msg.id) return;
  let response;
  try {
    response = await invoke('relay_fetch', { payload: msg.payload || {} });
    if (!response) response = { ok: false, status: 0, error: '客户端无响应' };
  } catch (err) {
    response = { ok: false, status: 0, error: String(err) };
  }
  sendToApp({ type: 'CPA_CHANNEL_FETCH_RESULT', id: msg.id, response });
});
