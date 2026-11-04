import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { decryptSecret, settings } from './config';
import { loadInputImage, SavedImage, saveImages } from './images';
import { CodexProvider } from './providers/codex';
import { InputImage, Provider, ProviderError } from './providers/common';
import { CustomProvider } from './providers/custom';
import { OpenRouterProvider } from './providers/openrouter';
import { Capabilities, getCapabilities } from './spec';

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  prompt: string;
  mode: string;
  model: string;
  params: Record<string, any>;
  client?: string;
  progress: string;
  images: SavedImage[];
  error?: string;
  errorDetail?: string;
  costUsd?: number;
  text?: string;
  controller: AbortController;
  done: Promise<Job>;
}

const providers: Record<string, Provider> = {
  codex: new CodexProvider(),
  openrouter: new OpenRouterProvider(),
  custom: new CustomProvider(),
};

export function currentCapabilities(): Capabilities {
  const s = settings.get();
  return getCapabilities(s, {
    openrouter: !!decryptSecret(s.openrouter.keyEnc),
    custom: !!decryptSecret(s.custom.keyEnc),
  });
}

export function validateArgs(args: any, caps: Capabilities) {
  if (!args || typeof args.prompt !== 'string' || !args.prompt.trim()) throw new ProviderError('prompt 是必填的');
  const check = (key: string, allowed: string[]) => {
    const v = args[key];
    if (v === undefined || v === null || v === '') return undefined;
    if (!allowed.length) return undefined; // silently drop params the current generator doesn't support
    if (!allowed.includes(String(v))) throw new ProviderError(`${key} 必須是以下其中之一：${allowed.join(', ')}`);
    return String(v);
  };
  const inputs: string[] = Array.isArray(args.input_images) ? args.input_images.filter((x: any) => typeof x === 'string' && x) : [];
  if (inputs.length > caps.maxInputImages) {
    throw new ProviderError(caps.maxInputImages ? `最多只能提供 ${caps.maxInputImages} 張參考圖片` : '目前的模型不支援參考圖片 / 圖片編輯');
  }
  let n = Number.isInteger(args.n) ? args.n : 1;
  n = Math.max(1, Math.min(n, caps.maxN));
  return {
    prompt: args.prompt.trim(),
    inputs,
    resolution: check('resolution', caps.resolutions) ?? caps.defaults.resolution,
    aspectRatio: check('aspect_ratio', caps.aspectRatios) ?? caps.defaults.aspect_ratio,
    quality: check('quality', caps.qualities) ?? caps.defaults.quality,
    background: check('background', caps.backgrounds),
    outputFormat: check('output_format', caps.outputFormats),
    seed: caps.seed && Number.isInteger(args.seed) ? args.seed : undefined,
    n,
    outputPath: typeof args.output_path === 'string' && args.output_path.trim() ? args.output_path.trim() : undefined,
  };
}

class JobManager extends EventEmitter {
  private jobs = new Map<string, Job>();
  private running = 0;
  private waiting: Array<() => void> = [];

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string) {
    return this.jobs.get(id);
  }

  get activeCount() {
    return [...this.jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running').length;
  }

  cancel(id: string) {
    const j = this.jobs.get(id);
    if (j && (j.status === 'queued' || j.status === 'running')) j.controller.abort(new Error('cancelled'));
  }

  submit(rawArgs: any, client?: string): Job {
    const caps = currentCapabilities();
    if (!caps.ready) throw new ProviderError(`生成器尚未就緒：${caps.notReadyReason}`);
    const a = validateArgs(rawArgs, caps);
    const controller = new AbortController();
    const job: Job = {
      id: randomUUID(),
      status: 'queued',
      createdAt: Date.now(),
      prompt: a.prompt,
      mode: caps.mode,
      model: caps.model,
      params: { resolution: a.resolution, aspect_ratio: a.aspectRatio, quality: a.quality, n: a.n, inputs: a.inputs.length },
      client,
      progress: '排隊中',
      images: [],
      controller,
      done: undefined as any,
    };
    this.jobs.set(job.id, job);
    this.trim();
    job.done = this.run(job, a, caps.mode);
    this.emit('changed');
    return job;
  }

  private async run(job: Job, a: ReturnType<typeof validateArgs>, mode: string): Promise<Job> {
    const s = settings.get();
    await this.acquire(s.general.maxConcurrent);
    try {
      if (job.controller.signal.aborted) throw new ProviderError('已取消');
      job.status = 'running';
      job.startedAt = Date.now();
      job.progress = '準備中';
      this.emit('changed');
      const inputImages: InputImage[] = [];
      for (const ref of a.inputs) inputImages.push(await loadInputImage(ref, job.controller.signal));
      const provider = providers[mode];
      const result = await provider.generate({
        prompt: a.prompt,
        inputImages,
        resolution: a.resolution,
        aspectRatio: a.aspectRatio,
        quality: a.quality,
        background: a.background,
        outputFormat: a.outputFormat,
        n: a.n,
        seed: a.seed,
        signal: job.controller.signal,
        onProgress: (m) => { job.progress = m; this.emit('progress', job); },
      });
      job.model = result.model;
      job.costUsd = result.costUsd;
      job.text = result.text;
      job.images = saveImages(result.images, s.general.outputDir, a.prompt, a.outputPath);
      job.status = 'done';
      job.progress = '完成';
    } catch (e: any) {
      job.status = job.controller.signal.aborted ? 'cancelled' : 'error';
      job.error = e?.message ?? String(e);
      job.errorDetail = e?.detail;
      job.progress = job.status === 'cancelled' ? '已取消' : '失敗';
    } finally {
      job.finishedAt = Date.now();
      this.release();
      this.emit('changed');
      this.emit('finished', job);
    }
    return job;
  }

  private acquire(max: number): Promise<void> {
    if (this.running < Math.max(1, max)) { this.running++; return Promise.resolve(); }
    return new Promise((resolve) => this.waiting.push(() => { this.running++; resolve(); }));
  }

  private release() {
    this.running--;
    const next = this.waiting.shift();
    if (next) next();
  }

  private trim() {
    const all = this.list();
    for (const j of all.slice(200)) if (j.status !== 'queued' && j.status !== 'running') this.jobs.delete(j.id);
  }
}

export const jobs = new JobManager();

export function publicJob(j: Job) {
  return {
    job_id: j.id,
    status: j.status,
    mode: j.mode,
    model: j.model,
    images: j.images,
    progress: j.progress,
    ...(j.error ? { error: j.error } : {}),
    ...(j.costUsd !== undefined ? { cost_usd: j.costUsd } : {}),
  };
}
