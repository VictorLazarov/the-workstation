import fs from 'node:fs';
import path from 'node:path';
import { git, gitRoot } from './git.js';
import { relativeInside } from './platform.js';

/** A worktree this server created for a session (persisted so cleanup works after a restart). */
export interface WorktreeRecord {
  sessionId: string;
  /** main checkout the worktree belongs to */
  root: string;
  /** worktree directory (`<root>/.claude/worktrees/<name>`), not the sub-directory the session started in */
  dir: string;
  branch: string;
  baseSha: string;
  createdAt: number;
  /** set when the worktree was removed: the record is kept so the session stays listed (read-only) under its project */
  removedAt?: number;
}

export interface WorktreeRemoval { removed: boolean; branchDeleted: boolean; reason?: string }

export class WorktreeRegistry {
  private recs = new Map<string, WorktreeRecord>();
  constructor(private file: string) {
    try {
      const arr = JSON.parse(fs.readFileSync(file, 'utf8')) as WorktreeRecord[];
      for (const r of arr) if (r && typeof r.sessionId === 'string') this.recs.set(r.sessionId, r);
    } catch { /* none yet */ }
  }
  private save() {
    try { fs.writeFileSync(this.file, JSON.stringify([...this.recs.values()], null, 2), { mode: 0o600 }); } catch { /* best effort */ }
  }
  /** The worktree of a session while it exists. */
  get(sessionId: string) { const r = this.recs.get(sessionId); return r && !r.removedAt ? r : undefined; }
  /** Also a removed worktree's record (its session stays listed under the project). */
  getAny(sessionId: string) { return this.recs.get(sessionId); }
  removedFor(root: string): WorktreeRecord[] { return [...this.recs.values()].filter((r) => r.removedAt && r.root === root); }
  markRemoved(sessionId: string) { const r = this.recs.get(sessionId); if (r && !r.removedAt) { this.recs.set(sessionId, { ...r, removedAt: Date.now() }); this.save(); } }
  add(r: WorktreeRecord) { this.recs.set(r.sessionId, r); this.save(); }
  delete(sessionId: string) { if (this.recs.delete(sessionId)) this.save(); }
}

/** HEAD commit of the checkout containing `cwd` (undefined for an unborn branch / non-repo). */
export async function headSha(cwd: string): Promise<string | undefined> {
  const root = await gitRoot(cwd);
  if (!root) return undefined;
  const r = await git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Why removing `rec` without force would be refused (uncommitted changes), or undefined when it is clean/gone. */
export async function worktreeRemovalBlock(rec: WorktreeRecord): Promise<string | undefined> {
  if (!fs.existsSync(rec.dir)) return undefined;
  const st = await git(rec.dir, ['status', '--porcelain']);
  if (st.code !== 0) return `git status failed: ${st.stderr.trim()}`;
  if (st.stdout.trim()) return 'worktree has uncommitted changes (use force to discard them)';
  return undefined;
}

/**
 * Remove a worktree created by us. Without `force` it refuses when the worktree has uncommitted/untracked
 * changes; the branch is only deleted when it has no commits of its own (or on force).
 */
export async function removeWorktree(rec: WorktreeRecord, force: boolean): Promise<WorktreeRemoval> {
  // exactly one level below <root>/.claude/worktrees (case-insensitive on Windows/macOS)
  const within = relativeInside(path.join(rec.root, '.claude', 'worktrees'), rec.dir);
  if (!within || within.includes(path.sep)) return { removed: false, branchDeleted: false, reason: 'not a workstation-managed worktree path' };
  if (!fs.existsSync(rec.dir)) {
    await git(rec.root, ['worktree', 'prune']);
    return { removed: true, branchDeleted: await deleteBranch(rec, force) };
  }
  if (!force) {
    const st = await git(rec.dir, ['status', '--porcelain']);
    if (st.code !== 0) return { removed: false, branchDeleted: false, reason: `git status failed: ${st.stderr.trim()}` };
    if (st.stdout.trim()) return { removed: false, branchDeleted: false, reason: 'worktree has uncommitted changes (use force to discard them)' };
  }
  const r = await git(rec.root, ['worktree', 'remove', ...(force ? ['--force'] : []), rec.dir], { timeout: 60_000 });
  if (r.code !== 0) return { removed: false, branchDeleted: false, reason: r.stderr.trim() || r.stdout.trim() || 'git worktree remove failed' };
  return { removed: true, branchDeleted: await deleteBranch(rec, force) };
}

async function deleteBranch(rec: WorktreeRecord, force: boolean): Promise<boolean> {
  if (!force) {
    const ahead = await git(rec.root, ['rev-list', '--count', `${rec.baseSha}..${rec.branch}`]);
    if (ahead.code !== 0 || ahead.stdout.trim() !== '0') return false; // keep the branch: it holds commits
  }
  const r = await git(rec.root, ['branch', force ? '-D' : '-d', rec.branch]);
  return r.code === 0;
}
