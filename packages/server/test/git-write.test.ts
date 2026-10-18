import { toPosix } from '../src/platform.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, makeServer, type TestServer } from './helpers.js';

let s: TestServer;
const run = (...a: string[]) => execFileSync('git', a, { cwd: s.cwd, stdio: 'pipe' }).toString();
const post = async (p: string, body: unknown) => { const r = await api(s, p, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
beforeAll(async () => {
  s = await makeServer();
  run('init', '-q', '-b', 'main'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't');
  run('add', '.'); run('commit', '-qm', 'init');
});
afterAll(async () => { await s.close(); });

describe('M1: a new folder is listed file by file', () => {
  it('status expands an untracked directory, commit/diff/revert work on its files, a huge tree is capped and counted', async () => {
    fs.mkdirSync(path.join(s.cwd, 'fresh/deep'), { recursive: true });
    fs.writeFileSync(path.join(s.cwd, 'fresh/a.ts'), 'a\n');
    fs.writeFileSync(path.join(s.cwd, 'fresh/deep/b.ts'), 'b\n');
    const st = await api(s, `/api/git/status?cwd=${encodeURIComponent(s.cwd)}`).then((r) => r.json()) as any;
    const paths = st.files.map((f: any) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['fresh/a.ts', 'fresh/deep/b.ts']));
    expect(paths.some((p: string) => p.endsWith('/'))).toBe(false); // never one opaque `dir/` entry
    expect(st.untrackedMore).toBeUndefined();
    const d = await api(s, `/api/git/diff?cwd=${encodeURIComponent(s.cwd)}&path=${encodeURIComponent('fresh/deep/b.ts')}`).then((r) => r.json()) as any;
    expect(d.diff).toContain('+b');
    // revert one file of the new folder
    expect(await post('/api/git/revert', { cwd: s.cwd, path: 'fresh/a.ts' })).toMatchObject({ status: 200, body: { action: 'deleted' } });
    // the directory itself is still refused
    expect((await post('/api/git/revert', { cwd: s.cwd, path: 'fresh' })).status).toBeGreaterThanOrEqual(400);
    const c = await post('/api/git/commit', { cwd: s.cwd, message: 'new folder', files: ['fresh/deep/b.ts'] });
    expect(c.status).toBe(200);
    expect(run('show', '--name-only', '--format=', 'HEAD').trim()).toBe('fresh/deep/b.ts');
    // cap: more new files than the panel lists are counted, not silently hidden
    fs.mkdirSync(path.join(s.cwd, 'gen'));
    for (let i = 0; i < 230; i++) fs.writeFileSync(path.join(s.cwd, 'gen', `f${i}.txt`), 'x\n');
    const big = await api(s, `/api/git/status?cwd=${encodeURIComponent(s.cwd)}`).then((r) => r.json()) as any;
    expect(big.files.filter((f: any) => f.path.startsWith('gen/'))).toHaveLength(200);
    expect(big.untrackedMore).toBe(30);
    fs.rmSync(path.join(s.cwd, 'gen'), { recursive: true });
  });
});

describe('git commit / revert', () => {
  it('status reports the repo root', async () => {
    const r = await api(s, `/api/git/status?cwd=${encodeURIComponent(s.cwd)}`);
    expect((await r.json() as any).root).toBe(toPosix(fs.realpathSync.native(s.cwd))); // wire format: / on Windows too
  });
  it('requires a non-empty message and something to commit', async () => {
    expect((await post('/api/git/commit', { cwd: s.cwd, message: '   ' })).status).toBe(400);
    expect((await post('/api/git/commit', { cwd: s.cwd })).status).toBe(400);
    // M1: an explicit file list is required, and every file must be a changed one
    expect((await post('/api/git/commit', { cwd: s.cwd, message: 'x' })).status).toBe(400);
    expect((await post('/api/git/commit', { cwd: s.cwd, message: 'x', files: ['src/example.ts'] })).status).toBe(400);
  });
  it('reverts tracked, deletes untracked, refuses escapes', async () => {
    const f = path.join(s.cwd, 'src/example.ts');
    fs.writeFileSync(f, 'changed\n');
    fs.writeFileSync(path.join(s.cwd, 'u.txt'), 'u\n');
    expect(await post('/api/git/revert', { cwd: s.cwd, path: 'src/example.ts' })).toMatchObject({ status: 200, body: { action: 'restored' } });
    expect(fs.readFileSync(f, 'utf8')).toBe('export const greeting = "hello";\n');
    expect(await post('/api/git/revert', { cwd: s.cwd, path: path.join(s.cwd, 'u.txt') })).toMatchObject({ status: 200, body: { action: 'deleted' } });
    expect(fs.existsSync(path.join(s.cwd, 'u.txt'))).toBe(false);
    expect((await post('/api/git/revert', { cwd: s.cwd, path: '../outside.txt' })).status).toBe(400);
    expect((await post('/api/git/revert', { cwd: s.cwd, path: '/etc/passwd' })).status).toBe(400);
    expect((await post('/api/git/revert', { cwd: s.cwd, path: '.git/config' })).status).toBe(400);
    expect((await post('/api/git/revert', { cwd: s.cwd, path: 'src/example.ts' })).status).toBe(409);
  });
  it('commits all listed files', async () => {
    fs.writeFileSync(path.join(s.cwd, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(s.cwd, 'src/example.ts'), 'export const x = 1;\n');
    const r = await post('/api/git/commit', { cwd: s.cwd, message: '-m weird\n\nbody', files: ['a.txt', path.join(s.cwd, 'src/example.ts')] });
    expect(r.status).toBe(200);
    expect(r.body.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(run('log', '-1', '--format=%s')).toBe('-m weird\n');
    expect(run('status', '--porcelain')).toBe('');
  });
});
