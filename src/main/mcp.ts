import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { settings } from './config';
import { makePreview } from './images';
import { currentCapabilities, Job, jobs, publicJob } from './jobs';
import { describeSpec, generateToolSchema, JOB_OUTPUT_SCHEMA, MODE_LABEL } from './spec';

export const SERVER_NAME = 'image-summon';

export interface McpContext {
  version: string;
  serverUrl: () => string;
}

const SPEC_URI = 'image-summon://generator/spec';

export function createMcpServer(ctx: McpContext): Server {
  const caps0 = currentCapabilities();
  const server = new Server(
    { name: SERVER_NAME, title: 'Image Summon', version: ctx.version },
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
      instructions:
        'Image Summon is a local image generator running in the Windows tray. Use generate_image to create or edit images; ' +
        'it saves files locally and returns their absolute paths plus a preview. The accepted parameters (resolution such as 1K/2K/4K, ' +
        'aspect_ratio, quality, n, input_images) depend on the generator the user selected — read the generate_image schema or call ' +
        `get_generator_info. Currently: ${MODE_LABEL[caps0.mode]} / ${caps0.model}. Pass output_path to drop a copy into the user's project.`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const caps = currentCapabilities();
    const where = caps.mode === 'codex'
      ? 'Codex CLI forwarding (Codex picks size; describe framing in the prompt)'
      : `${caps.provider} · ${caps.model}`;
    return {
      tools: [
        {
          name: 'generate_image',
          title: 'Generate image',
          description:
            `Generate (or edit, with input_images) an image using the generator selected in Image Summon: ${where}.` +
            (caps.ready ? '' : ` NOT READY: ${caps.notReadyReason}.`) +
            ' Returns saved file path(s), dimensions and a preview. Generation can take 10s–3min.',
          inputSchema: generateToolSchema(caps),
          outputSchema: JOB_OUTPUT_SCHEMA,
          annotations: { title: 'Generate image', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        {
          name: 'get_image_job',
          title: 'Get image job',
          description: 'Get status/result of a generation started with async=true. Optionally waits up to wait_seconds for it to finish.',
          inputSchema: {
            type: 'object',
            properties: {
              job_id: { type: 'string' },
              wait_seconds: { type: 'integer', minimum: 0, maximum: 300, description: 'Block up to this many seconds for completion (default 30).' },
            },
            required: ['job_id'],
            additionalProperties: false,
          },
          outputSchema: JOB_OUTPUT_SCHEMA,
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        {
          name: 'get_generator_info',
          title: 'Get generator info',
          description: 'Describe the active generator (mode, provider, model) and exactly which resolutions, aspect ratios, qualities and limits it accepts.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const args: any = req.params.arguments ?? {};
    const client = server.getClientVersion();
    const clientName = client ? `${client.title ?? client.name} ${client.version ?? ''}`.trim() : undefined;

    if (name === 'get_generator_info') {
      const caps = currentCapabilities();
      return { content: [{ type: 'text', text: describeSpec(caps, ctx.serverUrl()) }] };
    }

    if (name === 'get_image_job') {
      const job = jobs.get(String(args.job_id ?? ''));
      if (!job) return errorResult(`找不到工作 ${args.job_id}`);
      const wait = Math.max(0, Math.min(300, Number.isInteger(args.wait_seconds) ? args.wait_seconds : 30));
      if (job.status === 'queued' || job.status === 'running') {
        await waitJob(job, wait * 1000, extra);
      }
      return jobResult(job);
    }

    if (name === 'generate_image') {
      let job: Job;
      try {
        job = jobs.submit(args, clientName);
      } catch (e: any) {
        return errorResult(e?.message ?? String(e));
      }
      if (args.async === true) {
        return {
          content: [{ type: 'text', text: `已開始生成（job_id: ${job.id}）。請呼叫 get_image_job 取得結果。` }],
          structuredContent: publicJob(job),
        };
      }
      // Cancel generation if the client cancels the request.
      const onAbort = () => jobs.cancel(job.id);
      extra.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await waitJob(job, Infinity, extra);
      } finally {
        extra.signal.removeEventListener('abort', onAbort);
      }
      return jobResult(job);
    }

    return errorResult(`未知的工具：${name}`);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: SPEC_URI, name: 'generator-spec', title: '目前生成器規格', mimeType: 'text/markdown', description: 'Active generator mode, model and accepted parameters' },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (uri === SPEC_URI) {
      return { contents: [{ uri, mimeType: 'text/markdown', text: describeSpec(currentCapabilities(), ctx.serverUrl()) }] };
    }
    if (uri.startsWith('file:')) {
      const p = fileURLToPath(uri);
      const known = jobs.list().some((j) => j.images.some((i) => i.path === p || i.copy_path === p));
      const inOut = path.resolve(p).toLowerCase().startsWith(path.resolve(settings.get().general.outputDir).toLowerCase() + path.sep);
      if ((known || inOut) && fs.existsSync(p)) {
        const img = jobs.list().flatMap((j) => j.images).find((i) => i.path === p || i.copy_path === p);
        return { contents: [{ uri, mimeType: img?.mime_type ?? 'image/png', blob: fs.readFileSync(p).toString('base64') }] };
      }
    }
    throw new Error(`Resource not found: ${uri}`);
  });

  return server;
}

async function waitJob(job: Job, ms: number, extra: any) {
  const token = extra?._meta?.progressToken;
  let tick = 0;
  let timer: NodeJS.Timeout | undefined;
  const send = () => {
    if (token === undefined) return;
    tick++;
    const elapsed = Math.round((Date.now() - (job.startedAt ?? job.createdAt)) / 1000);
    extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: token, progress: tick, message: `${job.progress}（${elapsed}s）` },
    }).catch(() => {});
  };
  const onProgress = (j: Job) => { if (j.id === job.id) send(); };
  jobs.on('progress', onProgress);
  timer = setInterval(send, 5000);
  try {
    await Promise.race([
      job.done,
      new Promise((r) => { if (Number.isFinite(ms)) setTimeout(r, ms); }),
    ]);
  } finally {
    clearInterval(timer);
    jobs.off('progress', onProgress);
  }
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: `錯誤：${message}` }], isError: true };
}

function jobResult(job: Job) {
  const s = settings.get();
  const pub = publicJob(job);
  if (job.status === 'queued' || job.status === 'running') {
    return {
      content: [{ type: 'text', text: `工作 ${job.id} 仍在進行中：${job.progress}。稍後再呼叫 get_image_job。` }],
      structuredContent: pub,
    };
  }
  if (job.status !== 'done') {
    const detail = job.errorDetail ? `\n\n詳細資訊：\n${job.errorDetail.slice(0, 1500)}` : '';
    return {
      content: [{ type: 'text', text: `生成${job.status === 'cancelled' ? '已取消' : '失敗'}（${job.mode} / ${job.model}）：${job.error}${detail}` }],
      structuredContent: pub,
      isError: true,
    };
  }
  const content: any[] = [];
  const lines = [`已生成 ${job.images.length} 張圖片（${MODE_LABEL[job.mode as keyof typeof MODE_LABEL] ?? job.mode} / ${job.model}）：`];
  for (const img of job.images) {
    lines.push(`- ${img.path}${img.width ? `  (${img.width}×${img.height})` : ''}${img.copy_path ? `\n  副本：${img.copy_path}` : ''}`);
  }
  if (job.costUsd !== undefined) lines.push(`費用：約 $${job.costUsd.toFixed(4)}`);
  content.push({ type: 'text', text: lines.join('\n') });
  for (const img of job.images) {
    if (s.general.includePreview) {
      try {
        const prev = makePreview(fs.readFileSync(img.path), s.general.previewMaxEdge);
        if (prev) content.push({ type: 'image', data: prev.data, mimeType: prev.mimeType });
      } catch { /* ignore */ }
    }
    content.push({
      type: 'resource_link',
      uri: pathToFileURL(img.copy_path ?? img.path).href,
      name: path.basename(img.copy_path ?? img.path),
      mimeType: img.mime_type,
      size: img.bytes,
    });
  }
  return { content, structuredContent: pub };
}
