#!/usr/bin/env node
/*
 * Image Summon stdio bridge
 * -------------------------
 * Claude Desktop launches local MCP servers over stdio. This tiny dependency-free
 * script relays stdio JSON-RPC <-> the tray app's Streamable HTTP endpoint, so every
 * agent talks to the same always-running Image Summon instance.
 *
 *   ImageSummon.exe bridge.js [http://127.0.0.1:47821/mcp]   (with ELECTRON_RUN_AS_NODE=1)
 *   node bridge.js [url]
 *
 * - Keeps Mcp-Session-Id / MCP-Protocol-Version headers.
 * - Parses JSON or SSE responses; opens the GET SSE stream for server notifications
 *   (tools/list_changed when the user switches generator).
 * - If the tray app was restarted (session 404), transparently re-initializes.
 */
'use strict';

const URL_ = process.argv[2] || process.env.IMAGE_SUMMON_URL || 'http://127.0.0.1:47821/mcp';
const log = (...a) => process.stderr.write('[image-summon-bridge] ' + a.join(' ') + '\n');

let sessionId = null;
let protocolVersion = null;
let initRequest = null; // cached for silent re-init
let initializedSeen = false;
let sseCtrl = null;
let closing = false;
let initGate = null; // promise resolved after initialize round-trip

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function errorFor(msg, message, code = -32000) {
  if (msg && msg.id !== undefined && msg.id !== null) write({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
}

function headers(extra) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra };
  if (sessionId) h['Mcp-Session-Id'] = sessionId;
  if (protocolVersion) h['MCP-Protocol-Version'] = protocolVersion;
  return h;
}

async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield data;
    }
  }
}

function emitPayload(text, sink) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return; }
  for (const m of Array.isArray(parsed) ? parsed : [parsed]) sink(m);
}

/** POST one message; returns server messages via sink. */
async function post(msg, sink = write, allowReinit = true) {
  let res;
  try {
    res = await fetch(URL_, { method: 'POST', headers: headers(), body: JSON.stringify(msg) });
  } catch (e) {
    errorFor(msg, `Image Summon 沒有在執行（${URL_}）。請從開始功能表啟動 Image Summon。`);
    return;
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  if (res.status === 404 && sessionId && allowReinit && msg.method !== 'initialize') {
    log('session expired, re-initializing');
    sessionId = null;
    if (await reinit()) return post(msg, sink, false);
    errorFor(msg, 'Image Summon 工作階段重建失敗');
    return;
  }
  if (res.status === 202 || res.status === 204) return;

  const ct = res.headers.get('content-type') || '';
  if (!res.ok && !ct.includes('json') && !ct.includes('event-stream')) {
    errorFor(msg, `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return;
  }
  if (ct.includes('text/event-stream')) {
    for await (const data of sseEvents(res.body)) emitPayload(data, sink);
  } else {
    const text = await res.text();
    if (text) emitPayload(text, sink);
  }
}

async function reinit() {
  if (!initRequest) return false;
  let ok = false;
  await post({ ...initRequest, id: '__bridge_reinit__' }, (m) => {
    if (m.id === '__bridge_reinit__' && m.result) { ok = true; protocolVersion = m.result.protocolVersion || protocolVersion; }
  }, false);
  if (!ok) return false;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, write, false);
  startSse();
  return true;
}

async function startSse() {
  if (sseCtrl) sseCtrl.abort();
  const ctrl = new AbortController();
  sseCtrl = ctrl;
  while (!closing && !ctrl.signal.aborted) {
    try {
      const h = headers({ Accept: 'text/event-stream' });
      delete h['Content-Type'];
      const res = await fetch(URL_, { method: 'GET', headers: h, signal: ctrl.signal });
      if (res.status === 405) return; // server doesn't offer a standalone stream
      if (res.status === 404 && sessionId) { sessionId = null; await reinit(); return; }
      if (res.ok && res.body) for await (const data of sseEvents(res.body)) emitPayload(data, write);
    } catch (e) {
      if (ctrl.signal.aborted || closing) return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function handle(msg) {
  if (msg.method === 'initialize') {
    initRequest = msg;
    let release;
    initGate = new Promise((r) => (release = r));
    await post(msg, (m) => {
      if (m.id === msg.id && m.result && m.result.protocolVersion) protocolVersion = m.result.protocolVersion;
      write(m);
    });
    release();
    return;
  }
  if (initGate) await initGate;
  await post(msg);
  if (msg.method === 'notifications/initialized' && !initializedSeen) {
    initializedSeen = true;
    startSse();
  }
}

// ---- stdin line reader (newline-delimited JSON-RPC) ----
let inBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inBuf += chunk;
  let nl;
  while ((nl = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, nl).trim();
    inBuf = inBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('bad json from client'); continue; }
    handle(msg).catch((e) => { log('error', e && e.stack || e); errorFor(msg, String(e && e.message || e)); });
  }
});

async function shutdown() {
  if (closing) return;
  closing = true;
  if (sseCtrl) sseCtrl.abort();
  if (sessionId) {
    try { await fetch(URL_, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(1500) }); } catch { /* ignore */ }
  }
  process.exit(0);
}
process.stdin.on('end', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
