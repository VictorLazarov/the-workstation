import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { GitStatus, GitFileStatus, GitCommitResult, GitRevertResult } from '@workstation/protocol';
import { fromGitPath, isGitDirName, realpathSyncNative, relativeInside, toPosix } from './platform.js';

// GIT_LITERAL_PATHSPECS=1: every path we pass is a literal file name, never a glob (`*`, `[x]`) or magic (`:(top)`).
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C', GIT_LITERAL_PATHSPECS: '1' };
// Defuse repo-controlled code execution paths when merely reading status/diff or restoring a file.
// core.longpaths: Windows paths over 260 chars (deep node_modules, worktrees under .claude/worktrees) otherwise fail.
const NO_EXEC_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat', ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [])];
const SAFE_ARGS = [...NO_EXEC_ARGS, '-c', 'core.hooksPath=/dev/null'];

export interface GitResult { code: number; stdout: string; stderr: string }

export function git(cwd: string, args: string[], opts: { timeout?: number; maxBuffer?: number; okCodes?: number[]; runHooks?: boolean } = {}): Promise<GitResult> {
  // runHooks (commit only): hooks are the user's own repository policy (secret scanners, linters) and run exactly as
  // they would for `git commit` in a terminal. Hooks must not inherit GIT_LITERAL_PATHSPECS (it would change how their
  // own git calls match), so those invocations pass `:(literal)` per path instead.
  let env: NodeJS.ProcessEnv = GIT_ENV;
  if (opts.runHooks) { env = { ...GIT_ENV }; delete env.GIT_LITERAL_PATHSPECS; }
  return new Promise((resolve, reject) => {
    execFile('git', [...(opts.runHooks ? NO_EXEC_ARGS : SAFE_ARGS), ...args], { cwd, env, timeout: opts.timeout ?? 15_000, maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
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
    // git prints `C:/Users/x/repo` on Windows: native separators from here on
    return r.code === 0 && r.stdout.trim() ? fromGitPath(r.stdout.trim()) : null;
  } catch {
    return null;
  }
}

/** New (untracked) files listed individually in the Changes panel; more are counted in `untrackedMore`. */
export const MAX_UNTRACKED_FILES = 200;

export async function gitStatus(cwd: string): Promise<GitStatus> {
  if (!(await isGitRepo(cwd))) return { isRepo: false, files: [] };
  const root = (await gitRoot(cwd)) ?? undefined;
  const r = await git(cwd, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
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
  // `--untracked-files=all` lists every new file (a new folder is never one opaque `dir/` entry the UI cannot review);
  // a pathological number of them (a generated tree) is capped so the panel and Commit stay in step with what is shown.
  let untrackedMore = 0;
  let kept = 0;
  const shown = files.filter((f) => {
    if (f.index !== '?' || f.worktree !== '?') return true;
    if (kept < MAX_UNTRACKED_FILES) { kept++; return true; }
    untrackedMore++;
    return false;
  });
  return { isRepo: true, branch, ahead, behind, files: shown, ...(untrackedMore ? { untrackedMore } : {}), root: root === undefined ? undefined : toPosix(root) };
}

export async function gitDiff(cwd: string, relPath?: string): Promise<string> {
  if (!(await isGitRepo(cwd))) return '';
  const base = ['diff', '--no-ext-diff', '--no-textconv', '--no-color'];
  if (relPath === undefined || relPath === '') {
    const hasHead = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
    const r = await git(cwd, [...base, ...(hasHead ? ['HEAD'] : [])]);
    return r.stdout;
  }
  // Repo files only (tracked, or untracked and not ignored); anything outside the repository is a 400.
  const { root, rel } = await resolveInRepo(cwd, relPath);
  const hasHead = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
  const r = await git(root, [...base, ...(hasHead ? ['HEAD'] : []), '--', rel]);
  if (r.stdout) return r.stdout;
  // untracked file: diff against /dev/null (exit code 1 means "differences found")
  const tracked = (await git(root, ['ls-files', '--error-unmatch', '--', rel])).code === 0;
  if (tracked) return '';
  const others = await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', rel]);
  if (!others.stdout.split('\0').includes(rel)) return '';
  const abs = path.join(root, rel);
  if (fs.lstatSync(abs, { throwIfNoEntry: false })?.isFile()) {
    const u = await git(root, [...base, '--no-index', '--', '/dev/null', rel]);
    return u.stdout;
  }
  return '';
}

interface StatusEntry { path: string; x: string; y: string; orig?: string }

/** `git status` entries (paths relative to the repo root, `/`-separated, untracked dirs end with `/` in 'normal' mode). */
async function statusEntries(root: string, untracked: 'all' | 'normal'): Promise<StatusEntry[]> {
  const r = await git(root, ['status', '--porcelain=v1', '-z', `--untracked-files=${untracked}`]);
  if (r.code !== 0) throw new GitError(500, `git status failed: ${firstLine(r.stderr)}`);
  const parts = r.stdout.split('\0');
  const out: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p) continue;
    const e: StatusEntry = { path: p.slice(3), x: p[0]!, y: p[1]! };
    if (e.x === 'R' || e.x === 'C') e.orig = parts[++i];
    out.push(e);
  }
  return out;
}

/** realpath of the nearest existing ancestor + the rest (a deleted file or directory still resolves). */
function realpathLoose(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try { return path.join(realpathSyncNative(cur), ...rest.reverse()); } catch { /* walk up */ }
    const up = path.dirname(cur);
    if (up === cur) return p;
    rest.push(path.basename(cur));
    cur = up;
  }
}

/**
 * Resolves a user-supplied path (absolute, or relative to `cwd`) to a normalized path relative to the repository root.
 * The parent directory is resolved through symlinks so a link cannot escape the repository; the final component is
 * kept as is (a symlink is the link, not its target). Refuses paths outside the repository and anything inside `.git`.
 */
export async function resolveInRepo(cwd: string, input: unknown): Promise<{ root: string; rel: string }> {
  if (typeof input !== 'string' || !input || input.length > 4096 || input.includes('\0')) throw new GitError(400, 'invalid path');
  const top = await gitRoot(cwd);
  if (!top) throw new GitError(400, 'not a git repository');
  const root = realpathSyncNative(top);
  const abs = path.resolve(cwd, input);
  const real = path.join(realpathLoose(path.dirname(abs)), path.basename(abs));
  // containment is case-insensitive on Windows/macOS, drive letters and UNC roots go through path.win32 there
  const rel = relativeInside(root, real);
  if (!rel) throw new GitError(400, 'path is outside the repository');
  if (rel.split(path.sep).some((seg) => isGitDirName(seg))) throw new GitError(400, 'refusing to touch .git');
  return { root, rel: toPosix(rel) };
}

/** The sub-directory of `cwd` inside the repo root. `git rev-parse --show-toplevel` reports the resolved path, so a cwd spelled
 * through a symlink (macOS /var -> /private/var, Windows 8.3 short names) only matches after resolving it too. */
function subDirOf(root: string, cwd: string): string | null {
  return relativeInside(root, cwd) ?? relativeInside(root, realpathLoose(cwd));
}

/** Create a git worktree on a fresh branch for an isolated session. */
export async function createWorktree(cwd: string, name: string): Promise<{ path: string; branch: string }> {
  const root = await gitRoot(cwd);
  if (!root) throw new Error('worktree sessions require a git repository');
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'session';
  const branch = `workstation/${safe}`;
  const dir = path.join(root, '.claude', 'worktrees', safe);
  // Resuming a worktree session: reuse the registered worktree of this branch, or re-attach the existing branch.
  const list = await git(root, ['worktree', 'list', '--porcelain', '-z']);
  const existing = list.stdout.split('\0\0').map((b) => b.split('\0')).find((l) => l.includes(`branch refs/heads/${branch}`));
  const wtPath = existing?.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
  if (wtPath && fs.existsSync(fromGitPath(wtPath))) {
    const sub = subDirOf(root, cwd);
    return { path: sub ? path.join(fromGitPath(wtPath), sub) : fromGitPath(wtPath), branch };
  }
  if (wtPath) await git(root, ['worktree', 'prune']);
  const branchExists = (await git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])).code === 0;
  const r = await git(root, ['worktree', 'add', ...(branchExists ? [dir, branch] : ['-b', branch, dir])], { timeout: 60_000 });
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  // keep worktrees out of `git status` of the main checkout
  try {
    const exclude = path.join((await git(root, ['rev-parse', '--git-common-dir'])).stdout.trim() || '.git', 'info', 'exclude');
    const abs = path.isAbsolute(exclude) ? exclude : path.join(root, exclude);
    const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    if (!cur.includes('.claude/worktrees/')) fs.appendFileSync(abs, `${cur.endsWith('\n') || !cur ? '' : '\n'}.claude/worktrees/\n`);
  } catch { /* best effort */ }
  // preserve the sub-directory the user started in
  const sub = subDirOf(root, cwd);
  return { path: sub ? path.join(dir, sub) : dir, branch };
}

/** Error carrying an HTTP status (mapped by the app's error handler via HttpError in files.ts). */
export class GitError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const firstLine = (s: string) => s.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';

const lastLines = (s: string, n: number) => s.trim().split('\n').filter(Boolean).slice(-n).join('\n');
const MAX_COMMIT_FILES = 5000;

/**
 * Stage exactly the listed files (each must be a current `git status` entry) and commit only those paths: other
 * changes, including ones the user staged elsewhere, stay uncommitted. The repository's hooks RUN (pre-commit secret
 * scanners/linters are the user's policy, exactly as for `git commit` in a terminal); a hook failure is a 409 carrying
 * the hook's output.
 */
export async function gitCommit(cwd: string, message: unknown, files?: unknown): Promise<GitCommitResult> {
  if (typeof message !== 'string' || !message.trim()) throw new GitError(400, 'commit message is required');
  if (message.length > 20_000 || message.includes('\0')) throw new GitError(400, 'invalid commit message');
  if (!Array.isArray(files) || files.length === 0) throw new GitError(400, 'files (the changed paths to commit) is required');
  if (files.length > MAX_COMMIT_FILES) throw new GitError(400, `too many files (max ${MAX_COMMIT_FILES})`);
  if (!(await isGitRepo(cwd))) throw new GitError(400, 'not a git repository');
  const resolved = await Promise.all(files.map((f) => resolveInRepo(cwd, f)));
  const root = resolved[0]!.root;
  // The Changes panel shows 'normal' entries (an untracked directory is one `dir/` entry); also accept single files.
  const entries = [...await statusEntries(root, 'normal'), ...await statusEntries(root, 'all')];
  const byPath = new Map<string, StatusEntry>();
  for (const e of entries) { byPath.set(e.path, e); if (e.path.endsWith('/')) byPath.set(e.path.slice(0, -1), e); }
  const paths = new Set<string>();
  const origs = new Set<string>();
  for (const { rel } of resolved) {
    const e = byPath.get(rel);
    if (!e) throw new GitError(400, `not a changed file: ${rel}`);
    paths.add(e.path.replace(/\/$/, ''));
    if (e.orig) origs.add(e.orig); // a staged rename: commit both sides (the old side is already staged as removed)
  }
  const add = await git(root, ['add', '-A', '--', ...paths], { timeout: 60_000 });
  const list = [...new Set([...paths, ...origs])];
  if (add.code !== 0) throw new GitError(500, `git add failed: ${firstLine(add.stderr) || firstLine(add.stdout)}`);
  const staged = await git(root, ['diff', '--cached', '--quiet', '--', ...list]);
  if (staged.code === 0) throw new GitError(409, 'nothing to commit');
  // `commit -- <paths>` (implicit --only) commits just these paths. Hooks run, so no GIT_LITERAL_PATHSPECS in their env:
  // the paths carry `:(literal)` themselves.
  const r = await git(root, ['commit', '-m', message.trim(), '--', ...list.map((p) => `:(literal)${p}`)], { timeout: 120_000, runHooks: true });
  if (r.code !== 0) {
    const out = lastLines(`${r.stdout}\n${r.stderr}`, 20);
    throw new GitError(409, `git commit failed (a hook may have rejected it):\n${out}`);
  }
  const head = await git(root, ['rev-parse', '--short', 'HEAD']);
  const summary = r.stdout.split('\n').find((l) => /^\s*\d+ files? changed/.test(l))?.trim() ?? '';
  return { ok: true, commit: head.stdout.trim(), summary };
}

/**
 * Discard working-tree changes of ONE file: tracked -> restore from HEAD (index + worktree),
 * untracked -> delete the file. The path must resolve inside the repository; renames are refused.
 */
export async function gitRevert(cwd: string, relPath: unknown): Promise<GitRevertResult> {
  const { root, rel } = await resolveInRepo(cwd, relPath);
  const realAbs = path.join(root, rel);
  // The path must equal ONE status entry exactly (literal; no globs, no magic, no directories).
  const entries = await statusEntries(root, 'all');
  const entry = entries.find((e) => e.path === rel);
  if (!entry) {
    if (entries.some((e) => e.orig === rel)) throw new GitError(400, 'reverting renamed files is not supported');
    throw new GitError(409, 'file has no changes');
  }
  const { x, y } = entry;
  if (x === 'R' || x === 'C') throw new GitError(400, 'reverting renamed files is not supported');
  if (x === '?' && y === '?') {
    const stat = fs.lstatSync(realAbs);
    if (stat.isDirectory()) throw new GitError(400, 'refusing to delete a directory');
    fs.rmSync(realAbs, { force: true });
    return { ok: true, action: 'deleted' };
  }
  const hasHead = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
  const inHead = hasHead && (await git(root, ['cat-file', '-e', `HEAD:${rel}`])).code === 0;
  if (!inHead) {
    // added (staged) but not in HEAD: drop it from the index and the worktree
    const r = await git(root, ['rm', '-f', '-q', '--', rel]);
    if (r.code !== 0) throw new GitError(500, `git rm failed: ${firstLine(r.stderr)}`);
    return { ok: true, action: 'deleted' };
  }
  const r = await git(root, ['checkout', 'HEAD', '--', rel]);
  if (r.code !== 0) throw new GitError(500, `git checkout failed: ${firstLine(r.stderr)}`);
  return { ok: true, action: 'restored' };
}
