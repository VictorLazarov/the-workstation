import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { ls } from '../lib/storage';
import { basename, dirname } from '../lib/utils';
import { Icon } from '../components/Icon';
import { IconButton, Segmented, Spinner, Stats } from '../components/ui';
import { useSessions } from '../store/sessions';
import { useComments, useReview } from '../store/review';
import { formatReview } from '../lib/review';
import { useUi } from '../store/ui';
import { registerPanel, type PanelProps } from './registry';
import { matchesFocus, totals, type ChangeFile, type ChangeStatus } from './changes/derive';
import { FileDiff } from './changes/FileDiff';
import { refreshGit, selectGit, useBranch, useGit, useGitSync, useProjectChanges } from './changes/store';
import './panels.css';

type Mode = 'unified' | 'split';
/** Inspector width (px) from which the side-by-side diff is offered: two panes of at least ~290px plus gutters. */
export const SPLIT_MIN_WIDTH = 620;
const LETTER: Record<ChangeStatus, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' };
const TITLE: Record<ChangeStatus, string> = { modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', untracked: 'Untracked (new file)' };

function FileCard({ f, open, onToggle, mode, focused, canRevert, onRevert, sessionId, loading }: {
  loading: boolean; sessionId: string; f: ChangeFile; open: boolean; onToggle: () => void; mode: Mode; focused: boolean; canRevert: boolean; onRevert: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1600);
    return () => clearTimeout(t);
  }, [focused]);
  const dir = dirname(f.rel);
  const hasBody = !!f.lines?.length || f.binary;
  return (
    <div ref={ref} className={`cfile${open ? ' open' : ''}${flash ? ' flash' : ''}`} data-path={f.path}>
      <div className="cfile-head">
        <button type="button" className="cfile-toggle" aria-expanded={open} onClick={onToggle}>
          <Icon name="chevron-right" size={13} className="cfile-chev" />
          <span className={`cstatus cs-${f.status}`} title={TITLE[f.status]}>{LETTER[f.status]}</span>
          <span className="cfile-name" title={f.path}>
            <b>{basename(f.rel)}</b>{dir && <span className="cfile-dir">{dir}</span>}
          </span>
          {f.bySession && <span className="cdot" title="Edited in this session" />}
          <span className="cfile-spacer" />
          {f.added !== undefined && <Stats added={f.added} removed={f.removed ?? 0} />}
        </button>
        <span className="cfile-actions">
          {canRevert && <IconButton icon="undo" label={f.status === 'untracked' || f.status === 'added' ? 'Delete file…' : 'Discard changes…'} size={14} onClick={onRevert} />}
        </span>
      </div>
      {open && (
        <div className="cfile-body">
          {f.binary ? <div className="cdiff-empty">Binary file</div>
            : hasBody ? <FileDiff lines={f.lines!} path={f.path} mode={mode} review={{ sessionId, rel: f.rel, path: f.path }} />
            : f.isDir ? <div className="cdiff-empty">New folder. Its files are not listed individually.</div>
            : f.added === undefined ? (loading ? <div className="cdiff-empty"><Spinner size={12} /> Loading diff…</div> : <div className="cdiff-empty">{f.status === 'untracked' ? 'New file. No preview loaded (many new files); it is still included in Commit.' : 'No preview available.'}</div>)
            : <div className="cdiff-empty">{f.status === 'deleted' ? 'File deleted.' : 'No textual changes.'}</div>}
        </div>
      )}
    </div>
  );
}

function CommitBox({ sessionId, cwd, files }: { sessionId: string; cwd: string; files: string[] }) {
  const count = files.length;
  const [msg, setMsg] = useState(() => ls.get('ws.commitMsg.' + sessionId) ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (msg) ls.set('ws.commitMsg.' + sessionId, msg); else ls.del('ws.commitMsg.' + sessionId); }, [msg, sessionId]);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const f = () => box.current?.focus(); window.addEventListener('ws:focus-commit', f); return () => window.removeEventListener('ws:focus-commit', f); }, []);
  const can = msg.trim().length > 0 && count > 0 && !busy;
  const submit = async () => {
    if (!can) return;
    setBusy(true); setErr('');
    try {
      const r = await api.gitCommit(cwd, msg.trim(), files);
      useUi.getState().toast({ kind: 'success', title: `Committed ${r.commit}`, body: r.summary || msg.trim().split('\n')[0] });
      setMsg('');
      await refreshGit(sessionId, cwd);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="ccommit">
      <textarea ref={box} value={msg} rows={2} placeholder="Commit message" aria-label="Commit message" onChange={(e) => setMsg(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }} />
      {err && <div className="ccommit-err" role="alert">{err}</div>}
      <div className="ccommit-row">
        <span className="muted small" title="Only the files listed here are staged and committed. Your repository's git hooks run.">Stages and commits these {count} file{count === 1 ? '' : 's'}</span>
        <button type="button" className="btn primary" disabled={!can} onClick={submit}>{busy ? <Spinner size={12} /> : <Icon name="check" size={13} />} Commit</button>
      </div>
    </div>
  );
}

/** Comments left on diff lines: one button sends them all to the agent as a single prompt. */
function ReviewBar({ sessionId }: { sessionId: string }) {
  const comments = useComments(sessionId);
  const busy = useSessions((s) => s.sessions[sessionId]?.runtime.status !== 'idle');
  if (!comments.length) return null;
  const send = () => {
    useSessions.getState().send(sessionId, formatReview(comments));
    useReview.getState().clear(sessionId);
    requestAnimationFrame(() => window.dispatchEvent(new Event('ws:focus-composer'))); // the button is about to disappear: focus goes back to the composer, not <body>
    useUi.getState().toast({ kind: 'success', title: 'Review sent', body: `${comments.length} comment${comments.length === 1 ? '' : 's'} went to the agent as one message.` });
  };
  return (
    <div className="review-bar" role="group" aria-label="Review comments">
      <span className="review-count" title="All comments go to the agent as one message"><b>{comments.length}</b> comment{comments.length === 1 ? '' : 's'}</span>
      {busy && <span className="muted small review-note">Sent when the agent is idle</span>}
      <span className="cfile-spacer" />
      <button type="button" className="btn ghost" onClick={() => useReview.getState().clear(sessionId)}>Discard</button>
      <button type="button" className="btn primary" onClick={send}><Icon name="arrow-up" size={13} /> Send to agent</button>
    </div>
  );
}

function ChangesPanel({ sessionId, cwd, focus }: PanelProps) {
  useGitSync(sessionId, cwd);
  const { files: all, git, commitFiles } = useProjectChanges(sessionId, cwd);
  const branch = useBranch(sessionId);
  const gone = useSessions((x) => !!x.sessions[sessionId]?.wtRemoved);
  const [mode, setMode] = useState<Mode>(() => (ls.get('ws.diffMode') as Mode) || 'unified');
  // Split needs room for two readable panes; in a narrow inspector it falls back to unified (the preference is kept).
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    if (!root || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(root.clientWidth));
    ro.observe(root); setWidth(root.clientWidth);
    return () => ro.disconnect();
  }, [root]);
  const canSplit = width >= SPLIT_MIN_WIDTH;
  const shownMode: Mode = mode === 'split' && canSplit ? 'split' : 'unified';
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [allState, setAllState] = useState<'default' | 'open' | 'closed'>('default');

  // One list, one count, one commit set: the files shown are exactly what Commit stages. (Files edited in this session carry a dot.)
  const files = all;
  const tot = totals(files);
  const focusPath = focus ? files.find((f) => matchesFocus(f, focus, cwd))?.path ?? all.find((f) => matchesFocus(f, focus, cwd))?.path : undefined;
  const isOpen = (f: ChangeFile, i: number) => {
    if (f.path === focusPath) return true;
    if (f.path in toggled) return toggled[f.path];
    if (allState !== 'default') return allState === 'open';
    return files.length <= 6 || i < 3;
  };
  const setModeP = (m: Mode) => { setMode(m); ls.set('ws.diffMode', m); };
  const anyOpen = files.some((f, i) => isOpen(f, i));

  const revert = async (f: ChangeFile) => {
    const del = f.status === 'untracked' || f.status === 'added';
    const ok = await useUi.getState().ask({
      title: del ? `Delete ${basename(f.rel)}?` : `Discard changes to ${basename(f.rel)}?`,
      body: del ? 'This file is new. It will be permanently deleted from disk.' : 'The file will be restored to its last committed version. Uncommitted edits are lost and this cannot be undone.',
      details: [f.rel], confirmLabel: del ? 'Delete file' : 'Discard changes', danger: true,
    });
    if (!ok) return;
    try {
      await api.gitRevert(cwd, f.path);
      useUi.getState().toast({ kind: 'success', title: del ? 'File deleted' : 'Changes discarded', body: f.rel });
    } catch (e) { useUi.getState().toast({ kind: 'error', title: 'Could not revert', body: e instanceof Error ? e.message : String(e) }); }
    await refreshGit(sessionId, cwd);
  };

  if (gone) return <div className="panel-empty"><Icon name="file-edit" size={22} /><b>Worktree removed</b><span>Its changes are gone with it.</span></div>;
  if (!git.loaded && !all.length) return <div className="panel-empty"><Spinner size={18} /><span>Checking for changes…</span></div>;

  return (
    <div className="changes" ref={setRoot}>
      <div className="changes-bar">
        <div className="changes-sum">
          {git.isRepo && branch && <span className="chip-branch" title="Current branch"><Icon name="branch" size={12} />{branch}</span>}
          <span><b>{files.length}</b> file{files.length === 1 ? '' : 's'}</span>
          <Stats added={tot.added} removed={tot.removed} />
        </div>
        <div className="changes-tools">
          {files.length > 0 && <Segmented<Mode> value={shownMode} onChange={setModeP} options={[{ id: 'unified', label: 'Unified' }, { id: 'split', label: 'Split', disabled: !canSplit, title: canSplit ? undefined : 'Split needs a wider inspector: drag its edge to widen it' }]} />}
          {files.length > 0 && <IconButton icon={anyOpen ? 'chevron-up' : 'chevron-down'} label={anyOpen ? 'Collapse all' : 'Expand all'} size={15}
            onClick={() => { setToggled({}); setAllState(anyOpen ? 'closed' : 'open'); }} />}
          <IconButton icon="refresh" label="Refresh" size={15} onClick={() => void refreshGit(sessionId, cwd)} disabled={git.loading} />
        </div>
      </div>
      {git.loaded && !git.isRepo && files.length > 0 && <div className="changes-note"><Icon name="info" size={13} /> Not a git repository. Showing edits made in this session.</div>}
      {git.error && <div className="changes-note err"><Icon name="alert" size={13} /> {git.error}</div>}
      <div className="changes-list">
        {files.length === 0 ? (
          <div className="panel-empty">
            <Icon name="file-edit" size={22} />
            <b>No changes</b>
            <span>{git.isRepo ? 'The working tree is clean. Files Claude edits will appear here for review.' : 'Files Claude edits will appear here for review.'}</span>
          </div>
        ) : files.map((f, i) => (
          <FileCard key={f.path} sessionId={sessionId} f={f} mode={shownMode} open={isOpen(f, i)} focused={f.path === focusPath}
            onToggle={() => setToggled({ ...toggled, [f.path]: !isOpen(f, i) })}
            loading={git.loading} canRevert={f.source === 'git' && git.isRepo && f.status !== 'renamed' && !f.isDir} onRevert={() => void revert(f)} />
        ))}
      </div>
      {!!git.untrackedMore && <div className="changes-note"><Icon name="info" size={13} /> and {git.untrackedMore} more new file{git.untrackedMore === 1 ? '' : 's'} not shown. They are not included in Commit.</div>}
      <ReviewBar sessionId={sessionId} />
      {git.isRepo && commitFiles.length > 0 && <CommitBox sessionId={sessionId} cwd={cwd} files={commitFiles} />}
    </div>
  );
}

registerPanel({
  id: 'changes', title: 'Changes', icon: 'file-edit', order: 20, component: ChangesPanel,
  useBadge: (id) => {
    const cwd = useSessions((s) => s.sessions[id]?.cwd ?? '');
    useGitSync(id, cwd);
    return useProjectChanges(id, cwd).count || undefined;
  },
});
