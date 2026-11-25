import { CallToolResult, fromJsonSchema, McpServer, ResourceTemplate, ServerContext } from '@modelcontextprotocol/server';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { settings } from './config';
import { makePreview } from './images';
import { currentCapabilities, Job, jobs, publicJob } from './jobs';
import { skills } from './skills';
import { Capabilities, describeSpec, generateToolSchema, JOB_OUTPUT_SCHEMA, MODE_LABEL } from './spec';

export const SERVER_NAME = 'image-summon';

export interface McpContext {
  version: string;
  serverUrl: () => string;
}

/** A server instance plus a hook to re-publish the generator-dependent tool schema (long-lived 2025 sessions). */
export interface ImageSummonServer {
  mcp: McpServer;
  /** Re-read the active generator and update generate_image (sends tools/list_changed on a connected session). */
  refresh(): void;
}

const SPEC_URI = 'image-summon://generator/spec';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

const GET_JOB_SCHEMA = {
  type: 'object',
  properties: {
    job_id: { type: 'string' },
    wait_seconds: { type: 'integer', minimum: 0, maximum: 300, description: 'Block up to this many seconds for completion (default 30).' },
  },
  required: ['job_id'],
  additionalProperties: false,
} as const;

function generateDescription(caps: Capabilities) {
  const where = caps.mode === 'codex'
    ? 'Codex CLI forwarding (Codex picks size; describe framing in the prompt)'
    : `${caps.provider} · ${caps.model}`;
  return `Generate (or edit, with input_images) an image using the generator selected in Image Summon: ${where}.` +
    (caps.ready ? '' : ` NOT READY: ${caps.notReadyReason}.`) +
    ' Returns saved file path(s), dimensions and a preview. Generation can take 10s–3min.' +
    ` For prompting and parameter guidance, see the "${SERVER_NAME}" skill (skill://${SERVER_NAME}/SKILL.md).`;
}

function clientNameOf(mcp: McpServer, ctx: ServerContext): string | undefined {
  // 2026-07-28: client info travels in every request's _meta envelope; 2025: from initialize.
  const env = (ctx.mcpReq.envelope ?? {}) as Record<string, any>;
  const client = env[CLIENT_INFO_META_KEY] ?? mcp.server.getClientVersion();
  return client ? `${client.title ?? client.name} ${client.version ?? ''}`.trim() : undefined;
}

export function createMcpServer(ctx: McpContext): ImageSummonServer {
  const caps0 = currentCapabilities();
  const mcp = new McpServer(
    { name: SERVER_NAME, title: 'Image Summon', version: ctx.version },
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
      instructions:
        'Image Summon is a local image generator running in the Windows tray. Use generate_image to create or edit images; ' +
        'it saves files locally and returns their absolute paths plus a preview. The accepted parameters (resolution such as 1K/2K/4K, ' +
        'aspect_ratio, quality, n, input_images) depend on the generator the user selected — read the generate_image schema or call ' +
        `get_generator_info. Currently: ${MODE_LABEL[caps0.mode]} / ${caps0.model}. Pass output_path to drop a copy into the user's project. ` +
        `This server also publishes skills (skills/list): read skill://${SERVER_NAME}/SKILL.md for a prompting and workflow guide.`,
    },
  );

  const generate = mcp.registerTool(
    'generate_image',
    {
      title: 'Generate image',
      description: generateDescription(caps0),
      inputSchema: fromJsonSchema<Record<string, any>>(generateToolSchema(caps0) as any),
      outputSchema: fromJsonSchema<Record<string, any>>(JOB_OUTPUT_SCHEMA as any),
      annotations: { title: 'Generate image', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: Record<string, any>, rctx): Promise<CallToolResult> => {
      let job: Job;
      try {
        job = jobs.submit(args, clientNameOf(mcp, rctx));
      } catch (e: any) {
        return errorResult(e?.message ?? String(e));
      }
      if (args.async === true) {
        return {
          content: [{ type: 'text', text: `已開始生成（job_id: ${job.id}）。請呼叫 get_image_job 取得結果。` }],
          structuredContent: publicJob(job) as any,
        };
      }
      // Cancel generation if the client cancels the request.
      const signal = rctx.mcpReq.signal;
      const onAbort = () => jobs.cancel(job.id);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        await waitJob(job, Infinity, rctx);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
      return jobResult(job);
    },
  );

  mcp.registerTool(
    'get_image_job',
    {
      title: 'Get image job',
      description: 'Get status/result of a generation started with async=true. Optionally waits up to wait_seconds for it to finish.',
      inputSchema: fromJsonSchema<{ job_id: string; wait_seconds?: number }>(GET_JOB_SCHEMA as any),
      outputSchema: fromJsonSchema<Record<string, any>>(JOB_OUTPUT_SCHEMA as any),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, rctx): Promise<CallToolResult> => {
      const job = jobs.get(String(args.job_id ?? ''));
      if (!job) return errorResult(`找不到工作 ${args.job_id}`);
      const wait = Math.max(0, Math.min(300, Number.isInteger(args.wait_seconds) ? args.wait_seconds! : 30));
      if (job.status === 'queued' || job.status === 'running') {
        await waitJob(job, wait * 1000, rctx);
      }
      return jobResult(job);
    },
  );

  mcp.registerTool(
    'get_generator_info',
    {
      title: 'Get generator info',
      description: 'Describe the active generator (mode, provider, model) and exactly which resolutions, aspect ratios, qualities and limits it accepts.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: 'text', text: describeSpec(currentCapabilities(), ctx.serverUrl()) }] }),
  );

  mcp.registerResource(
    'generator-spec',
    SPEC_URI,
    { title: '目前生成器規格', mimeType: 'text/markdown', description: 'Active generator mode, model and accepted parameters' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: describeSpec(currentCapabilities(), ctx.serverUrl()) }] }),
  );

  // Generated images, addressed by the file:// URIs we hand out in resource_link blocks.
  mcp.registerResource(
    'generated-image',
    new ResourceTemplate('file:///{+path}', { list: undefined }),
    { title: '生成的圖片', description: 'An image produced by Image Summon (file:// URI from a generate_image result)' },
    async (uri) => {
      const p = fileURLToPath(uri.href);
      const imgs = jobs.list().flatMap((j) => j.images);
      const img = imgs.find((i) => i.path === p || i.copy_path === p);
      const outDir = path.resolve(settings.get().general.outputDir).toLowerCase() + path.sep;
      const inOut = path.resolve(p).toLowerCase().startsWith(outDir);
      if ((img || inOut) && fs.existsSync(p)) {
        return { contents: [{ uri: uri.href, mimeType: img?.mime_type ?? 'image/png', blob: fs.readFileSync(p).toString('base64') }] };
      }
      throw new Error(`Resource not found: ${uri.href}`);
    },
  );

  // Skills over MCP (io.modelcontextprotocol/skills): skills/list + skill:// resources.
  skills.extension?.attach(mcp);

  return {
    mcp,
    refresh() {
      const caps = currentCapabilities();
      generate.update({ description: generateDescription(caps), paramsSchema: fromJsonSchema(generateToolSchema(caps) as any) });
    },
  };
}

async function waitJob(job: Job, ms: number, rctx: ServerContext) {
  const token = rctx.mcpReq._meta?.progressToken;
  let tick = 0;
  let timer: NodeJS.Timeout | undefined;
  const send = () => {
    if (token === undefined) return;
    tick++;
    const elapsed = Math.round((Date.now() - (job.startedAt ?? job.createdAt)) / 1000);
    rctx.mcpReq.notify({
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

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text' as const, text: `錯誤：${message}` }], isError: true };
}

function jobResult(job: Job): CallToolResult {
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
