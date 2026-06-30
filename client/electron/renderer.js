const frame = document.getElementById('app');

function sendToApp(message) {
  if (frame && frame.contentWindow) frame.contentWindow.postMessage(message, '*');
}

async function sendStore() {
  const data = await window.relayHub.getStore();
  sendToApp({ type: 'RELAY_STORE_DATA', data });
}

async function sendOpenMode() {
  const mode = await window.relayHub.getOpenMode();
  sendToApp({ type: 'RELAY_OPEN_MODE_DATA', mode });
}

function sendInitialData() {
  sendStore();
  sendOpenMode();
}

frame.addEventListener('load', sendInitialData);
setTimeout(sendInitialData, 0);

window.relayHub.onStoreData(data => {
  sendToApp({ type: 'RELAY_STORE_DATA', data });
});

window.relayHub.onOpenModeData(mode => {
  sendToApp({ type: 'RELAY_OPEN_MODE_DATA', mode });
});

window.addEventListener('message', async event => {
  const msg = event.data;
  if (msg && msg.type === 'RELAY_STORE_GET') {
    await sendStore();
    return;
  }
  if (msg && msg.type === 'RELAY_STORE_SET' && msg.key) {
    await window.relayHub.setStore(msg.key, msg.value ?? '');
    return;
  }
  if (msg && msg.type === 'RELAY_OPEN_MODE_GET') {
    await sendOpenMode();
    return;
  }
  if (msg && msg.type === 'RELAY_OPEN_MODE_SET') {
    const mode = await window.relayHub.setOpenMode(msg.mode);
    sendToApp({ type: 'RELAY_OPEN_MODE_DATA', mode });
    return;
  }
  if (msg && msg.type === 'RELAY_OPEN_SIDEPANEL') {
    const response = await window.relayHub.openSidePanel();
    sendToApp({ type: 'RELAY_OPEN_SIDEPANEL_RESULT', response });
    return;
  }
  if (msg && msg.type === 'RELAY_COPY_TEXT') {
    let result;
    try {
      result = await window.relayHub.copyText(String(msg.text || ''));
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    sendToApp({ type: 'RELAY_COPY_TEXT_RESULT', ok: !!result.ok, error: result.error || '' });
    return;
  }
  if (msg && msg.type === 'RELAY_OPEN_SITE_LOGIN') {
    let response;
    try {
      response = await window.relayHub.openSiteLogin(msg.payload || {});
    } catch (err) {
      response = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    sendToApp({ type: 'RELAY_OPEN_SITE_LOGIN_RESULT', response });
    return;
  }
  if (msg && msg.type === 'RELAY_READ_SITE_TOKENS') {
    let response;
    try {
      response = await window.relayHub.readSiteTokens(msg.siteUrl, msg.siteType);
    } catch (err) {
      response = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    sendToApp({ type: 'RELAY_READ_SITE_TOKENS_RESULT', response });
    return;
  }
  if (msg && msg.type === 'RELAY_OPEN_EXTERNAL') {
    await window.relayHub.openExternal(msg.url);
    return;
  }
  if (!msg || msg.type !== 'CPA_CHANNEL_FETCH' || !msg.id) return;
  let response;
  try {
    response = await window.relayHub.fetch(msg.payload || {});
    if (!response) response = { ok: false, status: 0, error: '客户端无响应' };
  } catch (err) {
    response = { ok: false, status: 0, error: err && err.message ? err.message : String(err) };
  }
  sendToApp({ type: 'CPA_CHANNEL_FETCH_RESULT', id: msg.id, response });
});
