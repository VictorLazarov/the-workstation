// MINOR items of scrutiniser pass 1: REST body cap, WS frame cap, sanitized 5xx, security headers on the SPA.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer } from '../src/app.js';
import { ConfigStore } from '../src/config.js';
import { createMockAdapter } from '../src/mock.js';
import { api, connect, type TestServer } from './helpers.js';

let s: TestServer;
const INLINE = "\n      try { document.documentElement.dataset.x = '1'; } catch (e) {}\n    ";
beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-hard-'));
  const cwd = path.join(dir, 'proj');
  const web = path.join(dir, 'web');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(web);
  fs.writeFileSync(path.join(web, 'index.html'), `<!doctype html><html><head><script>${INLINE}</script></head><body><script type="module" src="/a.js"></script></body></html>`);
  fs.writeFileSync(path.join(web, 'a.js'), 'console.log(1)');
  const inner = createMockAdapter();
  const adapter = { ...inner, mock: true, query: inner.query.bind(inner), listSessions: inner.listSessions.bind(inner), getSessionMessages: inner.getSessionMessages.bind(inner), deleteSession: inner.deleteSession.bind(inner),
    renameSession: async () => { throw new Error('EBOOM at /home/secret-user/private/path: git stderr'); } };
  const config = new ConfigStore(path.join(dir, 'home'));
  const r = await startServer({ host: '127.0.0.1', port: 0, config, adapter, cwd, webDist: web });
  s = Object.assign(r, { base: `http://127.0.0.1:${r.port}`, token: config.token, dir, cwd }) as TestServer;
});
afterAll(async () => { await s.close(); });

describe('hardening', () => {
  it('REST bodies over 2 MB get 413', async () => {
    const big = JSON.stringify({ customModels: ['x'.repeat(3 * 1024 * 1024)] });
    // The server rejects on Content-Length and closes without reading the upload. HTTP allows the client to see that as the 413
    // or, if the close lands while it is still sending (Windows resets the socket), as a connection error: either way the body is refused.
    const r = await api(s, '/api/config', { method: 'PUT', body: big }).catch((e: { cause?: { code?: string } }) => e);
    if ('status' in r) expect(r.status).toBe(413);
    else expect(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']).toContain((r as { cause?: { code?: string } }).cause?.code);
    const cfg = await (await api(s, '/api/config')).json() as { customModels?: string[] };
    expect(JSON.stringify(cfg.customModels ?? [])).not.toContain('xxxxxxxx');
    const ok = await api(s, '/api/config', { method: 'PUT', body: JSON.stringify({ customModels: ['m'] }) });
    expect(ok.status).toBe(200);
  });

  it('a WS frame over 16 MB closes only that socket; a ~10 MB image prompt is accepted', async () => {
    const a = await connect(s);
    const b = await connect(s);
    const closed = new Promise<number>((r) => a.ws.once('close', (code) => r(code)));
    a.ws.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(17 * 1024 * 1024) }));
    expect(await closed).toBe(1009);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    // a big but legal frame passes the cap (the session layer then answers normally)
    b.send({ type: 'prompt', sessionId: 'nope', text: 'x', clientMsgId: 'c', images: [{ mediaType: 'image/png', dataBase64: 'A'.repeat(10 * 1024 * 1024), name: 'i.png' }] } as never);
    const err = await b.waitFor((m) => m.type === 'error');
    expect((err as { message: string }).message).toMatch(/no live session/);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    b.close();
  });

  it('5xx responses carry a generic message and a request id, not internals', async () => {
    const r = await api(s, '/api/sessions/abc', { method: 'PATCH', body: JSON.stringify({ title: 't' }) });
    expect(r.status).toBe(500);
    const body = await r.json() as { error: string; requestId: string };
    expect(body.requestId).toMatch(/^[0-9a-f]{8}$/);
    expect(body.error).not.toContain('secret-user');
    expect(body.error).toContain(body.requestId);
  });

  it('the SPA is served with CSP (hash of the inline script), frame-ancestors none, XFO and nosniff', async () => {
    const r = await fetch(`${s.base}/`);
    const csp = r.headers.get('content-security-policy') ?? '';
    const hash = createHash('sha256').update(INLINE, 'utf8').digest('base64');
    expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(`${s.base}/some/route`)).headers.get('content-security-policy')).toBe(csp); // SPA fallback too
  });
});
