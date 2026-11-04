import * as fs from 'node:fs';
import { decryptSecret, settings, userDataFile } from '../config';
import { decodeImageRef, GenRequest, GenResult, httpJson, Provider, ProviderError, toDataUrl } from './common';

export const OR_BASE = 'https://openrouter.ai/api/v1';
const ATTRIBUTION = { 'HTTP-Referer': 'https://github.com/z060142/Image-Summon', 'X-Title': 'Image Summon' };

export interface ORParam {
  type: 'enum' | 'range' | 'boolean';
  values?: string[];
  min?: number;
  max?: number;
}

export interface ORModel {
  id: string;
  name: string;
  description?: string;
  created?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters: Record<string, ORParam>;
}

let cache: { at: number; models: ORModel[] } | null = null;
const cacheFile = () => userDataFile('openrouter-image-models.json');

export function getCachedModels(): ORModel[] {
  if (!cache) {
    try { cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { cache = { at: 0, models: [] }; }
  }
  return cache!.models;
}

export function cacheAge(): number {
  getCachedModels();
  return Date.now() - (cache?.at ?? 0);
}

export async function refreshModels(): Promise<ORModel[]> {
  const key = decryptSecret(settings.get().openrouter.keyEnc);
  const headers: Record<string, string> = { ...ATTRIBUTION };
  if (key) headers.Authorization = `Bearer ${key}`;
  const body = await httpJson(`${OR_BASE}/images/models`, { method: 'GET', headers, timeoutMs: 30_000 });
  const models: ORModel[] = (body.data ?? body).filter((m: any) => m && m.id);
  cache = { at: Date.now(), models };
  try { fs.writeFileSync(cacheFile(), JSON.stringify(cache), 'utf8'); } catch { /* ignore */ }
  return models;
}

export function findModel(id: string): ORModel | undefined {
  return getCachedModels().find((m) => m.id === id);
}

export async function keyInfo(): Promise<any> {
  const key = decryptSecret(settings.get().openrouter.keyEnc);
  if (!key) throw new ProviderError('尚未設定 OpenRouter 金鑰');
  const res = await httpJson(`${OR_BASE}/key`, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, timeoutMs: 20_000 });
  return res.data ?? res;
}

/** Shared body builder: OpenRouter's /images API (also used by "openrouter-images" custom format). */
export function buildImagesBody(model: string, req: GenRequest, params?: Record<string, ORParam>): any {
  const body: any = { model, prompt: req.prompt };
  const allowed = (k: string) => !params || k in params;
  if (req.resolution && allowed('resolution')) body.resolution = req.resolution;
  if (req.aspectRatio && allowed('aspect_ratio')) body.aspect_ratio = req.aspectRatio;
  if (req.quality && allowed('quality')) body.quality = req.quality;
  if (req.background && allowed('background')) body.background = req.background;
  if (req.outputFormat && allowed('output_format')) body.output_format = req.outputFormat;
  if (req.n > 1 && allowed('n')) body.n = req.n;
  if (req.seed !== undefined && allowed('seed')) body.seed = req.seed;
  if (req.inputImages.length) {
    body.input_references = req.inputImages.map((img) => ({ type: 'image_url', image_url: { url: toDataUrl(img) } }));
  }
  return body;
}

export async function parseImagesResponse(body: any, signal: AbortSignal) {
  const items: any[] = body?.data ?? [];
  const images = [];
  for (const it of items) {
    if (it.b64_json) {
      const img = await decodeImageRef(it.b64_json);
      images.push({ data: img.data, mime: it.media_type || img.mime });
    } else if (it.url) {
      images.push(await decodeImageRef(it.url, signal));
    }
  }
  return images;
}

export class OpenRouterProvider implements Provider {
  id = 'openrouter';

  async generate(req: GenRequest): Promise<GenResult> {
    const s = settings.get().openrouter;
    const key = decryptSecret(s.keyEnc);
    if (!key) throw new ProviderError('OpenRouter 尚未登入或設定金鑰，請從系統匣開啟設定頁');
    const model = findModel(s.model);
    const body = buildImagesBody(s.model, req, model?.supported_parameters);
    req.onProgress(`OpenRouter · ${s.model} 生成中`);
    const res = await httpJson(`${OR_BASE}/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...ATTRIBUTION },
      body: JSON.stringify(body),
      timeoutMs: 600_000,
    }, req.signal);
    const images = await parseImagesResponse(res, req.signal);
    if (!images.length) throw new ProviderError('OpenRouter 沒有回傳圖片', undefined, JSON.stringify(res).slice(0, 1500));
    return { images, model: s.model, costUsd: res?.usage?.cost };
  }
}
