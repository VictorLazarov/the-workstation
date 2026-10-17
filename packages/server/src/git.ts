import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { GitStatus, GitFileStatus } from '@workstation/protocol';

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' };
// Defuse repo-controlled code execution paths when merely reading status/diff.
const SAFE_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.pager=cat'];

export interface GitResult { code: number; stdout: string; stderr: string }

export function git(cwd: string, args: string[], opts: { timeout?: number; maxBuffer?: number; okCodes?: number[] } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', [...SAFE_ARGS, ...args], { cwd, env: GIT_ENV, timeout: opts.timeout ?? 15_000, maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { code?: number | string };
      if (typeof e.code === 'number') return resolve({ code: e.code, stdout: stdout ?? '', stderr: stderr ?? '' });
      reject(err);
    });
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return r.code === 0 && r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const r = await git(cwd, ['rev-parse', '--show-toplevel']);
    return r.code === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  if (!(await isGitRepo(cwd))) return { isRepo: false, files: [] };
  const r = await git(cwd, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=normal']);
  const parts = r.stdout.split('\0');
  const files: GitFileStatus[] = [];
  let branch: string | undefined, ahead: number | undefined, behind: number | undefined;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p) continue;
    if (p.startsWith('## ')) {
      const head = p.slice(3);
      const m = /^(.*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
      branch = m?.[1] ?? head;
      if (branch.startsWith('No commits yet on ')) branch = branch.slice('No commits yet on '.length);
      if (branch.startsWith('HEAD (no branch)')) branch = 'HEAD';
      const track = m?.[3] ?? '';
      const a = /ahead (\d+)/.exec(track), b = /behind (\d+)/.exec(track);
      if (a) ahead = Number(a[1]);
      if (b) behind = Number(b[1]);
      continue;
    }
    const x = p[0]!, y = p[1]!;
    const file = p.slice(3);
    if (x === 'R' || x === 'C') i++; // next entry is the original path
    files.push({ path: file, index: x, worktree: y });
  }
  return { isRepo: true, branch, ahead, behind, files };
}

export async function gitDiff(cwd: string, relPath?: string): Promise<string> {
  if (!(await isGitRepo(cwd))) return '';
  const base = ['diff', '--no-ext-diff', '--no-textconv', '--no-color'];
  if (relPath === undefined || relPath === '') {
    const hasHead = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
    const r = await git(cwd, [...base, ...(hasHead ? ['HEAD'] : [])]);
    return r.stdout;
  }
  const abs = path.resolve(cwd, relPath);
  const rel = path.relative(cwd, abs);
  const spec = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
  const hasHead = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
  const r = await git(cwd, [...base, ...(hasHead ? ['HEAD'] : []), '--', spec]);
  if (r.stdout) return r.stdout;
  // untracked file: diff against /dev/null (exit code 1 means "differences found")
  const tracked = (await git(cwd, ['ls-files', '--error-unmatch', '--', spec])).code === 0;
  if (!tracked && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    const u = await git(cwd, [...base, '--no-index', '--', '/dev/null', spec]);
    return u.stdout;
  }
  return '';
}

/** Create a git worktree on a fresh branch for an isolated session. */
export async function createWorktree(cwd: string, name: string): Promise<{ path: string; branch: string }> {
  const root = await gitRoot(cwd);
  if (!root) throw new Error('worktree sessions require a git repository');
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'session';
  const branch = `workstation/${safe}`;
  const dir = path.join(root, '.claude', 'worktrees', safe);
  const r = await git(root, ['worktree', 'add', '-b', branch, dir], { timeout: 60_000 });
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  // keep worktrees out of `git status` of the main checkout
  try {
    const exclude = path.join((await git(root, ['rev-parse', '--git-common-dir'])).stdout.trim() || '.git', 'info', 'exclude');
    const abs = path.isAbsolute(exclude) ? exclude : path.join(root, exclude);
    const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    if (!cur.includes('.claude/worktrees/')) fs.appendFileSync(abs, `${cur.endsWith('\n') || !cur ? '' : '\n'}.claude/worktrees/\n`);
  } catch { /* best effort */ }
  // preserve the sub-directory the user started in
  const sub = path.relative(root, cwd);
  return { path: sub && !sub.startsWith('..') ? path.join(dir, sub) : dir, branch };
}
