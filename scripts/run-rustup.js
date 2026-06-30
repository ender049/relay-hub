const { spawnSync } = require('child_process');
const path = require('path');

const rootHome = process.env.HOME || process.env.USERPROFILE || '';
const pathSep = process.platform === 'win32' ? ';' : ':';
const cargoBin = path.join(rootHome, '.cargo', 'bin');
const env = { ...process.env, PATH: `${cargoBin}${pathSep}${process.env.PATH || ''}` };
const command = process.platform === 'win32' ? 'rustup.exe' : 'rustup';
const result = spawnSync(command, process.argv.slice(2), { env, stdio: 'inherit', shell: false });
process.exit(result.status == null ? 1 : result.status);
