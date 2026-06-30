const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const isWin = process.platform === 'win32';

const artifacts = [
  [path.join(ROOT, 'release', 'relay-hub-extension.zip'), 'relay-hub-extension.zip'],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'relay-hub'), 'relay-hub-tauri-linux-x86_64'],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'relay-hub.exe'), 'relay-hub-tauri-windows-x86_64.exe'],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release', 'relay-hub.exe'), 'relay-hub-tauri-windows-x86_64-single.exe'],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'x86_64-pc-windows-gnu', 'release', 'relay-hub.exe'), 'relay-hub-tauri-windows-x86_64.exe'],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'bundle', 'deb', 'Relay Hub_0.1.0_amd64.deb'), 'relay-hub-tauri_0.1.0_amd64.deb'],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'bundle', 'rpm', 'Relay Hub-0.1.0-1.x86_64.rpm'), 'relay-hub-tauri-0.1.0-1.x86_64.rpm'],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'bundle', 'msi', 'Relay Hub_0.1.0_x64_en-US.msi'), 'relay-hub-tauri_0.1.0_x64.msi'],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'bundle', 'nsis', 'Relay Hub_0.1.0_x64-setup.exe'), 'relay-hub-tauri_0.1.0_x64-setup.exe'],
  [path.join(ROOT, 'client', 'tauri', 'src-tauri', 'target', 'release', 'bundle', 'dmg', 'Relay Hub_0.1.0_x64.dmg'), 'relay-hub-tauri_0.1.0_x64.dmg'],
];

function copyArtifact(src, name, copied) {
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return;
  const dst = path.join(RELEASE_DIR, name);
  if (path.resolve(src) !== path.resolve(dst)) fs.copyFileSync(src, dst);
  if (!isWin) fs.chmodSync(dst, fs.statSync(src).mode);
  const relative = path.relative(ROOT, dst);
  if (!copied.has(relative)) {
    copied.add(relative);
    console.log(relative);
  }
}

fs.mkdirSync(RELEASE_DIR, { recursive: true });
const copied = new Set();
for (const [src, name] of artifacts) copyArtifact(src, name, copied);
