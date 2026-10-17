import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { api } from '../../lib/api';
import { useSessions } from '../../store/sessions';
import { absPath, projectChanges, resolveBranch, type GitSnapshot, type ProjectChanges } from './derive';
import { parseGitDiff } from './gitdiff';

export interface GitState extends GitSnapshot { loading: boolean; loaded: boolean; error?: string; branch?: string; at: number }
const blank: GitState = { isRepo: false, files: [], diffs: {}, loading: false, loaded: false, at: 0 };

interface Store { bySession: Record<string, GitState>; set: (id: string, p: Partial<GitState>) => void }
export const useGit = create<Store>((set, get) => ({
  bySession: {},
  set: (id, p) => set({ bySession: { ...get().bySession, [id]: { ...(get().bySession[id] ?? blank), ...p } } }),
}));
export const selectGit = (id: string) => (s: Store): GitState => s.bySession[id] ?? blank;

const inflight = new Map<string, { again: boolean }>();
const MAX_UNTRACKED = 40;

/** Load git status + diffs for a session's cwd. Concurrent calls coalesce (one trailing re-run). */
export async function refreshGit(id: string, cwd: string): Promise<void> {
  const running = inflight.get(id);
  if (running) { running.again = true; return; }
  const ctl = { again: false };
  inflight.set(id, ctl);
  useGit.getState().set(id, { loading: true });
  try {
    do {
      ctl.again = false;
      const st = await api.gitStatus(cwd);
      if (!st.isRepo) { useGit.getState().set(id, { isRepo: false, files: [], diffs: {}, root: undefined, branch: undefined, loaded: true, error: undefined, at: Date.now() }); continue; }
      const root = st.root ?? cwd;
      const diffs: GitState['diffs'] = {};
      if (st.files.length) {
        const tracked = await api.gitDiff(cwd).catch(() => ({ diff: '' }));
        for (const d of parseGitDiff(tracked.diff)) diffs[absPath(d.path, root)] = d;
        const untracked = st.files.filter((f) => f.index === '?' && f.worktree === '?' && !f.path.endsWith('/')).slice(0, MAX_UNTRACKED);
        await Promise.all(untracked.map(async (f) => {
          const abs = absPath(f.path, root);
          const r = await api.gitDiff(cwd, abs).catch(() => null);
          const parsed = r ? parseGitDiff(r.diff)[0] : undefined;
          if (parsed) diffs[abs] = { ...parsed, status: 'added' };
        }));
      }
      useGit.getState().set(id, { isRepo: true, root, files: st.files, diffs, branch: st.branch, loaded: true, error: undefined, at: Date.now() });
    } while (ctl.again);
  } catch (e) {
    useGit.getState().set(id, { loaded: true, error: e instanceof Error ? e.message : String(e) });
  } finally {
    inflight.delete(id);
    useGit.getState().set(id, { loading: false });
  }
}

/**
 * Keeps the git snapshot fresh: on mount, window focus, turn end and whenever a tool result lands
 * (Bash can modify files too). Safe to call from several components; refreshes coalesce.
 */
export function useGitSync(id: string, cwd: string) {
  const status = useSessions((s) => s.sessions[id]?.runtime.status);
  const turns = useSessions((s) => s.sessions[id]?.conv.usage.turns);
  const results = useSessions((s) => Object.keys(s.sessions[id]?.conv.toolResults ?? {}).length);
  useEffect(() => {
    if (!cwd) return;
    const t = setTimeout(() => void refreshGit(id, cwd), 350);
    return () => clearTimeout(t);
  }, [id, cwd, status, turns, results]);
  useEffect(() => {
    if (!cwd) return;
    const back = () => void refreshGit(id, cwd); // the server was away: status requests failed meanwhile
    window.addEventListener('ws:reconnected', back);
    return () => window.removeEventListener('ws:reconnected', back);
  }, [id, cwd]);
  useEffect(() => {
    if (!cwd) return;
    const on = () => { if (!document.hidden) void refreshGit(id, cwd); };
    window.addEventListener('focus', on);
    document.addEventListener('visibilitychange', on);
    return () => { window.removeEventListener('focus', on); document.removeEventListener('visibilitychange', on); };
  }, [id, cwd]);
}

/**
 * The ONE branch a session shows (topbar, Overview > Environment, Changes header, empty-session header).
 * Source of truth: the worktree branch when the session runs in one, else the live `git status` of its checkout.
 * Until git has answered (or if it cannot), fall back to the branch recorded in the session metadata.
 */
export function useBranch(id: string): string | undefined {
  const worktree = useSessions((s) => s.sessions[id]?.conv.init?.worktree?.branch);
  const recorded = useSessions((s) => s.sessions[id]?.branch);
  const git = useGit(selectGit(id));
  return resolveBranch({ worktree, recorded, git });
}

/** The shared, memoised project-changes view of a session (see projectChanges). */
export function useProjectChanges(id: string, cwd: string): ProjectChanges & { git: GitState } {
  const conv = useSessions((s) => s.sessions[id]?.conv);
  const worktree = useSessions((s) => s.sessions[id]?.conv.init?.worktree?.path);
  const git = useGit(selectGit(id));
  const view = useMemo(() => (conv ? projectChanges(conv, cwd, git.loaded ? git : null, worktree) : { files: [], count: 0, added: 0, removed: 0, commitFiles: [], outputs: [], planFiles: [] }), [conv, cwd, git, worktree]);
  return { ...view, git };
}
