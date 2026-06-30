const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const fs = require('fs/promises');
const path = require('path');

const STORE_KEYS = ['apm_s', 'apm_ch', 'apm_tab', 'apm_font', 'relay_theme', 'apm_ar'];
const OPEN_MODE_KEY = 'relay_open_mode';
const STORE_FILE = 'store.json';

let mainWindow = null;
let storeCache = null;

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    title: 'Relay Hub',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

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

function setDefaultHeader(headers, name, value) {
  const lower = name.toLowerCase();
  if (!Object.keys(headers).some(key => key.toLowerCase() === lower)) headers[name] = value;
}

function base64ToBytes(value) {
  const binary = Buffer.from(String(value || ''), 'base64');
  return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
}

async function handleDesktopFetch(payload = {}) {
  try {
    if (!payload.url) throw new Error('Missing request URL');
    const parsed = new URL(payload.url);
    const kind = payload.kind || 'channel';
    const headers = sanitizeHeaders(payload.headers || {});
    if (kind === 'channel') {
      setDefaultHeader(headers, 'Accept', 'application/json, text/plain, */*');
      setDefaultHeader(headers, 'Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
    }
    const body = payload.bodyBase64 ? base64ToBytes(payload.bodyBase64) : (payload.body || undefined);
    const res = await fetch(parsed.href, {
      method: payload.method || 'GET',
      headers,
      body,
      cache: 'no-store'
    });
    const responseHeaders = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    if (payload.responseType === 'base64') {
      const bytes = Buffer.from(await res.arrayBuffer());
      return { ok: res.ok, status: res.status, headers: responseHeaders, body: bytes.toString('base64') };
    }
    return { ok: res.ok, status: res.status, headers: responseHeaders, body: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, error: err && err.message ? err.message : String(err) };
  }
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
  ipcMain.handle('relay-open-site-login', (_event, payload) => openSiteLogin(payload));
  ipcMain.handle('relay-read-site-tokens', (_event, siteUrl, siteType) => readSiteTokens(siteUrl, siteType));
  ipcMain.handle('relay-open-external', (_event, url) => shell.openExternal(String(url || '')));
}

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
