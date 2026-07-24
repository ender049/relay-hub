const { app, BrowserWindow, ipcMain, shell, clipboard, screen } = require('electron');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');

const STORE_KEYS = ['apm_s', 'apm_ch', 'apm_acct', 'apm_tab', 'apm_font', 'relay_theme', 'apm_ar'];
const OPEN_MODE_KEY = 'relay_open_mode';
const WINDOW_STATE_KEY = 'relay_window_state';
const STORE_FILE = 'store.json';
const DEFAULT_WINDOW_BOUNDS = { width: 1120, height: 780 };
const MIN_WINDOW_WIDTH = 720;
const MIN_WINDOW_HEIGHT = 520;
const MAX_WINDOW_DIMENSION = 10000;
const MIN_VISIBLE_SIZE = 80;

let mainWindow = null;
let storeCache = null;
let windowStateSaveTimer = null;
const pendingFetchControllers = new Map();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('before-quit', () => saveWindowStateSync());

function storePath() {
  return path.join(app.getPath('userData'), STORE_FILE);
}

async function readStoreFile() {
  if (storeCache) return storeCache;
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw);
    storeCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    storeCache = {};
  }
  return storeCache;
}

async function writeStoreFile(next) {
  storeCache = next && typeof next === 'object' ? next : {};
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(storeCache, null, 2));
}

function writeStoreFileSync(next) {
  storeCache = next && typeof next === 'object' ? next : {};
  fsSync.mkdirSync(path.dirname(storePath()), { recursive: true });
  fsSync.writeFileSync(storePath(), JSON.stringify(storeCache, null, 2));
}

async function readAppStore() {
  const raw = await readStoreFile();
  const data = {};
  for (const key of STORE_KEYS) {
    if (raw[key] != null) data[key] = String(raw[key]);
  }
  return data;
}

async function setAppStoreValue(key, value) {
  if (!STORE_KEYS.includes(key)) return;
  const raw = await readStoreFile();
  raw[key] = String(value ?? '');
  await writeStoreFile(raw);
  sendStoreToWindow();
}

async function readOpenMode() {
  const raw = await readStoreFile();
  return raw[OPEN_MODE_KEY] === 'sidepanel' ? 'sidepanel' : 'popup';
}

async function writeOpenMode(mode) {
  const raw = await readStoreFile();
  raw[OPEN_MODE_KEY] = mode === 'sidepanel' ? 'sidepanel' : 'popup';
  await writeStoreFile(raw);
  return raw[OPEN_MODE_KEY];
}

async function sendStoreToWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('relay-store-data', await readAppStore());
}

async function sendOpenModeToWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('relay-open-mode-data', await readOpenMode());
}

function normalizedDimension(value, fallback, min) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_WINDOW_DIMENSION, Math.max(min, number));
}

function normalizedCoordinate(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? number : null;
}

function getOverlapSize(startA, sizeA, startB, sizeB) {
  return Math.max(0, Math.min(startA + sizeA, startB + sizeB) - Math.max(startA, startB));
}

function hasVisibleWindowArea(bounds) {
  const minVisible = Math.min(MIN_VISIBLE_SIZE, bounds.width, bounds.height);
  return screen.getAllDisplays().some(display => {
    const area = display.workArea;
    const xOverlap = getOverlapSize(bounds.x, bounds.width, area.x, area.width);
    const yOverlap = getOverlapSize(bounds.y, bounds.height, area.y, area.height);
    return xOverlap >= minVisible && yOverlap >= minVisible;
  });
}

function readWindowState() {
  const state = storeCache && typeof storeCache[WINDOW_STATE_KEY] === 'object' ? storeCache[WINDOW_STATE_KEY] : {};
  const bounds = {
    width: normalizedDimension(state.width, DEFAULT_WINDOW_BOUNDS.width, MIN_WINDOW_WIDTH),
    height: normalizedDimension(state.height, DEFAULT_WINDOW_BOUNDS.height, MIN_WINDOW_HEIGHT)
  };
  const x = normalizedCoordinate(state.x);
  const y = normalizedCoordinate(state.y);
  if (x !== null && y !== null && hasVisibleWindowArea({ ...bounds, x, y })) {
    bounds.x = x;
    bounds.y = y;
  }
  return { bounds, maximized: state.maximized === true };
}

function collectWindowState(window) {
  if (!window || window.isDestroyed() || window.isMinimized()) return null;
  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: normalizedDimension(bounds.width, DEFAULT_WINDOW_BOUNDS.width, MIN_WINDOW_WIDTH),
    height: normalizedDimension(bounds.height, DEFAULT_WINDOW_BOUNDS.height, MIN_WINDOW_HEIGHT),
    maximized: window.isMaximized()
  };
}

async function saveWindowState(window = mainWindow) {
  const state = collectWindowState(window);
  if (!state) return;
  const raw = await readStoreFile();
  raw[WINDOW_STATE_KEY] = state;
  await writeStoreFile(raw);
}

function saveWindowStateSync(window = mainWindow) {
  const state = collectWindowState(window);
  if (!state) return;
  const raw = storeCache && typeof storeCache === 'object' ? storeCache : {};
  raw[WINDOW_STATE_KEY] = state;
  writeStoreFileSync(raw);
}

function scheduleWindowStateSave(window = mainWindow) {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    saveWindowState(window).catch(() => {});
  }, 300);
}

function watchWindowState(window) {
  const scheduleSave = () => scheduleWindowStateSave(window);
  window.on('resize', scheduleSave);
  window.on('move', scheduleSave);
  window.on('maximize', scheduleSave);
  window.on('unmaximize', scheduleSave);
  window.on('close', () => saveWindowStateSync(window));
}

function createWindow() {
  const savedWindowState = readWindowState();
  mainWindow = new BrowserWindow({
    ...savedWindowState.bounds,
    minWidth: 720,
    minHeight: 520,
    title: 'Relay Hub',
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (savedWindowState.maximized) mainWindow.maximize();
  watchWindowState(mainWindow);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function sanitizeHeaders(input) {
  const out = {};
  const forbidden = new Set([
    'accept-charset', 'accept-encoding', 'access-control-request-headers',
    'access-control-request-method', 'connection', 'content-length', 'cookie',
    'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
    'permissions-policy', 'referer', 'te', 'trailer', 'transfer-encoding',
    'upgrade', 'user-agent', 'via'
  ]);
  Object.entries(input || {}).forEach(([key, value]) => {
    const name = String(key || '').trim();
    const lower = name.toLowerCase();
    if (!name || value == null) return;
    if (lower.startsWith('proxy-') || lower.startsWith('sec-') || forbidden.has(lower)) return;
    out[name] = String(value);
  });
  return out;
}

function headerValue(headers, name) {
  const lower = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === lower) return String(value || '');
  }
  return '';
}

function sanitizeAccountHeaders(input, parsedUrl) {
  const headers = sanitizeHeaders(input);
  if (parsedUrl && parsedUrl.protocol === 'https:' && parsedUrl.hostname === 'opencode.ai') {
    const cookie = headerValue(input, 'Cookie');
    if (cookie && /(^|;\s*)auth=/.test(cookie)) headers.Cookie = cookie;
  }
  return headers;
}

function setDefaultHeader(headers, name, value) {
  const lower = name.toLowerCase();
  if (!Object.keys(headers).some(key => key.toLowerCase() === lower)) headers[name] = value;
}

function base64ToBytes(value) {
  const binary = Buffer.from(String(value || ''), 'base64');
  return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
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

async function handleDesktopFetch(payload = {}) {
  const requestId = String(payload.requestId || '');
  const controller = typeof AbortController !== 'undefined' && requestId ? new AbortController() : null;
  if (controller) pendingFetchControllers.set(requestId, controller);
  try {
    if (!payload.url) throw new Error('Missing request URL');
    const parsed = new URL(payload.url);
    const kind = payload.kind || 'channel';
    if (kind === 'channel' && payload.browserFetch === true) {
      throw new Error('Electron 客户端暂未接入浏览器请求模式，请使用浏览器扩展或 Tauri 客户端。');
    }
    const headers = kind === 'account' ? sanitizeAccountHeaders(payload.headers || {}, parsed) : sanitizeHeaders(payload.headers || {});
    if (kind === 'channel') {
      setDefaultHeader(headers, 'Accept', 'application/json, text/plain, */*');
      setDefaultHeader(headers, 'Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
    }
    const body = payload.bodyBase64 ? base64ToBytes(payload.bodyBase64) : (payload.body || undefined);
    const startedAt = Date.now();
    const res = await fetch(parsed.href, {
      method: payload.method || 'GET',
      headers,
      body,
      cache: 'no-store',
      ...(controller ? { signal: controller.signal } : {})
    });
    const responseHeaders = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    if (payload.streamTiming === true) {
      return collectStreamTimingResponse(res, responseHeaders, startedAt);
    }
    if (payload.responseType === 'base64') {
      const bytes = Buffer.from(await res.arrayBuffer());
      return { ok: res.ok, status: res.status, headers: responseHeaders, body: bytes.toString('base64') };
    }
    return { ok: res.ok, status: res.status, headers: responseHeaders, body: await res.text() };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, status: 0, error: '请求已取消' };
    return { ok: false, status: 0, error: err && err.message ? err.message : String(err) };
  } finally {
    if (requestId) pendingFetchControllers.delete(requestId);
  }
}

function cancelDesktopFetch(id) {
  const controller = pendingFetchControllers.get(String(id || ''));
  if (controller) controller.abort();
}

async function openSiteLogin() {
  return {
    ok: false,
    error: 'Electron 客户端暂未接入登录接管，请使用 Tauri 客户端。'
  };
}

async function readSiteTokens() {
  return {
    ok: false,
    error: 'Electron 客户端暂未接入登录接管，请使用 Tauri 客户端。'
  };
}

function registerIpc() {
  ipcMain.handle('relay-store-get', readAppStore);
  ipcMain.handle('relay-store-set', (_event, key, value) => setAppStoreValue(key, value));
  ipcMain.handle('relay-open-mode-get', readOpenMode);
  ipcMain.handle('relay-open-mode-set', async (_event, mode) => {
    const next = await writeOpenMode(mode);
    sendOpenModeToWindow();
    return next;
  });
  ipcMain.handle('relay-open-sidepanel', () => ({ ok: false, error: '客户端版使用单窗口布局' }));
  ipcMain.handle('relay-copy-text', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });
  ipcMain.handle('relay-fetch', (_event, payload) => handleDesktopFetch(payload));
  ipcMain.handle('relay-fetch-cancel', (_event, id) => cancelDesktopFetch(id));
  ipcMain.handle('relay-open-site-login', (_event, payload) => openSiteLogin(payload));
  ipcMain.handle('relay-read-site-tokens', (_event, siteUrl, siteType) => readSiteTokens(siteUrl, siteType));
  ipcMain.handle('relay-open-external', (_event, url) => shell.openExternal(String(url || '')));
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    await readStoreFile();
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
