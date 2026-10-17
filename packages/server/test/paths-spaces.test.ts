/** Spaces, non-ASCII and deep paths end to end through git, worktrees and file search (the usual Windows/macOS home-directory shapes). */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, makeServer, type TestServer } from './helpers.js';
import { listProjectFiles, searchFiles } from '../src/files.js';
import { createWorktree, gitStatus, resolveInRepo } from '../src/git.js';
import { removeWorktree } from '../src/worktrees.js';

let s: TestServer;
let repo: string;
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString();

beforeAll(async () => {
  s = await makeServer();
  repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ws space ')), 'Jürgen’s Projects', 'my repo');
  fs.mkdirSync(path.join(repo, 'src', 'deep dir'), { recursive: true });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'src', 'deep dir', 'a file.ts'), 'one\n');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'src', 'deep dir', 'a file.ts'), 'one\ntwo\r\nthree\r\n'); // mixed line endings
  fs.writeFileSync(path.join(repo, 'new ünï.txt'), 'x\n');
});
afterAll(async () => { await s.close(); });

describe('paths with spaces / unicode / CRLF', () => {
  it('git status lists forward-slash repo-relative paths and a wire-format root', async () => {
    const st = await gitStatus(repo);
    expect(st.files.map((f) => f.path).sort()).toEqual(['new ünï.txt', 'src/deep dir/a file.ts']);
    expect(st.root).not.toContain('\\');
    expect(path.resolve(st.root!)).toBe(fs.realpathSync(repo));
  });
  it('resolveInRepo accepts absolute and cwd-relative spellings', async () => {
    const abs = path.join(repo, 'src', 'deep dir', 'a file.ts');
    expect((await resolveInRepo(repo, abs)).rel).toBe('src/deep dir/a file.ts');
    expect((await resolveInRepo(path.join(repo, 'src'), 'deep dir/a file.ts')).rel).toBe('src/deep dir/a file.ts');
  });
  it('diff keeps CRLF bytes; commit and revert work', async () => {
    const d = await api(s, `/api/git/diff?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent('src/deep dir/a file.ts')}`).then((r) => r.json()) as { diff: string };
    expect(d.diff).toContain('+two');
    const c = await api(s, '/api/git/commit', { method: 'POST', body: JSON.stringify({ cwd: repo, message: 'añadir\n\nbody with "quotes" & ampersands', files: ['src/deep dir/a file.ts'] }) });
    expect(c.status).toBe(200);
    expect(git('log', '-1', '--format=%B')).toContain('añadir');
    const r = await api(s, '/api/git/revert', { method: 'POST', body: JSON.stringify({ cwd: repo, path: 'new ünï.txt' }) });
    expect(await r.json()).toMatchObject({ action: 'deleted' });
  });
  it('file search returns posix-style relative paths', async () => {
    const files = await listProjectFiles(repo);
    expect(files).toContain('src/deep dir/a file.ts');
    expect(await searchFiles(repo, 'a file')).toContain('src/deep dir/a file.ts');
  });
  it('worktree under a spaced path: create, reuse from a subdirectory, remove', async () => {
    const wt = await createWorktree(path.join(repo, 'src'), 'abc12345');
    expect(fs.existsSync(wt.path)).toBe(true);
    expect(wt.path).toContain(path.join('.claude', 'worktrees', 'abc12345'));
    expect(wt.path.endsWith('src')).toBe(true); // sub-directory preserved
    const dir = wt.path.slice(0, wt.path.lastIndexOf(path.sep + 'src'));
    const rec = { sessionId: 'x', root: fs.realpathSync(repo), dir, branch: wt.branch, baseSha: git('rev-parse', 'HEAD').trim(), createdAt: 1 };
    const again = await createWorktree(path.join(repo, 'src'), 'abc12345');
    expect(again.path).toBe(wt.path);
    expect(await removeWorktree({ ...rec, dir: path.join(rec.root, 'elsewhere') }, true)).toMatchObject({ removed: false });
    expect(await removeWorktree(rec, false)).toMatchObject({ removed: true });
    expect(fs.existsSync(dir)).toBe(false);
  });
});
