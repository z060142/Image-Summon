import { app, safeStorage } from 'electron';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type Mode = 'codex' | 'openrouter' | 'custom';
export type CustomFormat = 'openai-images' | 'openrouter-images' | 'gemini' | 'openai-chat';

export interface GenDefaults {
  resolution?: string;
  aspect_ratio?: string;
  quality?: string;
}

export interface Settings {
  mode: Mode;
  general: {
    port: number;
    outputDir: string;
    autoStart: boolean;
    includePreview: boolean;
    previewMaxEdge: number;
    maxConcurrent: number;
  };
  codex: {
    path: string; // empty = auto-detect
    model: string; // empty = codex default
    timeoutSec: number;
    extraArgs: string;
  };
  openrouter: {
    keyEnc?: string;
    keySource?: 'oauth' | 'manual';
    model: string;
    defaults: GenDefaults;
  };
  custom: {
    name: string;
    format: CustomFormat;
    baseUrl: string;
    keyEnc?: string;
    model: string;
    resolutions: string[];
    aspectRatios: string[];
    qualities: string[];
    maxN: number;
    maxInputImages: number;
    extraHeaders: string; // JSON object
    extraBody: string; // JSON object
    defaults: GenDefaults;
  };
}

export function defaultSettings(): Settings {
  return {
    mode: 'codex',
    general: {
      port: 47821,
      outputDir: path.join(app.getPath('pictures'), 'Image Summon'),
      autoStart: true,
      includePreview: true,
      previewMaxEdge: 1024,
      maxConcurrent: 3,
    },
    codex: { path: '', model: '', timeoutSec: 600, extraArgs: '' },
    openrouter: {
      model: 'bytedance-seed/seedream-4.5',
      defaults: { resolution: '1K', aspect_ratio: '1:1' },
    },
    custom: {
      name: 'OpenAI',
      format: 'openai-images',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-image-2',
      resolutions: ['1K', '2K', '4K'],
      aspectRatios: ['1:1', '3:2', '2:3', '16:9', '9:16'],
      qualities: ['auto', 'low', 'medium', 'high'],
      maxN: 4,
      maxInputImages: 8,
      extraHeaders: '',
      extraBody: '',
      defaults: { resolution: '1K', aspect_ratio: '1:1', quality: 'auto' },
    },
  };
}

function deepMerge<T>(base: T, over: any): T {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over as T;
  const out: any = { ...base };
  for (const k of Object.keys(over)) {
    const bv = (base as any)[k];
    const ov = over[k];
    out[k] = bv && typeof bv === 'object' && !Array.isArray(bv) && ov && typeof ov === 'object' && !Array.isArray(ov)
      ? deepMerge(bv, ov)
      : ov;
  }
  return out;
}

class SettingsStore extends EventEmitter {
  private data!: Settings;
  private file = '';

  load(): Settings {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    let stored: any = {};
    try {
      stored = JSON.parse(stripBom(fs.readFileSync(this.file, 'utf8')));
    } catch {
      /* first run */
    }
    this.data = deepMerge(defaultSettings(), stored);
    return this.data;
  }

  get isFirstRun(): boolean {
    return !fs.existsSync(this.file);
  }

  get(): Settings {
    return this.data;
  }

  update(patch: any): Settings {
    const prev = this.data;
    this.data = deepMerge(this.data, patch);
    this.persist();
    this.emit('changed', this.data, prev);
    return this.data;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

export const settings = new SettingsStore();

// ---- secrets (Windows DPAPI via Electron safeStorage) ----
export function encryptSecret(plain: string): string {
  if (!plain) return '';
  if (safeStorage.isEncryptionAvailable()) return 'dpapi:' + safeStorage.encryptString(plain).toString('base64');
  return 'plain:' + Buffer.from(plain, 'utf8').toString('base64');
}

export function decryptSecret(enc?: string): string {
  if (!enc) return '';
  try {
    if (enc.startsWith('dpapi:')) return safeStorage.decryptString(Buffer.from(enc.slice(6), 'base64'));
    if (enc.startsWith('plain:')) return Buffer.from(enc.slice(6), 'base64').toString('utf8');
  } catch {
    /* corrupted */
  }
  return '';
}

export function maskSecret(plain: string): string {
  if (!plain) return '';
  if (plain.length <= 10) return '••••';
  return plain.slice(0, 6) + '…' + plain.slice(-4);
}

/** Files edited in Notepad / PowerShell 5 often start with a UTF-8 BOM, which JSON.parse rejects. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function userDataFile(name: string) {
  return path.join(app.getPath('userData'), name);
}
