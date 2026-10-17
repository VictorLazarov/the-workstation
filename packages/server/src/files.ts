import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FsEntry } from '@workstation/protocol';
import { git, isGitRepo } from './git.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Validate a user-supplied path param and normalise it (absolute, ~ expanded, no NUL). */
export function resolveUserPath(input: unknown, base = process.cwd()): string {
  if (typeof input !== 'string' || input.length === 0) throw new HttpError(400, 'path is required');
  if (input.length > 4096 || input.includes('\0')) throw new HttpError(400, 'invalid path');
  let p = input;
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(base, p);
}

async function real(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new HttpError(404, 'not found');
    if (code === 'EACCES' || code === 'EPERM') throw new HttpError(403, 'permission denied');
    throw e;
  }
}

export async function listDir(input: unknown): Promise<FsEntry[]> {
  const dir = await real(resolveUserPath(input));
  const st = await fsp.stat(dir);
  if (!st.isDirectory()) throw new HttpError(400, 'not a directory');
  let ents: fs.Dirent[];
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EACCES') throw new HttpError(403, 'permission denied');
    throw e;
  }
  const out: FsEntry[] = [];
  for (const d of ents.slice(0, 10_000)) {
    const full = path.join(dir, d.name);
    let kind: FsEntry['kind'] = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'symlink';
    let size: number | undefined;
    try {
      if (d.isSymbolicLink()) {
        const t = await fsp.stat(full);
        kind = t.isDirectory() ? 'dir' : t.isFile() ? 'file' : 'symlink';
        size = t.isFile() ? t.size : undefined;
      } else if (d.isFile()) size = (await fsp.stat(full)).size;
    } catch { /* broken link keeps 'symlink' */ }
    out.push({ name: d.name, path: full, kind, ...(size !== undefined ? { size } : {}) });
  }
  out.sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
  return out;
}

const TEXT_CAP = 2 * 1024 * 1024;
const BIN_CAP = 10 * 1024 * 1024;

export async function readFile(input: unknown): Promise<{ content: string; encoding: 'utf8' | 'base64'; truncated: boolean; size: number; path: string }> {
  const file = await real(resolveUserPath(input));
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new HttpError(400, 'not a regular file');
  const fh = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(8192, st.size));
    await fh.read(head, 0, head.length, 0);
    const binary = head.includes(0);
    const cap = binary ? BIN_CAP : TEXT_CAP;
    if (binary && st.size > cap) return { content: '', encoding: 'base64', truncated: true, size: st.size, path: file };
    const len = Math.min(st.size, cap);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return { content: buf.toString(binary ? 'base64' : 'utf8'), encoding: binary ? 'base64' : 'utf8', truncated: st.size > cap, size: st.size, path: file };
  } finally {
    await fh.close();
  }
}

// ───────── file search ─────────
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.next', '.venv', 'venv', '.cache', '.turbo', 'target', '.idea']);
const MAX_FILES = 30_000;
const cache = new Map<string, { at: number; files: string[] }>();

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: Array<[string, number]> = [[root, 0]];
  while (stack.length && out.length < MAX_FILES) {
    const [dir, depth] = stack.pop()!;
    let ents: fs.Dirent[];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && depth < 10) stack.push([path.join(dir, e.name), depth + 1]);
      } else if (e.isFile() || e.isSymbolicLink()) {
        out.push(path.relative(root, path.join(dir, e.name)));
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

export async function listProjectFiles(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < 5000) return hit.files;
  let files: string[];
  if (await isGitRepo(cwd)) {
    const r = await git(cwd, ['ls-files', '-co', '--exclude-standard', '-z']);
    files = r.stdout.split('\0').filter(Boolean).slice(0, MAX_FILES * 2);
  } else files = await walk(cwd);
  cache.set(cwd, { at: Date.now(), files });
  if (cache.size > 20) cache.delete(cache.keys().next().value as string);
  return files;
}

function score(file: string, q: string): number {
  const f = file.toLowerCase();
  const base = f.slice(f.lastIndexOf('/') + 1);
  if (base === q) return 1000;
  let s = 0;
  if (base.startsWith(q)) s = 800;
  else if (base.includes(q)) s = 600;
  else if (f.includes(q)) s = 400;
  else {
    // subsequence match
    let i = 0, streak = 0, best = 0;
    for (const ch of f) {
      if (ch === q[i]) { i++; streak++; best = Math.max(best, streak); } else streak = 0;
      if (i === q.length) break;
    }
    if (i < q.length) return -1;
    s = 100 + best * 10;
  }
  return s - f.length * 0.1;
}

export async function searchFiles(cwd: string, q: string, limit = 50): Promise<string[]> {
  const files = await listProjectFiles(cwd);
  const query = q.trim().toLowerCase();
  if (!query) return files.slice().sort((a, b) => a.length - b.length).slice(0, limit);
  const scored: Array<[number, string]> = [];
  for (const f of files) {
    const s = score(f, query);
    if (s >= 0) scored.push([s, f]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length);
  return scored.slice(0, limit).map((x) => x[1]);
}

export async function requireDir(input: unknown): Promise<string> {
  const p = resolveUserPath(input);
  const r = await real(p);
  if (!(await fsp.stat(r)).isDirectory()) throw new HttpError(400, 'cwd must be a directory');
  return p;
}
