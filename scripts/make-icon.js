'use strict';

/**
 * Generates build/icon.png (1024×1024 RGBA) with no external image tooling.
 * electron-builder converts this single high-res PNG into the platform icon
 * formats (.icns for macOS, .ico for Windows) during the packaged build on the
 * respective runner, so one source PNG is all we need to maintain.
 *
 * The artwork mirrors renderer/assets/icon.svg: a dark panel, a blue query
 * "diamond" inside a cloud outline, and two result bars.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

const BG_TOP = [22, 32, 58]; // #16203a
const BG_BOT = [15, 23, 41]; // #0f1729
const BLUE_HI = [111, 179, 255]; // #6fb3ff
const BLUE_LO = [43, 108, 255]; // #2b6cff
const BAR1 = [61, 74, 104]; // #3d4a68
const BAR2 = [44, 61, 95]; // #2c3d5f

const buf = Buffer.alloc(SIZE * SIZE * 4);

function setPx(x, y, rgb, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const bg = [buf[i], buf[i + 1], buf[i + 2]];
  const af = a / 255;
  buf[i] = lerp(bg[0], rgb[0], af);
  buf[i + 1] = lerp(bg[1], rgb[1], af);
  buf[i + 2] = lerp(bg[2], rgb[2], af);
  buf[i + 3] = 255;
}

// Rounded-rect coverage for anti-aliased edges (super-sampled 2×2).
function roundedRectCoverage(x, y, rx, ry, rw, rh, r) {
  let hits = 0;
  for (let sx = 0; sx < 2; sx++) {
    for (let sy = 0; sy < 2; sy++) {
      const px = x + (sx + 0.5) / 2;
      const py = y + (sy + 0.5) / 2;
      if (px < rx || py < ry || px > rx + rw || py > ry + rh) continue;
      const cx = Math.min(Math.max(px, rx + r), rx + rw - r);
      const cy = Math.min(Math.max(py, ry + r), ry + rh - r);
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= r * r) hits++;
    }
  }
  return hits / 4;
}

function diamondCoverage(x, y, cx, cy, r) {
  let hits = 0;
  for (let sx = 0; sx < 2; sx++) {
    for (let sy = 0; sy < 2; sy++) {
      const px = x + (sx + 0.5) / 2;
      const py = y + (sy + 0.5) / 2;
      if (Math.abs(px - cx) + Math.abs(py - cy) <= r) hits++;
    }
  }
  return hits / 4;
}

// 1. Background: vertical gradient + rounded-panel mask.
const R = SIZE * 0.205;
for (let y = 0; y < SIZE; y++) {
  const t = y / (SIZE - 1);
  const bg = mix(BG_TOP, BG_BOT, t);
  for (let x = 0; x < SIZE; x++) {
    const cov = roundedRectCoverage(x, y, 0, 0, SIZE, SIZE, R);
    if (cov > 0) setPx(x, y, bg, Math.round(cov * 255));
  }
}

// 2. Result bars near the bottom.
const barX = SIZE * 0.27;
const barR = SIZE * 0.018;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let cov = roundedRectCoverage(x, y, barX, SIZE * 0.71, SIZE * 0.46, SIZE * 0.035, barR);
    if (cov > 0) setPx(x, y, BAR1, Math.round(cov * 255));
    cov = roundedRectCoverage(x, y, barX, SIZE * 0.78, SIZE * 0.34, SIZE * 0.035, barR);
    if (cov > 0) setPx(x, y, BAR2, Math.round(cov * 255));
  }
}

// 3. Query diamond (gradient fill) centered in the upper area.
const cx = SIZE * 0.5;
const cy = SIZE * 0.42;
const dr = SIZE * 0.17;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cov = diamondCoverage(x, y, cx, cy, dr);
    if (cov > 0) {
      const t = (y - (cy - dr)) / (2 * dr);
      setPx(x, y, mix(BLUE_HI, BLUE_LO, Math.max(0, Math.min(1, t))), Math.round(cov * 255));
    }
  }
}

// PNG encode (single IDAT, filter 0 per scanline).
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter type 0
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'icon.png');
fs.writeFileSync(outFile, png);
console.log(`[make-icon] wrote ${outFile} (${png.length} bytes, ${SIZE}x${SIZE})`);
