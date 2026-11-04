import { shell } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { encryptSecret, settings } from './config';
import { OR_BASE } from './providers/openrouter';
import { HttpHost } from './server';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface Pending {
  verifier: string;
  state: string;
  resolve: (v: { ok: boolean; error?: string }) => void;
  timer: NodeJS.Timeout;
}

let pending: Pending | null = null;
const CALLBACK_PATH = '/oauth/openrouter/callback';

/** Register the OAuth callback on the app's own localhost server (OpenRouter allows localhost on any port). */
export function installOAuthRoute(host: HttpHost) {
  host.route(CALLBACK_PATH, async (req, res, url) => {
    const page = (title: string, msg: string, ok: boolean) => {
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,'Microsoft JhengHei';background:#0f1117;color:#e8e8ef;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:48px">${ok ? '✅' : '⚠️'}</div><h2>${title}</h2><p style="color:#9aa">${msg}</p></div>`);
    };
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!pending) return page('沒有進行中的登入', '請從 Image Summon 設定頁重新點選「使用 OpenRouter 登入」。', false);
    if (!code) { finish({ ok: false, error: '使用者取消或未取得授權碼' }); return page('登入未完成', '沒有收到授權碼。', false); }
    if (state && state !== pending.state) return page('狀態不符', '請重新登入。', false);
    try {
      const r = await fetch(`${OR_BASE}/auth/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: 'S256' }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j.key) throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
      settings.update({ openrouter: { keyEnc: encryptSecret(j.key), keySource: 'oauth' } });
      finish({ ok: true });
      page('OpenRouter 登入成功', '金鑰已安全儲存於本機，可以關閉此分頁回到 Image Summon。', true);
    } catch (e: any) {
      finish({ ok: false, error: e?.message ?? String(e) });
      page('交換金鑰失敗', String(e?.message ?? e), false);
    }
  });
}

function finish(v: { ok: boolean; error?: string }) {
  if (!pending) return;
  clearTimeout(pending.timer);
  const p = pending;
  pending = null;
  p.resolve(v);
}

export function startOpenRouterLogin(port: number): Promise<{ ok: boolean; error?: string }> {
  if (pending) finish({ ok: false, error: '已重新開始登入' });
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  return new Promise((resolve) => {
    pending = { verifier, state, resolve, timer: setTimeout(() => finish({ ok: false, error: '登入逾時（10 分鐘）' }), 10 * 60_000) };
    const cb = `http://localhost:${port}${CALLBACK_PATH}`;
    const u = new URL('https://openrouter.ai/auth');
    u.searchParams.set('callback_url', cb);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', state);
    u.searchParams.set('key_label', 'Image Summon');
    shell.openExternal(u.toString());
  });
}

export function cancelOpenRouterLogin() {
  finish({ ok: false, error: '已取消' });
}
