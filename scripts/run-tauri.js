const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const tauriArgs = args.length ? args : ['build'];
const root = path.resolve(__dirname, '..');
const cwd = path.join(root, 'client', 'tauri');
const pathSep = process.platform === 'win32' ? ';' : ':';
const cargoBin = path.join(process.env.HOME || process.env.USERPROFILE || '', '.cargo', 'bin');
const env = { ...process.env, PATH: `${cargoBin}${pathSep}${process.env.PATH || ''}` };

const command = process.platform === 'win32' ? 'tauri.cmd' : 'tauri';
const result = spawnSync(command, tauriArgs, { cwd, env, stdio: 'inherit', shell: false });
process.exit(result.status == null ? 1 : result.status);
