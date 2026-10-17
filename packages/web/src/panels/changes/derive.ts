import type { Conversation } from '../../lib/types';
import { allToolUses } from '../../lib/reducer';
import { collapseContext, diffStats, type DiffLine } from '../../lib/diff';
import { editLines } from '../../components/ToolCards';
import { toolKind, toolPath } from '../../lib/tools';
import { relPath } from '../../lib/utils';
import type { GitFileStatus } from '@workstation/protocol';
import type { GitFileDiff } from './gitdiff';

const isAbs = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
export function absPath(p: string, base: string): string {
  if (!p) return p;
  if (isAbs(p)) return p;
  const parts = (base.replace(/\/+$/, '') + '/' + p).split('/');
  const out: string[] = [];
  for (const s of parts) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return '/' + out.join('/');
}

export interface SessionFile {
  path: string; // absolute
  added: number;
  removed: number;
  isNew: boolean;
  edits: number;
  lines: DiffLine[];
}

/** Aggregate this session's successful Edit/MultiEdit/Write/NotebookEdit calls per file. */
export function sessionFiles(conv: Conversation, cwd: string): SessionFile[] {
  const byPath = new Map<string, SessionFile>();
  for (const b of allToolUses(conv)) {
    const k = toolKind(b.name);
    if (k !== 'edit' && k !== 'write') continue;
    const res = conv.toolResults[b.id];
    if (!res || res.isError) continue;
    const raw = toolPath(b);
    if (!raw) continue;
    const path = absPath(raw, cwd);
    const { lines, isNew } = editLines(b, res);
    const stats = diffStats(lines);
    const prev = byPath.get(path);
    if (!prev) { byPath.set(path, { path, added: stats.added, removed: stats.removed, isNew, edits: 1, lines: b.name === 'Write' ? lines : collapseContext(lines, 2) }); continue; }
    const body = b.name === 'Write' ? lines : collapseContext(lines, 2);
    byPath.set(path, {
      ...prev, added: prev.added + stats.added, removed: prev.removed + stats.removed, edits: prev.edits + 1,
      isNew: prev.isNew && b.name !== 'Write' ? true : prev.isNew, lines: [...prev.lines, { t: '@', text: '' }, ...body],
    });
  }
  return [...byPath.values()];
}

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
export interface ChangeFile {
  path: string; // absolute
  rel: string;
  status: ChangeStatus;
  added?: number;
  removed?: number;
  lines?: DiffLine[];
  binary?: boolean;
  bySession: boolean;
  source: 'git' | 'session';
  oldPath?: string;
}

export function porcelainStatus(f: GitFileStatus): ChangeStatus {
  const { index: x, worktree: y } = f;
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'R' || x === 'C') return 'renamed';
  if (x === 'A') return 'added';
  return 'modified';
}

export interface GitSnapshot {
  isRepo: boolean;
  root?: string;
  files: GitFileStatus[];
  /** keyed by absolute path */
  diffs: Record<string, GitFileDiff>;
}

/**
 * Merge git's view of the working tree with what this session edited.
 * - In a repo, git is the source of truth: a file this session edited that is no longer changed
 *   (committed/reverted) is dropped.
 * - Session edits outside the repo (or in a non-repo) are shown from the tool-call diffs.
 */
export function mergeChanges(cwd: string, git: GitSnapshot | null, session: SessionFile[]): ChangeFile[] {
  const sessionBy = new Map(session.map((s) => [s.path, s]));
  const out: ChangeFile[] = [];
  const seen = new Set<string>();
  const root = git?.root?.replace(/\/+$/, '');
  if (git?.isRepo && root) {
    for (const f of git.files) {
      const path = absPath(f.path.replace(/\/$/, ''), root);
      const status = porcelainStatus(f);
      const d = git.diffs[path];
      const s = sessionBy.get(path);
      seen.add(path);
      out.push({
        path, rel: relPath(path, cwd), status,
        added: d?.added ?? (status === 'untracked' ? s?.added : undefined), removed: d?.removed ?? (status === 'untracked' ? s?.removed : undefined),
        lines: d?.lines ?? (!d && s ? s.lines : undefined), binary: d?.binary, bySession: !!s, source: 'git', oldPath: d?.oldPath ? absPath(d.oldPath, root) : undefined,
      });
    }
  }
  const inRoot = (p: string) => !!root && p.startsWith(root + '/');
  for (const s of session) {
    if (seen.has(s.path)) continue;
    if (git?.isRepo && inRoot(s.path)) continue; // in the repo and clean: already committed or reverted
    out.push({ path: s.path, rel: relPath(s.path, cwd), status: s.isNew ? 'added' : 'modified', added: s.added, removed: s.removed, lines: s.lines, bySession: true, source: 'session' });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function totals(files: ChangeFile[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const f of files) { added += f.added ?? 0; removed += f.removed ?? 0; }
  return { added, removed };
}

/** Does `focus` (as passed by the "Review" button) refer to this file? */
export function matchesFocus(f: ChangeFile, focus: string | undefined, cwd: string): boolean {
  if (!focus) return false;
  const a = absPath(focus, cwd);
  return a === f.path;
}
