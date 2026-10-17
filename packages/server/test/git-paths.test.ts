// M1 (scrutiniser pass 1): user paths given to git must be literal, match a `git status` entry exactly and stay in
// the repository. Each test builds a fresh repo with tracked files whose names contain glob characters.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, canSymlink, makeServer, type TestServer } from './helpers.js';

let s: TestServer;
let repo: string;
const run = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString();
const post = async (p: string, body: unknown) => { const r = await api(s, p, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
const get = async (p: string) => { const r = await api(s, p); return { status: r.status, body: await r.json() as any }; };
const read = (p: string) => fs.readFileSync(path.join(repo, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(repo, p));
const status = () => run('status', '--porcelain', '--untracked-files=all');

beforeAll(async () => { s = await makeServer(); });
afterAll(async () => { await s.close(); });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-gitpaths-'));
  fs.mkdirSync(path.join(repo, 'src'));
  for (const f of ['keep.txt', 'src/s.ts', 'src/l.ts', 'src/[slug].ts', 'other.txt']) fs.writeFileSync(path.join(repo, f), `${f} v1\n`);
  run('init', '-q', '-b', 'main'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't');
  run('add', '.'); run('commit', '-qm', 'init');
  // uncommitted work that must survive any revert of another path
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'precious edit\n');
  fs.writeFileSync(path.join(repo, 'src/s.ts'), 'precious s edit\n');
});

describe('revert: literal paths only', () => {
  it.each([
    ['*'], ['src/*'], ['src/[sl].ts'], [':(top)keep.txt'], [':(glob)**'], [':/keep.txt'], ['.'], ['src'], ['./'],
  ])('%s touches nothing', async (p) => {
    const before = status();
    const r = await post('/api/git/revert', { cwd: repo, path: p });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(status()).toBe(before);
    expect(read('keep.txt')).toBe('precious edit\n');
    expect(read('src/s.ts')).toBe('precious s edit\n');
    expect(exists('src/l.ts') && exists('src/[slug].ts') && exists('other.txt')).toBe(true);
  });

  it('a stale glob-looking path (deleted untracked [id].tsx) does not hit siblings', async () => {
    // the UI listed src/[sl].ts earlier; it no longer exists
    const r = await post('/api/git/revert', { cwd: repo, path: path.join(repo, 'src/[sl].ts') });
    expect(r.status).toBe(409);
    expect(read('src/s.ts')).toBe('precious s edit\n');
    expect(exists('src/l.ts')).toBe(true);
  });

  it('a real file literally named [slug].ts is reverted alone', async () => {
    fs.writeFileSync(path.join(repo, 'src/[slug].ts'), 'edited\n');
    expect(await post('/api/git/revert', { cwd: repo, path: 'src/[slug].ts' })).toMatchObject({ status: 200, body: { action: 'restored' } });
    expect(read('src/[slug].ts')).toBe('src/[slug].ts v1\n');
    expect(read('src/s.ts')).toBe('precious s edit\n');
    expect(read('keep.txt')).toBe('precious edit\n');
  });

  it('an untracked file literally named * is deleted alone', async () => {
    fs.writeFileSync(path.join(repo, '*'), 'star\n');
    expect(await post('/api/git/revert', { cwd: repo, path: '*' })).toMatchObject({ status: 200, body: { action: 'deleted' } });
    expect(exists('*')).toBe(false);
    expect(read('keep.txt')).toBe('precious edit\n');
    expect(exists('other.txt')).toBe(true);
  });

  it('refuses ../, absolute paths outside, .git and unchanged files', async () => {
    expect((await post('/api/git/revert', { cwd: repo, path: '../x' })).status).toBe(400);
    expect((await post('/api/git/revert', { cwd: repo, path: '/etc/passwd' })).status).toBe(400);
    expect((await post('/api/git/revert', { cwd: repo, path: '.git/config' })).status).toBe(400);
    expect((await post('/api/git/revert', { cwd: repo, path: 'other.txt' })).status).toBe(409);
  });

  it.skipIf(!canSymlink())('symlinks: a parent link escaping the repo is refused; an untracked link is removed, not its target', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-outside-'));
    fs.writeFileSync(path.join(outside, 'victim.txt'), 'v\n');
    fs.symlinkSync(outside, path.join(repo, 'escape'));
    expect((await post('/api/git/revert', { cwd: repo, path: 'escape/victim.txt' })).status).toBe(400);
    expect(fs.existsSync(path.join(outside, 'victim.txt'))).toBe(true);
    expect(await post('/api/git/revert', { cwd: repo, path: 'escape' })).toMatchObject({ status: 200, body: { action: 'deleted' } });
    expect(fs.existsSync(path.join(outside, 'victim.txt'))).toBe(true);
  });

  it('works from a subdirectory cwd with repo-relative-to-cwd and absolute paths', async () => {
    const sub = path.join(repo, 'src');
    expect(await post('/api/git/revert', { cwd: sub, path: 's.ts' })).toMatchObject({ status: 200, body: { action: 'restored' } });
    expect(read('src/s.ts')).toBe('src/s.ts v1\n');
    expect(await post('/api/git/revert', { cwd: sub, path: path.join(repo, 'keep.txt') })).toMatchObject({ status: 200 });
    expect(read('keep.txt')).toBe('keep.txt v1\n');
  });
});

describe('diff: repo files only', () => {
  it('refuses files outside the repository', async () => {
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-out-')), 'secret.txt');
    fs.writeFileSync(outside, 'TOP SECRET\n');
    const r = await get(`/api/git/diff?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent(outside)}`);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain('TOP SECRET');
    const r2 = await get(`/api/git/diff?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent('../../../../../../etc/hostname')}`);
    expect(r2.status).toBe(400);
  });
  it('does not expand globs', async () => {
    const r = await get(`/api/git/diff?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent('src/[sl].ts')}`);
    expect(r.body.diff ?? '').toBe('');
    const r2 = await get(`/api/git/diff?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent('*')}`);
    expect(r2.body.diff ?? '').toBe('');
  });
  it('serves tracked and untracked repo files, not ignored ones', async () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.env\n');
    fs.writeFileSync(path.join(repo, 'ignored.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
    expect((await get(`/api/git/diff?cwd=${encodeURIComponent(repo)}&path=keep.txt`)).body.diff).toContain('precious edit');
    expect((await get(`/api/git/diff?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent(path.join(repo, 'new.txt'))}`)).body.diff).toContain('+new');
    expect((await get(`/api/git/diff?cwd=${encodeURIComponent(repo)}&path=ignored.env`)).body.diff ?? '').toBe('');
  });
});

describe('commit: stages exactly the listed files, hooks run', () => {
  it('requires an explicit file list', async () => {
    expect((await post('/api/git/commit', { cwd: repo, message: 'x' })).status).toBe(400);
    expect((await post('/api/git/commit', { cwd: repo, message: 'x', files: [] })).status).toBe(400);
    expect((await post('/api/git/commit', { cwd: repo, message: 'x', files: ['*'] })).status).toBe(400);
    expect((await post('/api/git/commit', { cwd: repo, message: 'x', files: ['other.txt'] })).status).toBe(400); // unchanged
  });
  it('commits only the selected files, leaving others (and pre-staged ones) uncommitted', async () => {
    fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=secret\n'); // untracked, not selected
    fs.writeFileSync(path.join(repo, 'other.txt'), 'staged elsewhere\n');
    run('add', 'other.txt'); // staged by the user in a terminal, not selected
    const r = await post('/api/git/commit', { cwd: repo, message: 'only keep', files: [path.join(repo, 'keep.txt')] });
    expect(r.status).toBe(200);
    expect(run('show', '--name-only', '--format=', 'HEAD').trim()).toBe('keep.txt');
    expect(status()).toContain('?? .env');
    expect(status()).toContain(' M src/s.ts');
    expect(status()).toContain('M  other.txt');
  });
  it('commits new files, deletions and renames', async () => {
    fs.writeFileSync(path.join(repo, 'n.txt'), 'n\n');
    fs.rmSync(path.join(repo, 'src/l.ts'));
    run('mv', 'other.txt', 'moved.txt');
    const st = await get(`/api/git/status?cwd=${encodeURIComponent(repo)}`);
    const files = (st.body.files as { path: string }[]).map((f) => f.path).filter((p) => p !== 'keep.txt' && p !== 'src/s.ts');
    const r = await post('/api/git/commit', { cwd: repo, message: 'mixed', files });
    expect(r.status).toBe(200);
    expect(run('show', '--name-status', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['A\tn.txt', 'D\tsrc/l.ts', 'R100\tother.txt\tmoved.txt'].sort());
    expect(status()).toBe(' M keep.txt\n M src/s.ts\n');
  });
  it('runs pre-commit hooks and surfaces their failure', async () => {
    const hook = path.join(repo, '.git/hooks/pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "secret scanner: blocked .env" >&2\nexit 1\n', { mode: 0o755 });
    const r = await post('/api/git/commit', { cwd: repo, message: 'blocked', files: ['keep.txt'] });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('secret scanner: blocked .env');
    expect(run('log', '--format=%s')).toBe('init\n');
  });
});
