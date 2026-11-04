import { spawn, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { settings } from '../config';
import { GenImage, GenRequest, GenResult, Provider, ProviderError, sniffMime } from './common';

const IMG_RE = /\.(png|jpe?g|webp)$/i;

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Find the codex executable: explicit setting → known install dirs → PATH. */
export function detectCodex(): string | null {
  const configured = settings.get().codex.path.trim();
  if (configured) return fs.existsSync(configured) ? configured : null;
  const candidates: string[] = [];
  const la = process.env.LOCALAPPDATA;
  if (la) candidates.push(path.join(la, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, 'codex.exe'));
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, 'codex.cmd'));
  }
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'codex.cmd'));
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) ?? null;
}

function spawnCodex(exe: string, args: string[], opts: { cwd?: string }) {
  const isCmd = /\.(cmd|bat)$/i.test(exe);
  if (isCmd) {
    // .cmd shims require a shell; arguments here are paths/flags only (the prompt goes through stdin).
    const quoted = [exe, ...args].map((a) => `"${a.replace(/"/g, '""')}"`).join(' ');
    return spawn(quoted, { shell: true, cwd: opts.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return spawn(exe, args, { cwd: opts.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

export async function codexStatus(): Promise<{ found: boolean; path?: string; version?: string; login?: string; ok: boolean }> {
  const exe = detectCodex();
  if (!exe) return { found: false, ok: false };
  const run = (args: string[]) => new Promise<string>((resolve) => {
    const p = spawnCodex(exe, args, {});
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.stdin.end();
    const t = setTimeout(() => killTree(p.pid), 15_000);
    p.on('close', () => { clearTimeout(t); resolve(out.trim()); });
    p.on('error', (e) => { clearTimeout(t); resolve(String(e)); });
  });
  const version = await run(['--version']);
  const login = await run(['login', 'status']);
  return { found: true, path: exe, version, login, ok: /logged in/i.test(login) };
}

function killTree(pid?: number) {
  if (!pid) return;
  try { execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* ignore */ }
}

function listImagesSince(dir: string, since: number): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && IMG_RE.test(e.name)) {
        try { if (fs.statSync(p).mtimeMs >= since) out.push(p); } catch { /* ignore */ }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

export class CodexProvider implements Provider {
  id = 'codex';

  async generate(req: GenRequest): Promise<GenResult> {
    const cfg = settings.get().codex;
    const exe = detectCodex();
    if (!exe) throw new ProviderError('找不到 codex 可執行檔，請安裝 Codex CLI 或在設定頁指定路徑');

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'image-summon-codex-'));
    // Reference images must be files for `codex exec -i`.
    const imagePaths: string[] = [];
    req.inputImages.forEach((img, i) => {
      if (img.path && fs.existsSync(img.path)) imagePaths.push(img.path);
      else {
        const p = path.join(work, `ref-${i}.${img.mime.split('/')[1] || 'png'}`);
        fs.writeFileSync(p, img.data);
        imagePaths.push(p);
      }
    });

    const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--json', '-C', work];
    if (cfg.model.trim()) args.push('-m', cfg.model.trim());
    if (cfg.extraArgs.trim()) args.push(...splitArgs(cfg.extraArgs));
    for (const p of imagePaths) args.push('-i', p);
    args.push('--color', 'never', '-'); // prompt via stdin: no quoting / length issues on Windows

    const n = Math.max(1, req.n);
    const prompt = [
      `$imagegen ${req.prompt}`,
      '',
      n > 1 ? `Generate ${n} separate images.` : 'Generate exactly one image.',
      imagePaths.length ? 'Use the attached image(s) as reference input.' : '',
      'Do not run shell commands or modify files. When finished, reply with the absolute path(s) of the generated image file(s).',
    ].filter(Boolean).join('\n');

    const started = Date.now() - 2000;
    const genDir = path.join(codexHome(), 'generated_images');
    req.onProgress('Codex 啟動中');

    const { threadId, log, finalText } = await new Promise<{ threadId?: string; log: string; finalText: string }>((resolve, reject) => {
      const child = spawnCodex(exe, args, { cwd: work });
      let threadId: string | undefined;
      let buf = '';
      let log = '';
      let finalText = '';
      const timeout = setTimeout(() => { killTree(child.pid); reject(new ProviderError(`Codex 逾時（${cfg.timeoutSec}s）`)); }, cfg.timeoutSec * 1000);
      const onAbort = () => { killTree(child.pid); reject(new ProviderError('已取消')); };
      req.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buf += chunk;
        log += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'thread.started' && ev.thread_id) threadId = ev.thread_id;
            if (ev.type === 'turn.started') req.onProgress('Codex 正在生成圖片');
            const item = ev.item;
            if (item?.type === 'agent_message' && typeof item.text === 'string') finalText = item.text;
            if (item?.type && /image/i.test(item.type)) req.onProgress('Codex 圖片處理中');
            if (ev.type === 'turn.failed' || ev.type === 'error') log += `\n[codex error] ${JSON.stringify(ev.error ?? ev)}`;
          } catch { /* not json */ }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => { log += d; });
      child.on('error', (e) => { clearTimeout(timeout); reject(new ProviderError('無法啟動 codex：' + e.message)); });
      child.on('close', (code) => {
        clearTimeout(timeout);
        req.signal.removeEventListener('abort', onAbort);
        if (req.signal.aborted) return;
        if (code !== 0) {
          reject(new ProviderError(`codex 結束碼 ${code}`, undefined, log.slice(-3000)));
          return;
        }
        resolve({ threadId, log, finalText });
      });
      child.stdin.end(prompt, 'utf8');
    });

    // Locate output: 1) the thread's generated_images dir 2) absolute paths printed 3) any new file since start.
    let files: string[] = [];
    if (threadId) files = listImagesSince(path.join(genDir, threadId), 0);
    if (!files.length) {
      const re = /[A-Za-z]:[\\/][^"'\s<>|]*?\.(?:png|jpe?g|webp)/gi;
      const found = new Set<string>();
      for (const m of (log + '\n' + finalText).matchAll(re)) {
        const p = m[0].replace(/\\\\/g, '\\');
        if (fs.existsSync(p) && fs.statSync(p).mtimeMs >= started && !p.startsWith(work)) found.add(p);
      }
      files = [...found];
    }
    if (!files.length) files = listImagesSince(genDir, started);
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
    if (!files.length) throw new ProviderError('codex 執行完成但找不到生成的圖片', undefined, (finalText + '\n' + log).slice(-3000));

    const images: GenImage[] = files.slice(-n).map((f) => {
      const data = fs.readFileSync(f);
      return { data, mime: sniffMime(data) };
    });
    return { images, model: cfg.model.trim() ? `codex (${cfg.model.trim()})` : 'codex imagegen', text: finalText };
  }
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2]);
  return out;
}
