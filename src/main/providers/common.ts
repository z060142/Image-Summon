export interface InputImage {
  mime: string;
  data: Buffer;
  source: string; // original reference (path / url)
  path?: string; // local file path when available (codex needs files)
}

export interface GenRequest {
  prompt: string;
  inputImages: InputImage[];
  resolution?: string;
  aspectRatio?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
  n: number;
  seed?: number;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}

export interface GenImage {
  data: Buffer;
  mime: string;
}

export interface GenResult {
  images: GenImage[];
  model: string;
  text?: string;
  costUsd?: number;
}

export interface Provider {
  id: string;
  generate(req: GenRequest): Promise<GenResult>;
}

export class ProviderError extends Error {
  constructor(message: string, public status?: number, public detail?: string) {
    super(message);
  }
}

export function sniffMime(buf: Buffer): string {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 256)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return 'application/octet-stream';
}

export function extFor(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    case 'image/svg+xml': return 'svg';
    default: return 'bin';
  }
}

export function toDataUrl(img: InputImage): string {
  return `data:${img.mime};base64,${img.data.toString('base64')}`;
}

/** Decode "data:" URL, fetch http(s) URL, or plain base64 into an image. */
export async function decodeImageRef(ref: string, signal?: AbortSignal): Promise<GenImage> {
  if (ref.startsWith('data:')) {
    const comma = ref.indexOf(',');
    const meta = ref.slice(5, comma);
    const data = Buffer.from(ref.slice(comma + 1), meta.includes('base64') ? 'base64' : 'utf8');
    return { data, mime: sniffMime(data) || meta.split(';')[0] };
  }
  if (/^https?:\/\//i.test(ref)) {
    const res = await fetch(ref, { signal });
    if (!res.ok) throw new ProviderError(`下載圖片失敗 HTTP ${res.status}`, res.status);
    const data = Buffer.from(await res.arrayBuffer());
    return { data, mime: sniffMime(data) };
  }
  const data = Buffer.from(ref, 'base64');
  return { data, mime: sniffMime(data) };
}

export async function httpJson(url: string, init: RequestInit & { timeoutMs?: number }, signal?: AbortSignal): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), init.timeoutMs ?? 600_000);
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: any = undefined;
    try { body = text ? JSON.parse(text) : undefined; } catch { /* non-json */ }
    if (!res.ok) {
      const msg = body?.error?.message ?? body?.error ?? body?.message ?? text.slice(0, 500);
      throw new ProviderError(`HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status, text.slice(0, 2000));
    }
    if (body === undefined) throw new ProviderError('回應不是 JSON：' + text.slice(0, 300));
    return body;
  } catch (e: any) {
    if (signal?.aborted) throw new ProviderError('已取消');
    if (e?.name === 'AbortError' || e?.message === 'timeout') throw new ProviderError('請求逾時');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function parseJsonObject(text: string, label: string): Record<string, any> {
  if (!text || !text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* fallthrough */ }
  throw new ProviderError(`${label} 不是有效的 JSON 物件`);
}

const TIER_EDGE: Record<string, number> = { '0.5K': 512, '512': 512, '768': 768, '1K': 1024, '1.5K': 1536, '2K': 2048, '4K': 3840 };

/** Turn a resolution tier ("2K") + aspect ratio ("16:9") into explicit pixels, multiples of 16. */
export function tierToPixels(resolution: string | undefined, aspect: string | undefined): string | undefined {
  if (!resolution && !aspect) return undefined;
  if (resolution && /^\d+x\d+$/i.test(resolution)) return resolution.toLowerCase();
  const edge = TIER_EDGE[(resolution || '1K').toUpperCase()] ?? 1024;
  let rw = 1, rh = 1;
  if (aspect && aspect !== 'auto' && aspect.includes(':')) {
    const [a, b] = aspect.split(':').map(Number);
    if (a > 0 && b > 0) { rw = a; rh = b; }
  }
  let w: number, h: number;
  if (rw >= rh) { w = edge; h = (edge * rh) / rw; } else { h = edge; w = (edge * rw) / rh; }
  const r16 = (v: number) => Math.max(16, Math.round(v / 16) * 16);
  return `${r16(w)}x${r16(h)}`;
}
