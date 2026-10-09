const fs = require("fs");
const path = require("path");

function fillRect(buf, w, x0, y0, x1, y1, r, g, b, a) {
  for (let y = y0; y < y1; y++) {
    if (y < 0 || y >= w) continue;
    for (let x = x0; x < x1; x++) {
      if (x < 0 || x >= w) continue;
      const i = (y * w + x) * 4;
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = a;
    }
  }
}

function draw(size) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const s = size / 256;
  const px = (n) => Math.round(n * s);
  fillRect(buf, size, px(40), px(24), px(216), px(236), 59, 110, 165, 255);
  fillRect(buf, size, px(52), px(36), px(204), px(92), 217, 236, 255, 255);
  fillRect(buf, size, px(52), px(108), px(204), px(224), 244, 197, 66, 255);
  fillRect(buf, size, px(148), px(48), px(172), px(84), 43, 43, 43, 255);
  fillRect(buf, size, px(68), px(128), px(188), px(140), 255, 255, 255, 220);
  fillRect(buf, size, px(68), px(156), px(188), px(168), 255, 255, 255, 220);
  fillRect(buf, size, px(68), px(184), px(148), px(196), 255, 255, 255, 220);
  return buf;
}

function icoFromRgba(sizes) {
  const images = sizes.map((size) => {
    const rgba = draw(size);
    const xorRow = size * 4;
    const xorPad = xorRow;
    const andRow = Math.ceil(size / 32) * 4;
    const header = 40;
    const xor = Buffer.alloc(xorPad * size);
    for (let y = 0; y < size; y++) {
      const srcY = size - 1 - y;
      rgba.copy(xor, y * xorPad, srcY * xorRow, srcY * xorRow + xorRow);
    }
    const and = Buffer.alloc(andRow * size, 0);
    const dib = Buffer.alloc(header);
    dib.writeUInt32LE(header, 0);
    dib.writeInt32LE(size, 4);
    dib.writeInt32LE(size * 2, 8);
    dib.writeUInt16LE(1, 12);
    dib.writeUInt16LE(32, 14);
    const data = Buffer.concat([dib, xor, and]);
    return { size, data };
  });
  const count = images.length;
  const dir = Buffer.alloc(6 + 16 * count);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(count, 4);
  let offset = dir.length;
  const parts = [dir];
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    dir[e] = img.size >= 256 ? 0 : img.size;
    dir[e + 1] = img.size >= 256 ? 0 : img.size;
    dir[e + 2] = 0;
    dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(img.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
    parts.push(img.data);
  });
  return Buffer.concat(parts);
}

const outDir = path.join(__dirname, "..", "build");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "icon.ico"), icoFromRgba([16, 32, 48, 256]));
console.log("wrote build/icon.ico");
