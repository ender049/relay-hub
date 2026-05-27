chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type !== 'CPA_CHANNEL_FETCH') return false;
  handleExtensionFetch(msg.payload || {}).then(sendResponse);
  return true;
});

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
