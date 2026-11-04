import { Settings } from './config';
import { findModel } from './providers/openrouter';

/** What the currently selected generator can do — drives the MCP tool schema agents see. */
export interface Capabilities {
  mode: Settings['mode'];
  modeLabel: string;
  provider: string;
  model: string;
  ready: boolean;
  notReadyReason?: string;
  resolutions: string[];
  aspectRatios: string[];
  qualities: string[];
  backgrounds: string[];
  outputFormats: string[];
  maxN: number;
  maxInputImages: number;
  seed: boolean;
  defaults: { resolution?: string; aspect_ratio?: string; quality?: string };
}

export const MODE_LABEL: Record<Settings['mode'], string> = {
  codex: 'Codex CLI 轉發',
  openrouter: 'OpenRouter',
  custom: '自訂 API',
};

function pick(def: string | undefined, allowed: string[]): string | undefined {
  return def && allowed.includes(def) ? def : undefined;
}

export function getCapabilities(s: Settings, hasKey: { openrouter: boolean; custom: boolean }): Capabilities {
  const base: Capabilities = {
    mode: s.mode, modeLabel: MODE_LABEL[s.mode], provider: '', model: '', ready: true,
    resolutions: [], aspectRatios: [], qualities: [], backgrounds: [], outputFormats: [],
    maxN: 1, maxInputImages: 0, seed: false, defaults: {},
  };

  if (s.mode === 'codex') {
    return { ...base, provider: 'Codex CLI (gpt-image)', model: s.codex.model || 'codex default', maxN: 4, maxInputImages: 10 };
  }

  if (s.mode === 'openrouter') {
    const m = findModel(s.openrouter.model);
    const sp = m?.supported_parameters ?? {};
    const en = (k: string) => (sp[k]?.type === 'enum' ? (sp[k].values ?? []) : []);
    const resolutions = en('resolution');
    const aspectRatios = en('aspect_ratio');
    const qualities = en('quality');
    const caps: Capabilities = {
      ...base,
      provider: 'OpenRouter',
      model: s.openrouter.model,
      resolutions,
      aspectRatios,
      qualities,
      backgrounds: en('background'),
      outputFormats: en('output_format').filter((f) => f !== 'svg'),
      maxN: sp.n?.type === 'range' ? Math.max(1, Math.min(sp.n.max ?? 1, 10)) : 1,
      maxInputImages: sp.input_references?.type === 'range' ? (sp.input_references.max ?? 0) : 0,
      seed: sp.seed?.type === 'boolean',
      defaults: {
        resolution: pick(s.openrouter.defaults.resolution, resolutions),
        aspect_ratio: pick(s.openrouter.defaults.aspect_ratio, aspectRatios),
        quality: pick(s.openrouter.defaults.quality, qualities),
      },
    };
    if (!hasKey.openrouter) { caps.ready = false; caps.notReadyReason = 'OpenRouter 尚未登入'; }
    else if (!m) { caps.ready = false; caps.notReadyReason = `模型清單中找不到 ${s.openrouter.model}，請在設定頁重新整理模型`; }
    return caps;
  }

  const c = s.custom;
  const caps: Capabilities = {
    ...base,
    provider: c.name || '自訂供應商',
    model: c.model,
    resolutions: [...c.resolutions],
    aspectRatios: [...c.aspectRatios],
    qualities: [...c.qualities],
    backgrounds: c.format === 'openai-images' || c.format === 'openrouter-images' ? ['auto', 'transparent', 'opaque'] : [],
    outputFormats: c.format === 'openai-images' || c.format === 'openrouter-images' ? ['png', 'jpeg', 'webp'] : [],
    maxN: Math.max(1, c.maxN || 1),
    maxInputImages: Math.max(0, c.maxInputImages || 0),
    seed: c.format === 'openrouter-images',
    defaults: {
      resolution: pick(c.defaults.resolution, c.resolutions),
      aspect_ratio: pick(c.defaults.aspect_ratio, c.aspectRatios),
      quality: pick(c.defaults.quality, c.qualities),
    },
  };
  if (!c.baseUrl || !c.model) { caps.ready = false; caps.notReadyReason = '自訂供應商尚未設定完成'; }
  return caps;
}

const RES_HINT: Record<string, string> = {
  '512': '≈512px', '768': '≈768px', '1K': '≈1024px 長邊', '1.5K': '≈1536px', '2K': '≈2048px 長邊', '4K': '≈4096px 長邊',
};

export function generateToolSchema(c: Capabilities) {
  const props: Record<string, any> = {
    prompt: {
      type: 'string',
      description: 'Detailed description of the image: subject, style, composition, palette, lighting, background, any text to render. For edits, describe the change to make to the reference image(s).',
      minLength: 1,
    },
  };
  if (c.maxInputImages > 0) {
    props.input_images = {
      type: 'array',
      maxItems: c.maxInputImages,
      items: { type: 'string' },
      description: `Optional reference / source images for editing or image-to-image (max ${c.maxInputImages}). Each item: absolute local file path, http(s) URL, or data: URL.`,
    };
  }
  if (c.resolutions.length) {
    props.resolution = {
      type: 'string', enum: c.resolutions,
      description: `Output resolution tier. ${c.resolutions.map((r) => `${r}${RES_HINT[r] ? ` (${RES_HINT[r]})` : ''}`).join(', ')}.` +
        (c.defaults.resolution ? ` Default: ${c.defaults.resolution}.` : ''),
    };
  }
  if (c.aspectRatios.length) {
    props.aspect_ratio = {
      type: 'string', enum: c.aspectRatios,
      description: 'Width:height aspect ratio.' + (c.defaults.aspect_ratio ? ` Default: ${c.defaults.aspect_ratio}.` : ''),
    };
  }
  if (c.qualities.length) {
    props.quality = {
      type: 'string', enum: c.qualities,
      description: 'Rendering quality / effort (higher = slower, more expensive).' + (c.defaults.quality ? ` Default: ${c.defaults.quality}.` : ''),
    };
  }
  if (c.backgrounds.length) props.background = { type: 'string', enum: c.backgrounds, description: 'Background handling. "transparent" requires png or webp output.' };
  if (c.outputFormats.length) props.output_format = { type: 'string', enum: c.outputFormats, description: 'File format of the generated image.' };
  if (c.maxN > 1) props.n = { type: 'integer', minimum: 1, maximum: c.maxN, description: `Number of images to generate (1-${c.maxN}). Default 1.` };
  if (c.seed) props.seed = { type: 'integer', description: 'Seed for reproducible output.' };
  props.output_path = {
    type: 'string',
    description: 'Optional absolute path where a copy should be saved (a file path like C:\\proj\\assets\\hero.png, or an existing directory). Use this to put the image straight into the user\'s project. The original is always kept in the Image Summon output folder.',
  };
  props.async = {
    type: 'boolean',
    description: 'If true, return a job_id immediately instead of waiting; then call get_image_job. Use when your client has short tool timeouts.',
  };
  return { type: 'object', properties: props, required: ['prompt'], additionalProperties: false };
}

export const JOB_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    job_id: { type: 'string' },
    status: { type: 'string', enum: ['queued', 'running', 'done', 'error', 'cancelled'] },
    mode: { type: 'string' },
    model: { type: 'string' },
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the saved image' },
          copy_path: { type: 'string', description: 'Path of the copy written to output_path, if requested' },
          mime_type: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
        },
        required: ['path', 'mime_type'],
      },
    },
    progress: { type: 'string' },
    error: { type: 'string' },
    cost_usd: { type: 'number' },
  },
  required: ['job_id', 'status', 'images'],
};

export function describeSpec(c: Capabilities, serverUrl: string): string {
  const lines = [
    `# Image Summon — current generator`,
    `- Mode: ${c.modeLabel}`,
    `- Provider: ${c.provider}`,
    `- Model: ${c.model}`,
    `- Ready: ${c.ready ? 'yes' : 'no — ' + c.notReadyReason}`,
    `- Server: ${serverUrl}`,
  ];
  if (c.mode === 'codex') {
    lines.push('', 'Codex mode forwards the prompt (and optional reference images) to `codex exec` with its built-in image generator. Size/aspect are decided by Codex — describe the desired framing in the prompt (e.g. "wide 16:9 banner").');
  } else {
    lines.push('', '## Parameters the generate_image tool accepts now');
    lines.push(`- resolution: ${c.resolutions.length ? c.resolutions.join(' | ') : '(not supported by this model)'}${c.defaults.resolution ? ` (default ${c.defaults.resolution})` : ''}`);
    lines.push(`- aspect_ratio: ${c.aspectRatios.length ? c.aspectRatios.join(' | ') : '(not supported)'}${c.defaults.aspect_ratio ? ` (default ${c.defaults.aspect_ratio})` : ''}`);
    lines.push(`- quality: ${c.qualities.length ? c.qualities.join(' | ') : '(not supported)'}${c.defaults.quality ? ` (default ${c.defaults.quality})` : ''}`);
    if (c.backgrounds.length) lines.push(`- background: ${c.backgrounds.join(' | ')}`);
    if (c.outputFormats.length) lines.push(`- output_format: ${c.outputFormats.join(' | ')}`);
    lines.push(`- n: 1..${c.maxN}`);
    lines.push(`- input_images: up to ${c.maxInputImages}${c.maxInputImages ? '' : ' (image editing not supported)'}`);
    if (c.seed) lines.push('- seed: integer');
  }
  lines.push('', 'The tool schema changes when the user switches generator in the tray settings; a notifications/tools/list_changed is sent. Results are saved as files and returned with a preview.');
  return lines.join('\n');
}
