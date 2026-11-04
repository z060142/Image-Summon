import { nativeImage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeImageRef, extFor, GenImage, InputImage, ProviderError, sniffMime } from './providers/common';

export async function loadInputImage(ref: string, signal?: AbortSignal): Promise<InputImage> {
  const r = ref.trim();
  if (r.startsWith('data:') || /^https?:\/\//i.test(r)) {
    const img = await decodeImageRef(r, signal);
    return { ...img, source: r.startsWith('data:') ? 'data-url' : r };
  }
  const p = r.startsWith('file:') ? fileURLToPath(r) : r;
  if (!path.isAbsolute(p)) throw new ProviderError(`參考圖片路徑必須是絕對路徑：${r}`);
  if (!fs.existsSync(p)) throw new ProviderError(`找不到參考圖片：${p}`);
  const data = fs.readFileSync(p);
  if (data.length > 50 * 1024 * 1024) throw new ProviderError(`參考圖片太大（>50MB）：${p}`);
  return { data, mime: sniffMime(data), source: p, path: p };
}

function slug(prompt: string): string {
  const s = prompt
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join('-')
    .slice(0, 48);
  return s || 'image';
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface SavedImage {
  path: string;
  copy_path?: string;
  mime_type: string;
  width?: number;
  height?: number;
  bytes: number;
}

export function saveImages(images: GenImage[], outputDir: string, prompt: string, outputPath?: string): SavedImage[] {
  fs.mkdirSync(outputDir, { recursive: true });
  const base = `${stamp()}-${slug(prompt)}`;
  const saved: SavedImage[] = [];
  images.forEach((img, i) => {
    const mime = img.mime && img.mime !== 'application/octet-stream' ? img.mime : sniffMime(img.data);
    const ext = extFor(mime);
    let file = path.join(outputDir, `${base}${images.length > 1 ? `-${i + 1}` : ''}.${ext}`);
    let k = 2;
    while (fs.existsSync(file)) file = path.join(outputDir, `${base}-${k++}.${ext}`);
    fs.writeFileSync(file, img.data);
    const size = imageSize(img.data);
    const entry: SavedImage = { path: file, mime_type: mime, bytes: img.data.length, ...size };
    if (outputPath) entry.copy_path = copyTo(file, outputPath, i, images.length, ext);
    saved.push(entry);
  });
  return saved;
}

function copyTo(src: string, target: string, index: number, total: number, ext: string): string {
  const t = target.startsWith('file:') ? fileURLToPath(target) : target;
  if (!path.isAbsolute(t)) throw new ProviderError(`output_path 必須是絕對路徑：${target}`);
  let dest: string;
  const isDir = (fs.existsSync(t) && fs.statSync(t).isDirectory()) || /[\\/]$/.test(t) || !path.extname(t);
  if (isDir) {
    fs.mkdirSync(t, { recursive: true });
    dest = path.join(t, path.basename(src));
  } else {
    fs.mkdirSync(path.dirname(t), { recursive: true });
    const stem = t.slice(0, t.length - path.extname(t).length);
    const wantExt = path.extname(t).slice(1).toLowerCase();
    // keep the real format's extension if the requested one doesn't match
    const realExt = wantExt === ext || (wantExt === 'jpeg' && ext === 'jpg') ? path.extname(t) : `.${ext}`;
    dest = total > 1 ? `${stem}-${index + 1}${realExt}` : `${stem}${realExt}`;
  }
  fs.copyFileSync(src, dest);
  return dest;
}

export function imageSize(buf: Buffer): { width?: number; height?: number } {
  try {
    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) {
      const s = img.getSize();
      return { width: s.width, height: s.height };
    }
  } catch { /* ignore */ }
  // PNG header fallback
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  return {};
}

/** Small JPEG preview for the MCP result (keeps tool results well under client limits). */
export function makePreview(buf: Buffer, maxEdge: number): { data: string; mimeType: string } | null {
  try {
    let img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) {
      const mime = sniffMime(buf);
      if ((mime === 'image/webp' || mime === 'image/gif') && buf.length < 900_000) return { data: buf.toString('base64'), mimeType: mime };
      return null;
    }
    const { width, height } = img.getSize();
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
    return { data: img.toJPEG(85).toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return null;
  }
}

export function thumbnailDataUrl(file: string, maxEdge = 160): string | undefined {
  try {
    const p = makePreview(fs.readFileSync(file), maxEdge);
    return p ? `data:${p.mimeType};base64,${p.data}` : undefined;
  } catch {
    return undefined;
  }
}
