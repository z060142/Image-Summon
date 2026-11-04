// Generates app / tray icons (PNG + multi-size ICO) with no external dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
mkdirSync(out, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a + (b - a) * t;

/** Sample the icon at normalized coords (0..1). Returns [r,g,b,a] 0..1 */
function sample(x, y, theme, tray) {
  // rounded square
  const pad = tray ? 0.02 : 0.06, r = tray ? 0.24 : 0.22;
  const lo = pad, hi = 1 - pad;
  const cx = Math.min(Math.max(x, lo + r), hi - r), cy = Math.min(Math.max(y, lo + r), hi - r);
  const inside = Math.hypot(x - cx, y - cy) <= r && x >= lo && x <= hi && y >= lo && y <= hi;
  if (!inside) return [0, 0, 0, 0];
  const t = (x + y) / 2;
  let col = [mix(theme[0][0], theme[1][0], t), mix(theme[0][1], theme[1][1], t), mix(theme[0][2], theme[1][2], t)];
  // 4-point sparkle (astroid-like star): |dx|^p + |dy|^p <= R^p with p<1
  const star = (sx, sy, R) => {
    const dx = Math.abs(x - sx) / R, dy = Math.abs(y - sy) / R;
    return Math.pow(dx, 0.5) + Math.pow(dy, 0.5) <= 1;
  };
  const glow = Math.max(0, 1 - Math.hypot(x - 0.47, y - 0.5) / 0.42) * 0.25;
  col = col.map((c) => Math.min(1, c + glow));
  if (star(0.46, 0.52, 0.34) || star(0.73, 0.27, 0.13) || (!tray && star(0.26, 0.76, 0.08))) col = [1, 1, 1];
  return [...col, 1];
}

function render(size, theme, tray = false) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const s = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, theme, tray);
        r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3];
      }
      const i = (py * size + px) * 4;
      const n = ss * ss;
      buf[i + 3] = Math.round((a / n) * 255);
      if (a > 0) { buf[i] = Math.round((r / a) * 255); buf[i + 1] = Math.round((g / a) * 255); buf[i + 2] = Math.round((b / a) * 255); }
    }
  }
  return png(size, buf);
}

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(([size, data], i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p[1])]);
}

const MAIN = [[0.42, 0.33, 0.98], [0.13, 0.66, 0.96]]; // violet -> sky
const BUSY = [[0.98, 0.55, 0.16], [0.93, 0.27, 0.47]]; // amber -> pink

writeFileSync(path.join(out, 'icon.png'), render(512, MAIN));
writeFileSync(path.join(out, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((s) => [s, render(s, MAIN)])));
writeFileSync(path.join(out, 'tray-idle.png'), render(32, MAIN, true));
writeFileSync(path.join(out, 'tray-idle@2x.png'), render(64, MAIN, true));
writeFileSync(path.join(out, 'tray-busy.png'), render(32, BUSY, true));
writeFileSync(path.join(out, 'tray-busy@2x.png'), render(64, BUSY, true));
console.log('icons written to', out);
