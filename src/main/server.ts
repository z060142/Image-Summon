import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { createMcpServer, McpContext } from './mcp';
import { currentCapabilities, jobs } from './jobs';

type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void | Promise<void>;

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  client?: string;
  lastSeen: number;
}

export class HttpHost extends EventEmitter {
  private http?: http.Server;
  private sessions = new Map<string, Session>();
  private routes = new Map<string, RouteHandler>();
  private reaper?: NodeJS.Timeout;
  port = 0;

  constructor(private ctx: Omit<McpContext, 'serverUrl'>) {
    super();
  }

  get mcpUrl() {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  route(pathname: string, handler: RouteHandler) {
    this.routes.set(pathname, handler);
  }

  clients() {
    return [...this.sessions.entries()].map(([id, s]) => ({ id, client: s.client ?? '(未知)', lastSeen: s.lastSeen }));
  }

  async start(port: number): Promise<void> {
    await this.stop();
    this.port = port;
    const srv = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        console.error('[http] error', e);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(e?.message ?? e) }, id: null }));
        }
      });
    });
    srv.requestTimeout = 0; // generations can be long
    srv.headersTimeout = 60_000;
    srv.keepAliveTimeout = 65_000;
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => { srv.off('error', reject); resolve(); });
    });
    this.http = srv;
    this.reaper = setInterval(() => this.reap(), 10 * 60_000);
    this.emit('clients');
  }

  async stop() {
    clearInterval(this.reaper);
    for (const [id, s] of this.sessions) {
      try { await s.transport.close(); } catch { /* ignore */ }
      this.sessions.delete(id);
    }
    if (this.http) {
      const h = this.http;
      this.http = undefined;
      await new Promise<void>((r) => { h.close(() => r()); h.closeAllConnections?.(); });
    }
  }

  /** Tell every connected agent that the tool schema changed (mode/model switched). */
  async broadcastToolsChanged() {
    for (const s of this.sessions.values()) {
      try {
        await s.server.sendToolListChanged();
        await s.server.sendResourceListChanged();
      } catch { /* client may not have a GET stream open */ }
    }
  }

  private reap() {
    const cutoff = Date.now() - 24 * 3600_000;
    for (const [id, s] of this.sessions) {
      if (s.lastSeen < cutoff) {
        s.transport.close().catch(() => {});
        this.sessions.delete(id);
      }
    }
    this.emit('clients');
  }

  private hostAllowed(req: http.IncomingMessage): boolean {
    const host = (req.headers.host ?? '').toLowerCase();
    const okHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
    if (!okHosts.includes(host)) return false;
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      try {
        const o = new URL(origin);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(o.hostname)) return false;
      } catch { return false; }
    }
    return true;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    if (!this.hostAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden host/origin');
      return;
    }

    if (url.pathname === '/health') {
      const c = currentCapabilities();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'image-summon', version: this.ctx.version, mode: c.mode, model: c.model, ready: c.ready, active_jobs: jobs.activeCount }));
      return;
    }

    const custom = this.routes.get(url.pathname);
    if (custom) { await custom(req, res, url); return; }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    await this.handleMcp(req, res);
  }

  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let body: unknown;
    if (req.method === 'POST') {
      const raw = await readBody(req, 64 * 1024 * 1024);
      try { body = JSON.parse(raw); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
        return;
      }
    }

    let session = sid ? this.sessions.get(sid) : undefined;
    if (sid && !session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
      return;
    }

    if (!session) {
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: missing session or not an initialize request' }, id: null }));
        return;
      }
      const server = createMcpServer({ ...this.ctx, serverUrl: () => this.mcpUrl });
      const clientInfo = (body as any)?.params?.clientInfo;
      const fresh: Session = {
        server,
        client: clientInfo ? `${clientInfo.title ?? clientInfo.name} ${clientInfo.version ?? ''}`.trim() : undefined,
        lastSeen: Date.now(),
        transport: new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { this.sessions.set(id, fresh); this.emit('clients'); },
          onsessionclosed: (id) => { this.sessions.delete(id); this.emit('clients'); },
        }),
      };
      fresh.transport.onclose = () => {
        const id = fresh.transport.sessionId;
        if (id && this.sessions.get(id) === fresh) { this.sessions.delete(id); this.emit('clients'); }
      };
      await server.connect(fresh.transport);
      session = fresh;
    }
    session.lastSeen = Date.now();
    await session.transport.handleRequest(req, res, body);
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
