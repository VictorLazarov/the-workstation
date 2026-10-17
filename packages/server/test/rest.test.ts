import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connect, makeServer, startSession, type TestServer } from './helpers.js';

let s: TestServer;
beforeAll(async () => { s = await makeServer(); });
afterAll(async () => { await s.close(); });
const j = async (p: string, init?: RequestInit) => { const r = await api(s, p, init); return { status: r.status, body: await r.json() as any }; };

describe('config', () => {
  it('never echoes secrets', async () => {
    const put = await j('/api/config', { method: 'PUT', body: JSON.stringify({ apiKey: 'sk-ant-SECRET123', authToken: 'tok-SECRET', anthropicBaseUrl: 'https://gw.example/v1', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'my-model', MY_API_KEY: 'hunter2' }, customModels: ['my-model'] }) });
    expect(put.status).toBe(200);
    const get = await j('/api/config');
    const text = JSON.stringify(get.body);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('hunter2');
    expect(get.body).toMatchObject({ hasApiKey: true, hasAuthToken: true, anthropicBaseUrl: 'https://gw.example/v1' });
    expect(get.body.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('my-model');
    expect(get.body.token).toBeUndefined();
    // masked value round trip must not clobber the stored secret
    await j('/api/config', { method: 'PUT', body: JSON.stringify({ env: get.body.env }) });
    expect(s.config.providerEnv().MY_API_KEY).toBe('hunter2');
    expect(s.config.providerEnv()).toMatchObject({ ANTHROPIC_API_KEY: 'sk-ant-SECRET123', ANTHROPIC_AUTH_TOKEN: 'tok-SECRET', ANTHROPIC_BASE_URL: 'https://gw.example/v1' });
    // clearing
    await j('/api/config', { method: 'PUT', body: JSON.stringify({ apiKey: '' }) });
    expect((await j('/api/config')).body.hasApiKey).toBe(false);
  });
  it('validates input', async () => {
    expect((await j('/api/config', { method: 'PUT', body: JSON.stringify({ anthropicBaseUrl: 'ftp://x' }) })).status).toBe(400);
    expect((await j('/api/config', { method: 'PUT', body: JSON.stringify({ defaultEffort: 'banana' }) })).status).toBe(400);
    expect((await j('/api/config', { method: 'PUT', body: '[1]' })).status).toBe(400);
    expect((await j('/api/config', { method: 'PUT', body: 'not json' })).status).toBe(400);
  });
});

describe('fs + search + git', () => {
  it('lists and reads', async () => {
    const l = await j(`/api/fs/list?path=${encodeURIComponent(s.cwd)}`);
    expect(l.body).toEqual([expect.objectContaining({ name: 'src', kind: 'dir' })]);
    const r = await j(`/api/fs/read?path=${encodeURIComponent(path.join(s.cwd, 'src/example.ts'))}`);
    expect(r.body).toMatchObject({ content: 'export const greeting = "hello";\n', encoding: 'utf8', truncated: false });
  });
  it('validates and resolves traversal', async () => {
    expect((await j('/api/fs/list')).status).toBe(200); // defaults to home
    expect((await j('/api/fs/read')).status).toBe(400);
    expect((await j('/api/fs/read?path=a%00b')).status).toBe(400);
    expect((await j('/api/fs/read?path=/nonexistent/zzz')).status).toBe(404);
    expect((await j(`/api/fs/read?path=${encodeURIComponent(s.cwd)}`)).status).toBe(400); // dir, not file
    // relative traversal is normalised, not interpreted
    const t = await j(`/api/fs/read?path=${encodeURIComponent(path.join(s.cwd, 'src/../src/example.ts'))}`);
    expect(t.status).toBe(200);
    expect(t.body.path).toBe(fs.realpathSync(path.join(s.cwd, 'src/example.ts')));
  });
  it('binary files come back base64', async () => {
    fs.writeFileSync(path.join(s.cwd, 'b.bin'), Buffer.from([0, 1, 2, 255]));
    const r = await j(`/api/fs/read?path=${encodeURIComponent(path.join(s.cwd, 'b.bin'))}`);
    expect(r.body).toMatchObject({ encoding: 'base64', content: Buffer.from([0, 1, 2, 255]).toString('base64') });
  });
  it('searches files (non-git walk ignores node_modules)', async () => {
    fs.mkdirSync(path.join(s.cwd, 'node_modules/x'), { recursive: true });
    fs.writeFileSync(path.join(s.cwd, 'node_modules/x/example.js'), '');
    const r = await j(`/api/files/search?cwd=${encodeURIComponent(s.cwd)}&q=exmpl`);
    expect(r.body).toEqual(['src/example.ts']);
  });
  it('git status/diff and git-based search', async () => {
    const run = (...a: string[]) => execFileSync('git', a, { cwd: s.cwd, stdio: 'pipe' });
    run('init', '-q', '-b', 'main'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't');
    fs.writeFileSync(path.join(s.cwd, '.gitignore'), 'node_modules\n*.bin\n');
    run('add', '.'); run('commit', '-qm', 'init');
    fs.writeFileSync(path.join(s.cwd, 'src/example.ts'), 'export const greeting = "hello, world";\n');
    fs.writeFileSync(path.join(s.cwd, 'new.txt'), 'new file\n');
    const st = await j(`/api/git/status?cwd=${encodeURIComponent(s.cwd)}`);
    expect(st.body).toMatchObject({ isRepo: true, branch: 'main' });
    expect(st.body.files).toEqual(expect.arrayContaining([
      { path: 'src/example.ts', index: ' ', worktree: 'M' }, { path: 'new.txt', index: '?', worktree: '?' },
    ]));
    const d = await j(`/api/git/diff?cwd=${encodeURIComponent(s.cwd)}&path=src/example.ts`);
    expect(d.body.diff).toContain('+export const greeting = "hello, world";');
    const dn = await j(`/api/git/diff?cwd=${encodeURIComponent(s.cwd)}&path=new.txt`);
    expect(dn.body.diff).toContain('+new file');
    const dd = await j(`/api/git/diff?cwd=${encodeURIComponent(s.cwd)}`);
    expect(dd.body.diff).toContain('example.ts');
    await new Promise((r) => setTimeout(r, 5100)); // search cache TTL
    const sr = await j(`/api/files/search?cwd=${encodeURIComponent(s.cwd)}&q=new`);
    expect(sr.body).toContain('new.txt');
    expect(sr.body.some((f: string) => f.includes('node_modules'))).toBe(false);
    const notRepo = await j(`/api/git/status?cwd=${encodeURIComponent(s.dir)}`);
    expect(notRepo.body).toEqual({ isRepo: false, files: [] });
  }, 20000);
  it('rejects option-looking git paths safely', async () => {
    const d = await j(`/api/git/diff?cwd=${encodeURIComponent(s.cwd)}&path=${encodeURIComponent('--output=/tmp/pwned')}`);
    expect(d.status).toBe(200);
    expect(fs.existsSync('/tmp/pwned')).toBe(false);
  });
});

describe('sessions + models + commands (mock)', () => {
  it('models include custom', async () => {
    const m = await j('/api/models');
    expect(m.body.map((x: any) => x.id)).toEqual(expect.arrayContaining(['default', 'sonnet', 'opus', 'haiku', 'my-model']));
  });
  it('commands', async () => {
    const c = await j(`/api/commands?cwd=${encodeURIComponent(s.cwd)}`);
    expect(c.body.map((x: any) => x.name)).toContain('compact');
  });
  it('list/messages/rename/delete', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    c.send({ type: 'prompt', sessionId: sid, text: 'hello there', clientMsgId: 'c1' });
    await c.waitFor((m) => m.type === 'sdk' && (m.message as any).type === 'result');
    let list = await j(`/api/sessions?cwd=${encodeURIComponent(s.cwd)}`);
    expect(list.body).toEqual([expect.objectContaining({ sessionId: sid, live: true, cwd: s.cwd })]);
    const msgs = await j(`/api/sessions/${sid}/messages?cwd=${encodeURIComponent(s.cwd)}`);
    expect(msgs.body.messages.length).toBeGreaterThanOrEqual(2);
    expect((await j(`/api/sessions/${sid}`, { method: 'PATCH', body: JSON.stringify({ title: 'Renamed' }) })).status).toBe(200);
    list = await j('/api/sessions');
    expect(list.body[0].title).toBe('Renamed');
    expect((await j(`/api/sessions/${sid}`, { method: 'PATCH', body: JSON.stringify({ title: 5 }) })).status).toBe(400);
    expect((await j('/api/sessions/..%2Fx', { method: 'DELETE' })).status).toBe(400);
    expect((await j(`/api/sessions/${sid}`, { method: 'DELETE' })).status).toBe(200);
    await c.waitFor((m) => m.type === 'session.ended');
    list = await j('/api/sessions');
    expect(list.body.find((x: any) => x.sessionId === sid)).toBeUndefined();
    c.close();
  });
  it('health', async () => {
    expect((await j('/api/health')).body).toMatchObject({ ok: true, mock: true });
    expect((await j('/api/nope')).status).toBe(404);
  });
});
