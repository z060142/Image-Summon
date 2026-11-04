import { decryptSecret, settings, Settings } from '../config';
import {
  decodeImageRef, extFor, GenImage, GenRequest, GenResult, httpJson, parseJsonObject, Provider, ProviderError,
  tierToPixels, toDataUrl,
} from './common';
import { buildImagesBody, parseImagesResponse } from './openrouter';

type CustomCfg = Settings['custom'];

function trimBase(u: string) {
  return u.replace(/\/+$/, '');
}

export class CustomProvider implements Provider {
  id = 'custom';

  async generate(req: GenRequest): Promise<GenResult> {
    const cfg = settings.get().custom;
    const key = decryptSecret(cfg.keyEnc);
    if (!cfg.baseUrl) throw new ProviderError('自訂供應商尚未設定 Base URL');
    if (!cfg.model) throw new ProviderError('自訂供應商尚未設定模型');
    const extraHeaders = parseJsonObject(cfg.extraHeaders, '額外 Headers');
    const extraBody = parseJsonObject(cfg.extraBody, '額外 Body');
    req.onProgress(`${cfg.name || '自訂供應商'} · ${cfg.model} 生成中`);
    let images: GenImage[];
    switch (cfg.format) {
      case 'openai-images': images = await openaiImages(cfg, key, req, extraHeaders, extraBody); break;
      case 'openrouter-images': images = await openrouterImages(cfg, key, req, extraHeaders, extraBody); break;
      case 'gemini': images = await gemini(cfg, key, req, extraHeaders, extraBody); break;
      case 'openai-chat': images = await openaiChat(cfg, key, req, extraHeaders, extraBody); break;
      default: throw new ProviderError('未知的 API 格式：' + cfg.format);
    }
    if (!images.length) throw new ProviderError('供應商沒有回傳圖片');
    return { images, model: cfg.model };
  }
}

function bearer(key: string): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// ---- OpenAI Images API (/images/generations, /images/edits) ----
async function openaiImages(cfg: CustomCfg, key: string, req: GenRequest, xh: any, xb: any): Promise<GenImage[]> {
  const base = trimBase(cfg.baseUrl);
  const size = tierToPixels(req.resolution, req.aspectRatio);
  const fields: Record<string, any> = { model: cfg.model, prompt: req.prompt };
  if (size) fields.size = size;
  if (req.quality) fields.quality = req.quality;
  if (req.background) fields.background = req.background;
  if (req.outputFormat) fields.output_format = req.outputFormat;
  if (req.n > 1) fields.n = req.n;
  Object.assign(fields, xb);

  let res: any;
  if (req.inputImages.length) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    req.inputImages.forEach((img, i) => {
      form.append('image[]', new Blob([new Uint8Array(img.data)], { type: img.mime }), `input-${i}.${extFor(img.mime)}`);
    });
    res = await httpJson(`${base}/images/edits`, { method: 'POST', headers: { ...bearer(key), ...xh }, body: form }, req.signal);
  } else {
    res = await httpJson(`${base}/images/generations`, {
      method: 'POST',
      headers: { ...bearer(key), 'Content-Type': 'application/json', ...xh },
      body: JSON.stringify(fields),
    }, req.signal);
  }
  return parseImagesResponse(res, req.signal);
}

// ---- OpenRouter-compatible /images API ----
async function openrouterImages(cfg: CustomCfg, key: string, req: GenRequest, xh: any, xb: any): Promise<GenImage[]> {
  const body = { ...buildImagesBody(cfg.model, req), ...xb };
  const res = await httpJson(`${trimBase(cfg.baseUrl)}/images`, {
    method: 'POST',
    headers: { ...bearer(key), 'Content-Type': 'application/json', ...xh },
    body: JSON.stringify(body),
  }, req.signal);
  return parseImagesResponse(res, req.signal);
}

// ---- Google Gemini generateContent ----
async function gemini(cfg: CustomCfg, key: string, req: GenRequest, xh: any, xb: any): Promise<GenImage[]> {
  const parts: any[] = [{ text: req.prompt }];
  for (const img of req.inputImages) parts.push({ inline_data: { mime_type: img.mime, data: img.data.toString('base64') } });
  const imageConfig: any = {};
  if (req.aspectRatio && req.aspectRatio !== 'auto') imageConfig.aspectRatio = req.aspectRatio;
  if (req.resolution) imageConfig.imageSize = req.resolution.toUpperCase();
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
    ...xb,
  };
  const url = `${trimBase(cfg.baseUrl)}/models/${encodeURIComponent(cfg.model)}:generateContent`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...xh };
  if (key) headers['x-goog-api-key'] = key;
  const images: GenImage[] = [];
  const runs = Math.max(1, req.n);
  for (let i = 0; i < runs; i++) {
    const res = await httpJson(url, { method: 'POST', headers, body: JSON.stringify(body) }, req.signal);
    for (const cand of res.candidates ?? []) {
      for (const p of cand.content?.parts ?? []) {
        const inline = p.inlineData ?? p.inline_data;
        if (inline?.data) images.push({ data: Buffer.from(inline.data, 'base64'), mime: inline.mimeType ?? inline.mime_type ?? 'image/png' });
      }
    }
    if (!images.length && res.promptFeedback?.blockReason) throw new ProviderError('Gemini 拒絕：' + res.promptFeedback.blockReason);
  }
  return images;
}

// ---- OpenAI-compatible chat completions with image output (modalities) ----
async function openaiChat(cfg: CustomCfg, key: string, req: GenRequest, xh: any, xb: any): Promise<GenImage[]> {
  const content: any[] = [{ type: 'text', text: req.prompt }];
  for (const img of req.inputImages) content.push({ type: 'image_url', image_url: { url: toDataUrl(img) } });
  const image_config: any = {};
  if (req.aspectRatio) image_config.aspect_ratio = req.aspectRatio;
  if (req.resolution) image_config.image_size = req.resolution;
  const body = {
    model: cfg.model,
    messages: [{ role: 'user', content }],
    modalities: ['image', 'text'],
    ...(Object.keys(image_config).length ? { image_config } : {}),
    ...xb,
  };
  const res = await httpJson(`${trimBase(cfg.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: { ...bearer(key), 'Content-Type': 'application/json', ...xh },
    body: JSON.stringify(body),
  }, req.signal);
  const images: GenImage[] = [];
  for (const choice of res.choices ?? []) {
    const msg = choice.message ?? {};
    const refs: string[] = [];
    for (const im of msg.images ?? []) if (im?.image_url?.url) refs.push(im.image_url.url);
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type === 'image_url' && b.image_url?.url) refs.push(b.image_url.url);
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith('data:image')) refs.push(b.text);
      }
    } else if (typeof msg.content === 'string') {
      const m = msg.content.match(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/);
      if (m) refs.push(m[0]);
    }
    for (const r of refs) images.push(await decodeImageRef(r, req.signal));
  }
  return images;
}
