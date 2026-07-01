const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'tauri-ui');
const ICON_DIR = path.join(ROOT, 'client', 'tauri', 'src-tauri', 'icons');
const PRODUCT_ICON = path.join(ROOT, 'assets', 'relayhub.png');

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyTree(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(file) {
  const data = fs.readFileSync(file);
  if (!data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error(`${file} is not a PNG`);
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      if (chunk[12] !== 0) throw new Error('Interlaced PNG is not supported for Tauri icon generation');
    } else if (type === 'PLTE') {
      palette = [];
      for (let index = 0; index < chunk.length; index += 3) palette.push([chunk[index], chunk[index + 1], chunk[index + 2], 255]);
    } else if (type === 'tRNS') {
      transparency = chunk;
    } else if (type === 'IDAT') {
      idat.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : 0;
  if (!channels) throw new Error(`Unsupported PNG color type: ${colorType}`);
  const stride = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const raw = Buffer.alloc(height * stride);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[src++];
    const row = raw.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= channels ? prev[x - channels] : 0;
      const value = inflated[src++];
      if (filter === 0) row[x] = value;
      else if (filter === 1) row[x] = (value + left) & 255;
      else if (filter === 2) row[x] = (value + up) & 255;
      else if (filter === 3) row[x] = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[x] = (value + paeth(left, up, upLeft)) & 255;
      else throw new Error(`Unsupported PNG filter: ${filter}`);
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (colorType === 6) {
      raw.copy(rgba, pixel * 4, pixel * 4, pixel * 4 + 4);
    } else if (colorType === 2) {
      rgba[pixel * 4] = raw[pixel * 3];
      rgba[pixel * 4 + 1] = raw[pixel * 3 + 1];
      rgba[pixel * 4 + 2] = raw[pixel * 3 + 2];
      rgba[pixel * 4 + 3] = 255;
    } else {
      const color = palette?.[raw[pixel]] || [0, 0, 0, 255];
      rgba[pixel * 4] = color[0];
      rgba[pixel * 4 + 1] = color[1];
      rgba[pixel * 4 + 2] = color[2];
      rgba[pixel * 4 + 3] = transparency?.[raw[pixel]] ?? color[3];
    }
  }
  return { width, height, rgba };
}

function resizeNearest(image, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sy = Math.min(image.height - 1, Math.floor(y * image.height / size));
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(image.width - 1, Math.floor(x * image.width / size));
      image.rgba.copy(out, (y * size + x) * 4, (sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4);
    }
  }
  return { width: size, height: size, rgba: out };
}

function encodeRgbaPng(image) {
  const rows = [];
  for (let y = 0; y < image.height; y += 1) {
    rows.push(Buffer.from([0]));
    rows.push(image.rgba.subarray(y * image.width * 4, (y + 1) * image.width * 4));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createIco(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 0;
  header[7] = 0;
  header[8] = 0;
  header[9] = 0;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

function ensureWindowsIcon() {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  const image = resizeNearest(decodePng(PRODUCT_ICON), 256);
  const png = encodeRgbaPng(image);
  fs.writeFileSync(path.join(ICON_DIR, 'icon.png'), png);
  fs.writeFileSync(path.join(ICON_DIR, 'icon.ico'), createIco(png));
}

ensureWindowsIcon();
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
copyFile(path.join(ROOT, 'client', 'tauri', 'index.html'), path.join(OUT, 'index.html'));
copyFile(path.join(ROOT, 'client', 'tauri', 'login-loading.html'), path.join(OUT, 'login-loading.html'));
copyFile(path.join(ROOT, 'client', 'tauri', 'tauri-shell.js'), path.join(OUT, 'tauri-shell.js'));
copyTree(path.join(ROOT, 'pages'), path.join(OUT, 'pages'));
copyTree(path.join(ROOT, 'src'), path.join(OUT, 'src'));
copyTree(path.join(ROOT, 'assets'), path.join(OUT, 'assets'));
console.log(path.relative(ROOT, OUT));
