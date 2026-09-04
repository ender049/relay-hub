const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const isWin = process.platform === 'win32';

const EXTENSION_INPUTS = [
  'manifest.json',
  'src/background.js',
  'pages/popup.html',
  'pages/sidepanel.html',
  'src/shell.js',
  'pages/index.html',
  'src/host.js',
  'src/auth-session.js',
  'src/channel-monitor.js',
  'src/app.js',
  'assets/relayhub.png',
];

const TAURI_INPUTS = [
  'src',
  'pages',
  'assets',
  'client/tauri/index.html',
  'client/tauri/login-loading.html',
  'client/tauri/tauri-shell.js',
  'client/tauri/src-tauri/src',
  'client/tauri/src-tauri/Cargo.toml',
  'client/tauri/src-tauri/Cargo.lock',
  'client/tauri/src-tauri/tauri.conf.json',
  'client/tauri/src-tauri/build.rs',
];

function maxMtimeMs(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const stat = fs.statSync(filePath);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let max = stat.mtimeMs;
  for (const entry of fs.readdirSync(filePath)) {
    max = Math.max(max, maxMtimeMs(path.join(filePath, entry)));
  }
  return max;
}

function inputMtimeMs(inputs) {
  return inputs.reduce((max, input) => Math.max(max, maxMtimeMs(path.join(ROOT, input))), 0);
}

const extensionInputMtime = inputMtimeMs(EXTENSION_INPUTS);
const tauriInputMtime = inputMtimeMs(TAURI_INPUTS);

const artifacts = [
  [path.join(ROOT, 'release', 'relay-hub-extension.zip'), 'relay-hub-extension.zip', extensionInputMtime],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'relay-hub'), 'relay-hub-tauri-linux-x86_64', tauriInputMtime],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'relay-hub.exe'), 'relay-hub-tauri-windows-x86_64.exe', tauriInputMtime],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release', 'relay-hub.exe'), 'relay-hub-tauri-windows-x86_64-single.exe', tauriInputMtime],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'x86_64-pc-windows-gnu', 'release', 'relay-hub.exe'), 'relay-hub-tauri-windows-x86_64.exe', tauriInputMtime],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'bundle', 'deb', 'Relay Hub_0.1.0_amd64.deb'), 'relay-hub-tauri_0.1.0_amd64.deb', tauriInputMtime],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'bundle', 'rpm', 'Relay Hub-0.1.0-1.x86_64.rpm'), 'relay-hub-tauri-0.1.0-1.x86_64.rpm', tauriInputMtime],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'bundle', 'appimage', 'Relay Hub_0.1.0_amd64.AppImage'), 'relay-hub-tauri_0.1.0_amd64.AppImage', tauriInputMtime],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'bundle', 'msi', 'Relay Hub_0.1.0_x64_en-US.msi'), 'relay-hub-tauri_0.1.0_x64.msi', tauriInputMtime],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'bundle', 'nsis', 'Relay Hub_0.1.0_x64-setup.exe'), 'relay-hub-tauri_0.1.0_x64-setup.exe', tauriInputMtime],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'bundle', 'dmg', 'Relay Hub_0.1.0_x64.dmg'), 'relay-hub-tauri_0.1.0_x64.dmg', tauriInputMtime],
];

function removeStaleDestination(name) {
  const dst = path.join(RELEASE_DIR, name);
  if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
}

function copyArtifact(src, name, minMtime, copied) {
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    removeStaleDestination(name);
    return;
  }
  const srcStat = fs.statSync(src);
  if (srcStat.mtimeMs + 1000 < minMtime) {
    removeStaleDestination(name);
    console.warn(`skip stale artifact: ${path.relative(ROOT, src)}`);
    return;
  }
  const dst = path.join(RELEASE_DIR, name);
  if (path.resolve(src) !== path.resolve(dst)) fs.copyFileSync(src, dst);
  if (!isWin) fs.chmodSync(dst, srcStat.mode);
  const relative = path.relative(ROOT, dst);
  if (!copied.has(relative)) {
    copied.add(relative);
    console.log(relative);
  }
}

fs.mkdirSync(RELEASE_DIR, { recursive: true });
const copied = new Set();
for (const [src, name, minMtime] of artifacts) copyArtifact(src, name, minMtime, copied);
