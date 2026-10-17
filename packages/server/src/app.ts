import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_PORT, type ClientMessage, type ServerMessage, type SessionSummary } from '@workstation/protocol';
import { Catalog } from './catalog.js';
import { ConfigStore } from './config.js';
import { HttpError, listDir, readFile, requireDir, resolveUserPath, searchFiles } from './files.js';
import { gitDiff, gitStatus } from './git.js';
import { createAdapter, type SdkAdapter } from './sdk.js';
import { extractBearer, isHostAllowed, isOriginAllowed, securityOptionsFromEnv, tokenMatches, type SecurityOptions } from './security.js';
import { createTerminalService } from './terminal.js';
import { SessionManager, type Subscriber } from './session-manager.js';

export const VERSION = '0.1.0';

export interface ServerOptions {
  host?: string;
  port?: number;
  /** cwd reported to clients as the default project (CLI --cwd) */
  cwd?: string;
  config?: ConfigStore;
  adapter?: SdkAdapter;
  webDist?: string | null;
  security?: SecurityOptions;
  mock?: boolean;
}

export interface RunningServer {
  server: Server;
  host: string;
  port: number;
  config: ConfigStore;
  sessions: SessionManager;
  url: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
};

export function defaultWebDist(): string | null {
  const here = path.dirname(new URL(import.meta.url).pathname);
  for (const c of [process.env.WORKSTATION_WEB_DIST, path.resolve(here, '../../web/dist'), path.resolve(here, '../web')]) {
    if (c && fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

function uuidish(s: string) { return /^[A-Za-z0-9_-]{1,100}$/.test(s); }

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  const config = opts.config ?? new ConfigStore();
  const adapter = opts.adapter ?? createAdapter(opts.mock);
  const serverCwd = opts.cwd ?? process.cwd();
  const sessions = new SessionManager(adapter, config, serverCwd);
  const catalog = new Catalog(adapter, config, sessions, serverCwd);
  const security = opts.security ?? securityOptionsFromEnv(host);
  const webDist = opts.webDist === undefined ? defaultWebDist() : opts.webDist;

  const app = new Hono();

  // ── Host + Origin check on everything (DNS rebinding / CSRF) ──
  app.use('*', async (c, next) => {
    if (!isHostAllowed(c.req.header('host'), security)) return c.json({ error: 'forbidden host' }, 403);
    if (!isOriginAllowed(c.req.header('origin'), c.req.header('host'), security)) return c.json({ error: 'forbidden origin' }, 403);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    await next();
  });

  // ── Bearer token on /api ──
  app.use('/api/*', async (c, next) => {
    if (!tokenMatches(extractBearer(c.req.header('authorization')), config.token)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return c.json({ error: 'not found' }, 404);
    if (code === 'EACCES') return c.json({ error: 'permission denied' }, 403);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  const q = (c: { req: { query(k: string): string | undefined } }, k: string): unknown => c.req.query(k);
  const cwdParam = (c: { req: { query(k: string): string | undefined } }) => requireDir(q(c, 'cwd') ?? serverCwd);

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION, mock: adapter.mock, cwd: serverCwd, sessions: sessions.list().length }));

  app.get('/api/config', (c) => c.json(config.redacted()));
  app.put('/api/config', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new HttpError(400, 'invalid JSON'); }
    try { config.update(body); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
    return c.json(config.redacted());
  });

  // ── sessions ──
  app.get('/api/sessions', async (c) => {
    const cwdQ = c.req.query('cwd');
    const dir = cwdQ ? await requireDir(cwdQ) : undefined;
    const stored = await adapter.listSessions({ ...(dir ? { dir } : {}), limit: 500 }).catch(() => []);
    const out = new Map<string, SessionSummary>();
    for (const s of stored) {
      out.set(s.sessionId, {
        sessionId: s.sessionId, title: s.customTitle || s.summary || s.firstPrompt || 'Untitled', cwd: s.cwd, gitBranch: s.gitBranch,
        lastModified: s.lastModified, createdAt: (s as { createdAt?: number }).createdAt, live: sessions.isLive(s.sessionId), tag: s.tag,
      });
    }
    for (const l of sessions.list()) {
      if (out.has(l.id) || (dir && l.cwd !== dir)) continue;
      out.set(l.id, { sessionId: l.id, title: l.title || 'New session', cwd: l.cwd, lastModified: l.createdAt, createdAt: l.createdAt, live: true });
    }
    return c.json([...out.values()].sort((a, b) => b.lastModified - a.lastModified));
  });
  app.get('/api/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    if (!uuidish(id)) throw new HttpError(400, 'invalid session id');
    const cwdQ = c.req.query('cwd');
    const dir = cwdQ ? await requireDir(cwdQ) : undefined;
    const messages = await adapter.getSessionMessages(id, dir ? { dir } : undefined).catch((e) => {
      if (sessions.isLive(id)) return [];
      throw new HttpError(404, e instanceof Error ? e.message : 'session not found');
    });
    return c.json({ messages });
  });
  app.patch('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    if (!uuidish(id)) throw new HttpError(400, 'invalid session id');
    const body = (await c.req.json().catch(() => null)) as { title?: unknown } | null;
    if (!body || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 500) throw new HttpError(400, 'title (non-empty string) required');
    const cwdQ = c.req.query('cwd');
    await adapter.renameSession(id, body.title.trim(), cwdQ ? { dir: await requireDir(cwdQ) } : undefined);
    const live = sessions.get(id);
    if (live) live.title = body.title.trim();
    return c.json({ ok: true });
  });
  app.delete('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    if (!uuidish(id)) throw new HttpError(400, 'invalid session id');
    const live = sessions.get(id);
    if (live) sessions.close(live, 'deleted');
    const cwdQ = c.req.query('cwd');
    await adapter.deleteSession(id, cwdQ ? { dir: await requireDir(cwdQ) } : undefined).catch((e) => {
      if (!live) throw new HttpError(404, e instanceof Error ? e.message : 'session not found');
    });
    return c.json({ ok: true });
  });

  app.get('/api/models', async (c) => c.json(await catalog.getModels()));
  app.get('/api/commands', async (c) => c.json(await catalog.getCommands(await cwdParam(c))));

  // ── files / git ──
  app.get('/api/fs/list', async (c) => c.json(await listDir(q(c, 'path') ?? '~')));
  app.get('/api/fs/read', async (c) => c.json(await readFile(q(c, 'path'))));
  app.get('/api/files/search', async (c) => {
    const text = c.req.query('q') ?? '';
    if (text.length > 200) throw new HttpError(400, 'query too long');
    return c.json(await searchFiles(await cwdParam(c), text));
  });
  app.get('/api/git/status', async (c) => c.json(await gitStatus(await cwdParam(c))));
  app.get('/api/git/diff', async (c) => {
    const p = c.req.query('path');
    if (p !== undefined && (p.includes('\0') || p.length > 4096)) throw new HttpError(400, 'invalid path');
    return c.json({ diff: await gitDiff(await cwdParam(c), p) });
  });

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));
  app.get('/ws', (c) => c.text('WebSocket endpoint', 426));

  // ── static SPA ──
  if (webDist) {
    const root = path.resolve(webDist);
    app.get('*', async (c) => {
      const url = new URL(c.req.url);
      let rel: string;
      try { rel = decodeURIComponent(url.pathname); } catch { return c.text('bad request', 400); }
      if (rel.includes('\0')) return c.text('bad request', 400);
      let file = path.join(root, rel);
      if (file !== root && !file.startsWith(root + path.sep)) return c.text('forbidden', 403);
      let st = await fsp.stat(file).catch(() => null);
      if (st?.isDirectory()) { file = path.join(file, 'index.html'); st = await fsp.stat(file).catch(() => null); }
      const isAsset = path.extname(rel) !== '';
      if (!st?.isFile()) {
        if (isAsset) return c.text('not found', 404);
        file = path.join(root, 'index.html'); // SPA fallback
      }
      const ext = path.extname(file).toLowerCase();
      const body = await fsp.readFile(file);
      c.header('Content-Type', MIME[ext] ?? 'application/octet-stream');
      c.header('Cache-Control', ext === '.html' ? 'no-store' : 'public, max-age=3600');
      return c.body(body);
    });
  } else {
    app.get('/', (c) => c.text('The Workstation server is running. Web UI not built (run `npm run build -w @workstation/web`).'));
  }

  // ── HTTP + WS ──
  const server = serve({ fetch: app.fetch, hostname: host, port: opts.port ?? DEFAULT_PORT }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? DEFAULT_PORT;

  const terminals = createTerminalService({ security, token: () => config.token, defaultCwd: serverCwd });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const reject = (socket: Duplex, code: number, text: string) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://x'); } catch { return reject(socket, 400, 'Bad Request'); }
    if (url.pathname === '/ws/terminal') return terminals.upgrade(req, socket, head, url);
    if (url.pathname !== '/ws') return reject(socket, 404, 'Not Found');
    if (!isHostAllowed(req.headers.host, security)) return reject(socket, 403, 'Forbidden');
    if (!isOriginAllowed(req.headers.origin, req.headers.host, security)) return reject(socket, 403, 'Forbidden');
    const token = url.searchParams.get('token') ?? extractBearer(req.headers.authorization);
    if (!tokenMatches(token, config.token)) return reject(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function onConnection(ws: WebSocket) {
    const sub: Subscriber = {
      id: randomUUID(),
      send(msg: ServerMessage) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
    };
    sub.send({ type: 'hello', version: VERSION, serverCwd, mock: adapter.mock });
    // Serialise per-connection so ordering of client messages is preserved.
    let chain: Promise<void> = Promise.resolve();
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(data.toString()) as ClientMessage; } catch { sub.send({ type: 'error', message: 'invalid JSON' }); return; }
      if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') { sub.send({ type: 'error', message: 'invalid message' }); return; }
      // permission responses and interrupts must not queue behind slow operations
      if (msg.type === 'permission.respond' || msg.type === 'interrupt' || msg.type === 'ping') void sessions.handle(sub, msg);
      else chain = chain.then(() => sessions.handle(sub, msg)).catch(() => {});
    });
    const cleanup = () => sessions.detach(sub);
    ws.on('close', cleanup);
    ws.on('error', cleanup);
    const ka = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 30_000);
    ws.on('close', () => clearInterval(ka));
  }

  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return {
    server, host, port, config, sessions,
    url: `http://${shownHost}:${port}/?token=${config.token}`,
    close: async () => {
      sessions.closeAll();
      terminals.closeAll();
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
