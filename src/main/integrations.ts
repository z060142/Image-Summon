import { app } from 'electron';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripBom } from './config';
import { SERVER_NAME } from './mcp';

export function bridgePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bridge', 'bridge.js')
    : path.join(app.getAppPath(), 'bridge', 'bridge.js');
}

// ---------------- Claude Desktop ----------------

export function claudeDesktopConfigPaths(): string[] {
  const out: string[] = [];
  const la = process.env.LOCALAPPDATA;
  // MSIX (Microsoft Store / new installer) virtualizes %APPDATA% into its package folder
  if (la) {
    try {
      for (const d of fs.readdirSync(path.join(la, 'Packages'))) {
        if (/^Claude_/i.test(d)) {
          const dir = path.join(la, 'Packages', d, 'LocalCache', 'Roaming', 'Claude');
          if (fs.existsSync(dir)) out.push(path.join(dir, 'claude_desktop_config.json'));
        }
      }
    } catch { /* ignore */ }
  }
  const ad = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const classic = path.join(ad, 'Claude');
  if (fs.existsSync(classic) || !out.length) out.push(path.join(classic, 'claude_desktop_config.json'));
  return out;
}

export function desktopEntry(mcpUrl: string) {
  return {
    command: process.execPath,
    args: [bridgePath(), mcpUrl],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

function readJson(file: string): any {
  try { return JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))); } catch { return null; }
}

export function claudeDesktopStatus(mcpUrl: string) {
  const want = desktopEntry(mcpUrl);
  return claudeDesktopConfigPaths().map((file) => {
    const cfg = readJson(file);
    const cur = cfg?.mcpServers?.[SERVER_NAME];
    const installed = !!cur;
    const upToDate = installed && cur.command === want.command && JSON.stringify(cur.args) === JSON.stringify(want.args);
    return { file, exists: fs.existsSync(file), installed, upToDate };
  });
}

export function installClaudeDesktop(mcpUrl: string) {
  const results: string[] = [];
  for (const file of claudeDesktopConfigPaths()) {
    let cfg: any = {};
    if (fs.existsSync(file)) {
      const text = stripBom(fs.readFileSync(file, 'utf8'));
      try { cfg = text.trim() ? JSON.parse(text) : {}; } catch {
        throw new Error(`無法解析 ${file}（JSON 格式錯誤），為避免覆蓋已停止。`);
      }
      fs.copyFileSync(file, file + '.image-summon.bak');
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    cfg.mcpServers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
    cfg.mcpServers[SERVER_NAME] = desktopEntry(mcpUrl);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
    results.push(file);
  }
  return results;
}

export function uninstallClaudeDesktop() {
  const results: string[] = [];
  for (const file of claudeDesktopConfigPaths()) {
    const cfg = readJson(file);
    if (cfg?.mcpServers?.[SERVER_NAME]) {
      fs.copyFileSync(file, file + '.image-summon.bak');
      delete cfg.mcpServers[SERVER_NAME];
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
      results.push(file);
    }
  }
  return results;
}

// ---------------- Claude Code ----------------

export function findClaudeCli(): string | null {
  const c: string[] = [path.join(os.homedir(), '.local', 'bin', 'claude.exe')];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) c.push(path.join(dir, 'claude.exe'));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) c.push(path.join(dir, 'claude.cmd'));
  if (process.env.APPDATA) c.push(path.join(process.env.APPDATA, 'npm', 'claude.cmd'));
  return c.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
}

function runCli(exe: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const isCmd = /\.(cmd|bat)$/i.test(exe);
    const file = isCmd ? (process.env.ComSpec || 'cmd.exe') : exe;
    const argv = isCmd ? ['/d', '/s', '/c', [exe, ...args].map((a) => `"${a}"`).join(' ')] : args;
    execFile(file, argv, { windowsHide: true, timeout: 60_000, cwd: os.homedir(), windowsVerbatimArguments: isCmd }, (err, stdout, stderr) => {
      const code = err ? ((err as any).code ?? 1) : 0;
      resolve({ code: typeof code === 'number' ? code : 1, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });
}

export function claudeCodeCommand(mcpUrl: string) {
  return `claude mcp add --transport http --scope user ${SERVER_NAME} ${mcpUrl}`;
}

export async function claudeCodeStatus(mcpUrl: string) {
  const exe = findClaudeCli();
  if (!exe) return { cli: null as string | null, installed: false, upToDate: false, detail: '找不到 claude CLI' };
  const r = await runCli(exe, ['mcp', 'get', SERVER_NAME]);
  const installed = r.code === 0 && !/not found|no mcp server/i.test(r.out);
  return { cli: exe, installed, upToDate: installed && r.out.includes(mcpUrl), detail: r.out.slice(0, 800) };
}

export async function installClaudeCode(mcpUrl: string) {
  const exe = findClaudeCli();
  if (!exe) throw new Error('找不到 claude CLI。請手動執行：' + claudeCodeCommand(mcpUrl));
  await runCli(exe, ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
  const r = await runCli(exe, ['mcp', 'add', '--transport', 'http', '--scope', 'user', SERVER_NAME, mcpUrl]);
  if (r.code !== 0) throw new Error(r.out || 'claude mcp add 失敗');
  return r.out;
}

export async function uninstallClaudeCode() {
  const exe = findClaudeCli();
  if (!exe) throw new Error('找不到 claude CLI');
  const r = await runCli(exe, ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
  return r.out;
}
