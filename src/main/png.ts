import * as zlib from 'node:zlib';

/*
 * Minimal PNG alpha inspection (no dependencies): used to check that a "transparent background"
 * request really produced alpha, and to clean up near-opaque alpha noise.
 */

export interface AlphaStats {
  /** Color type carries alpha (4 = gray+alpha, 6 = RGBA) or has a tRNS chunk. */
  hasAlphaChannel: boolean;
  /** Pixels with alpha 0. Undefined when the pixel data could not be analysed. */
  transparent?: number;
  /** Pixels with 0 < alpha < 255. */
  partial?: number;
  total?: number;
}

interface Chunk { type: string; data: Buffer; start: number; end: number }

function chunks(buf: Buffer): Chunk[] | null {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  const out: Chunk[] = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (off + 12 + len > buf.length) break;
    out.push({ type, data: buf.subarray(off + 8, off + 8 + len), start: off, end: off + 12 + len });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode 8-bit, non-interlaced RGBA / gray+alpha PNG pixel rows. Returns null for other layouts. */
function decodeAlphaPixels(cs: Chunk[]): { raw: Buffer; width: number; height: number; bpp: number } | null {
  const ihdr = cs.find((c) => c.type === 'IHDR')?.data;
  if (!ihdr) return null;
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  const depth = ihdr[8], colorType = ihdr[9], interlace = ihdr[12];
  if (depth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 4)) return null;
  if (width * height > 64_000_000) return null;
  const bpp = colorType === 6 ? 4 : 2;
  const stride = width * bpp;
  const inflated = zlib.inflateSync(Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  if (inflated.length < (stride + 1) * height) return null;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = inflated[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = inflated[src + x];
      const a = x >= bpp ? raw[dst + x - bpp] : 0;
      const b = y > 0 ? raw[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? raw[dst - stride + x - bpp] : 0;
      let r: number;
      switch (ft) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: return null;
      }
      raw[dst + x] = r & 0xff;
    }
  }
  return { raw, width, height, bpp };
}

export function pngAlphaStats(buf: Buffer): AlphaStats | null {
  const cs = chunks(buf);
  if (!cs) return null;
  const ihdr = cs.find((c) => c.type === 'IHDR')?.data;
  if (!ihdr) return null;
  const colorType = ihdr[9];
  const hasAlphaChannel = colorType === 4 || colorType === 6 || cs.some((c) => c.type === 'tRNS');
  if (!hasAlphaChannel) return { hasAlphaChannel, transparent: 0, partial: 0, total: ihdr.readUInt32BE(0) * ihdr.readUInt32BE(4) };
  try {
    const px = decodeAlphaPixels(cs);
    if (!px) return { hasAlphaChannel };
    let transparent = 0, partial = 0;
    for (let i = px.bpp - 1; i < px.raw.length; i += px.bpp) {
      const al = px.raw[i];
      if (al === 0) transparent++;
      else if (al < 255) partial++;
    }
    return { hasAlphaChannel, transparent, partial, total: px.width * px.height };
  } catch {
    return { hasAlphaChannel };
  }
}

/** Whether the image (PNG or WebP) may carry transparency — used to pick a PNG preview instead of JPEG. */
export function mayHaveAlpha(buf: Buffer): boolean {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true;
  const cs = chunks(buf);
  if (!cs) return false;
  const ihdr = cs.find((c) => c.type === 'IHDR')?.data;
  return !!ihdr && (ihdr[9] === 4 || ihdr[9] === 6 || cs.some((c) => c.type === 'tRNS'));
}
