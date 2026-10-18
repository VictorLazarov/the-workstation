import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LogEntry, LogsResponse, ServerMessage } from '@workstation/protocol';
import { log } from '../src/log.js';
import { api, connect, makeServer, raw, startSession, type TestServer } from './helpers.js';

const FAKE_KEY = 'sk-ant-api03-FAKEKEYFAKEKEYFAKEKEY0123456789';
const FAKE_TOKEN = 'gw-auth-token-ZZZZ9999YYYY8888';

let s: TestServer;
beforeAll(async () => { s = await makeServer(); });
afterAll(async () => { await s.close(); });

const logs = async (qs = ''): Promise<LogsResponse> => (await api(s, `/api/logs${qs}`)).json() as Promise<LogsResponse>;
const until = async <T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 5000): Promise<T> => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); }
};

describe('log endpoints need the access token', () => {
  const routes: Array<[string, string]> = [['GET', '/api/logs'], ['GET', '/api/logs/download'], ['POST', '/api/logs/clear'], ['GET', '/api/logs/debug-info']];
  for (const [method, p] of routes) {
    it(`${method} ${p}: 401 without a token, 401 with a wrong one`, async () => {
      expect((await api(s, p, { method }, null)).status).toBe(401);
      expect((await api(s, p, { method }, 'not-the-token')).status).toBe(401);
    });
  }
  it('the unauthorised attempt is itself logged (route and status, no token)', async () => {
    await api(s, '/api/logs', {}, 'a-wrong-token-1234567890');
    const r = await logs('?source=http&level=warn&q=401');
    const e = r.entries.find((x) => x.message.includes('GET /api/logs -> 401'));
    expect(e).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain('a-wrong-token');
  });
});

describe('GET /api/logs', () => {
  it('reports server start with the log file in the config dir', async () => {
    const r = await logs();
    expect(r.capacity).toBe(5000);
    expect(r.file).toBe(path.join(s.dir, 'home', 'logs', 'server.log'));
    const start = r.entries.find((e) => e.message.startsWith('Server listening'));
    expect(start).toMatchObject({ level: 'info', source: 'server' });
    expect(r.entries.some((e) => e.source === 'config' && e.message === 'Config loaded')).toBe(true);
    expect(fs.readFileSync(r.file!, 'utf8')).toContain('Server listening');
    if (process.platform !== 'win32') expect(fs.statSync(r.file!).mode & 0o777).toBe(0o600);
  });

  it('logs every WebSocket connect and disconnect, never with the token', async () => {
    const c = await connect(s);
    c.close();
    await until(async () => (await logs('?q=WebSocket disconnected')).entries.length > 0);
    const r = await logs('?source=http');
    expect(r.entries.some((e) => e.message === 'WebSocket connected')).toBe(true);
    expect(r.entries.some((e) => e.message === 'WebSocket disconnected')).toBe(true);
    expect(JSON.stringify(await logs('?limit=5000'))).not.toContain(s.token);
    const bad = await connect(s, { token: 'nope' }).then(() => false, () => true);
    expect(bad).toBe(true);
    expect((await logs('?q=WebSocket refused')).entries[0]).toMatchObject({ level: 'warn', source: 'http' });
  });

  it('REST failures are logged with route and status but without query strings', async () => {
    expect((await api(s, '/api/sessions/bad!id/messages?secret=zzz-should-not-appear')).status).toBe(400);
    const e = (await logs('?q=-> 400')).entries.find((x) => x.detail?.route === '/api/sessions/bad!id/messages');
    expect(e).toMatchObject({ level: 'warn', source: 'http', detail: { status: 400, method: 'GET' } });
    expect(JSON.stringify(await logs('?limit=5000'))).not.toContain('zzz-should-not-appear');
  });

  it('filters by level, source, text and since; limit keeps the newest', async () => {
    log.info('git', 'marker-alpha');
    log.error('terminal', 'marker-beta');
    const all = await logs('?q=marker-');
    expect(all.entries.map((e) => e.message)).toEqual(['marker-alpha', 'marker-beta']);
    expect((await logs('?q=marker-&level=error')).entries.map((e) => e.message)).toEqual(['marker-beta']);
    expect((await logs('?q=marker-&source=git')).entries.map((e) => e.message)).toEqual(['marker-alpha']);
    const a = all.entries[0]!;
    expect((await logs(`?since=${a.seq}&q=marker-`)).entries.map((e) => e.message)).toEqual(['marker-beta']);
    expect((await logs('?q=marker-&limit=1')).entries.map((e) => e.message)).toEqual(['marker-beta']);
    expect((await logs('?q=marker-&limit=1')).total).toBe(2);
  });
});

describe('what the mock agent does lands in the log with the right level and source', () => {
  it('"error" produces an sdk error entry for that session; filtering by session isolates it', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    const other = await startSession(c, s.cwd);
    c.send({ type: 'prompt', sessionId: sid, text: 'error please', clientMsgId: 'c1' });
    await c.waitFor((m) => m.type === 'sdk' && m.sessionId === sid && (m.message as { type?: string }).type === 'result');
    const r = await logs(`?sessionId=${sid}&level=error`);
    const e = r.entries.find((x) => x.source === 'sdk');
    expect(e).toMatchObject({ level: 'error', source: 'sdk', sessionId: sid });
    expect(e!.message).toMatch(/Turn ended with an error/);
    expect(r.entries.every((x) => x.sessionId === sid)).toBe(true);
    expect((await logs(`?sessionId=${other}&level=error`)).entries).toEqual([]);
    // lifecycle for that session
    const life = (await logs(`?sessionId=${sid}&source=session`)).entries.map((x) => x.message);
    expect(life).toContain('Session started');
    c.send({ type: 'session.close', sessionId: sid });
    await until(async () => (await logs(`?sessionId=${sid}&source=session&q=closed`)).entries.length > 0);
    c.close();
  });

  it('"401" logs the retry (status 401) and the error shown to the user', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    c.send({ type: 'prompt', sessionId: sid, text: 'hit a 401 now', clientMsgId: 'c2' });
    await c.waitFor((m) => m.type === 'error' && m.sessionId === sid);
    const es = (await logs(`?sessionId=${sid}`)).entries;
    const retry = es.find((e) => e.source === 'sdk' && e.level === 'warn');
    expect(retry!.detail).toMatchObject({ code: 'authentication_failed', status: 401 });
    expect(es.find((e) => e.source === 'sdk' && e.level === 'error')!.detail).toMatchObject({ code: 'authentication_failed' });
    expect(es.find((e) => e.source === 'session' && e.level === 'error')!.detail).toMatchObject({ code: 'authentication_failed', shownToUser: true });
    c.close();
  });

  it('permission requests and decisions are logged by tool name only', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    c.send({ type: 'prompt', sessionId: sid, text: 'bash please', clientMsgId: 'c3' });
    const req = await c.waitFor<Extract<ServerMessage, { type: 'permission.request' }>>((m) => m.type === 'permission.request' && m.sessionId === sid);
    c.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'allow' } });
    await c.waitFor((m) => m.type === 'sdk' && m.sessionId === sid && (m.message as { type?: string }).type === 'result');
    const ps = (await logs(`?sessionId=${sid}&source=permission`)).entries;
    expect(ps.map((e) => e.message)).toEqual([`Permission requested: ${req.toolName}`, `Permission allowed: ${req.toolName}`]);
    const text = JSON.stringify(ps);
    expect(text).not.toContain(JSON.stringify(req.input).slice(1, 20));
    c.close();
  });
});

describe('secrets never reach the log, the file or the download', () => {
  it('a configured key/token and the access token are removed from every output, even inside error text', async () => {
    expect((await api(s, '/api/config', { method: 'PUT', body: JSON.stringify({ apiKey: FAKE_KEY, authToken: FAKE_TOKEN, anthropicBaseUrl: 'https://user:pw@gw.example.com/v1?key=urlsecret987' }) })).status).toBe(200);
    // something echoing the secrets back, in several shapes
    log.error('cli-stderr', `request failed: ${FAKE_KEY} / Authorization: Bearer ${FAKE_TOKEN} / ${s.token}`, { headers: { 'x-api-key': FAKE_KEY }, url: `http://127.0.0.1/?token=${s.token}`, apiKey: FAKE_KEY });
    log.warn('sdk', 'no prefix gw-auth-token-ZZZZ9999YYYY8888 in text');
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    c.send({ type: 'prompt', sessionId: sid, text: `please use ${FAKE_KEY}`, clientMsgId: 'c4' });
    await c.waitFor((m) => m.type === 'sdk' && m.sessionId === sid && (m.message as { type?: string }).type === 'result');
    c.close();

    const json = JSON.stringify(await logs('?limit=5000'));
    const download = await api(s, '/api/logs/download');
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(download.headers.get('content-disposition')).toMatch(/^attachment; filename="workstation-logs-\d{8}-\d{6}\.log"$/);
    const text = await download.text();
    const file = fs.readFileSync(path.join(s.dir, 'home', 'logs', 'server.log'), 'utf8');
    const debug = JSON.stringify(await (await api(s, `/api/logs/debug-info?sessionId=${sid}`)).json());
    for (const [where, out] of Object.entries({ json, text, file, debug })) {
      for (const secret of [FAKE_KEY, 'FAKEKEYFAKEKEY', FAKE_TOKEN, 'ZZZZ9999YYYY8888', s.token, 'urlsecret987', 'user:pw']) expect(out, `${where} leaks ${secret}`).not.toContain(secret);
    }
    expect(text).toContain('request failed');
    expect(text).toContain('[redacted]');
    // the host of the base URL (and only that) is visible in the config entry
    expect(json).toContain('gw.example.com');
    // the prompt is never logged
    expect(json).not.toContain('please use');
  });

  it('the download honours the filters', async () => {
    log.info('git', 'dl-marker-one'); log.info('mcp', 'dl-marker-two');
    const text = await (await api(s, '/api/logs/download?source=mcp&q=dl-marker')).text();
    expect(text).toContain('dl-marker-two');
    expect(text).not.toContain('dl-marker-one');
  });
});

describe('WebSocket log stream', () => {
  it('sends nothing until logs.subscribe, then new entries in batches, and stops on logs.unsubscribe', async () => {
    const c = await connect(s);
    log.info('server', 'ws-before-subscribe');
    await new Promise((r) => setTimeout(r, 300));
    expect(c.msgs.some((m) => m.type === 'log.entries')).toBe(false);
    c.send({ type: 'logs.subscribe' });
    await new Promise((r) => setTimeout(r, 100));
    log.warn('git', 'ws-after-subscribe-1'); log.error('git', 'ws-after-subscribe-2');
    const got = await c.waitFor<Extract<ServerMessage, { type: 'log.entries' }>>((m) => m.type === 'log.entries' && m.entries.some((e) => e.message === 'ws-after-subscribe-2'));
    const all: LogEntry[] = c.msgs.flatMap((m) => (m.type === 'log.entries' ? m.entries : []));
    expect(all.map((e) => e.message)).toEqual(expect.arrayContaining(['ws-after-subscribe-1', 'ws-after-subscribe-2']));
    expect(all.some((e) => e.message === 'ws-before-subscribe')).toBe(false);
    expect(got.entries[0]!.seq).toBeGreaterThan(0);
    c.send({ type: 'logs.unsubscribe' });
    await new Promise((r) => setTimeout(r, 100));
    const n = c.msgs.length;
    log.info('git', 'ws-after-unsubscribe');
    await new Promise((r) => setTimeout(r, 300));
    expect(c.msgs.slice(n).some((m) => m.type === 'log.entries')).toBe(false);
    c.close();
  });

  it('streamed entries are redacted too', async () => {
    const c = await connect(s);
    c.send({ type: 'logs.subscribe' });
    await new Promise((r) => setTimeout(r, 100));
    log.error('sdk', `leak ${s.token} sk-ant-api03-STREAMEDSECRET12345678`);
    await c.waitFor((m) => m.type === 'log.entries' && m.entries.some((e) => e.message.startsWith('leak')));
    expect(JSON.stringify(c.msgs)).not.toContain(s.token);
    expect(JSON.stringify(c.msgs)).not.toContain('STREAMEDSECRET');
    c.close();
  });

  it('another socket that did not subscribe stays quiet', async () => {
    const a = await connect(s), b = await connect(s);
    a.send({ type: 'logs.subscribe' });
    await new Promise((r) => setTimeout(r, 100));
    log.info('server', 'only-for-a');
    await a.waitFor((m) => m.type === 'log.entries' && m.entries.some((e) => e.message === 'only-for-a'));
    expect(b.msgs.some((m) => m.type === 'log.entries')).toBe(false);
    a.close(); b.close();
  });
});

describe('debug info', () => {
  it('describes a live session without credentials', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd, { model: 'claude-test-model', permissionMode: 'plan' });
    const { text } = (await (await api(s, `/api/logs/debug-info?sessionId=${sid}`)).json()) as { text: string };
    expect(text).toContain('The Workstation debug info');
    expect(text).toContain('Base URL host:   gw.example.com');
    expect(text).toContain(`Session:         ${sid}`);
    expect(text).toContain('Model:           claude-test-model');
    expect(text).toContain('Permission mode: plan');
    expect(text).toContain('Session started');
    expect((await api(s, '/api/logs/debug-info?sessionId=bad!id')).status).toBe(400);
    c.close();
  });
});

describe('POST /api/logs/clear', () => {
  it('empties the memory buffer but keeps the file', async () => {
    const before = await logs();
    expect(before.entries.length).toBeGreaterThan(5);
    const r = await (await api(s, '/api/logs/clear', { method: 'POST' })).json() as { ok: boolean; cleared: number };
    expect(r.ok).toBe(true);
    expect(r.cleared).toBeGreaterThanOrEqual(before.entries.length);
    const after = await logs();
    // (a socket that closed meanwhile may still add its own "disconnected" line)
    expect(after.entries.map((e) => e.message).filter((m) => m !== 'WebSocket disconnected')).toEqual(['Log cleared from the browser (the log file keeps its history)']);
    expect(after.entries.length).toBeLessThanOrEqual(2);
    expect(after.lastSeq).toBeGreaterThan(before.lastSeq);
    expect(fs.readFileSync(path.join(s.dir, 'home', 'logs', 'server.log'), 'utf8')).toContain('Server listening');
  });
});

describe('forged Host headers are refused before anything is logged for them', () => {
  it('403 on a bad host', async () => {
    const r = await raw(s, '/api/logs', { host: 'evil.example.com', authorization: `Bearer ${s.token}` });
    expect(r.status).toBe(403);
  });
});
