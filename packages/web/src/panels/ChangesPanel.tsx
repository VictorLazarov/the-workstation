import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { ls } from '../lib/storage';
import { basename, dirname } from '../lib/utils';
import { Icon } from '../components/Icon';
import { IconButton, Segmented, Spinner } from '../components/ui';
import { useSessions } from '../store/sessions';
import { useUi } from '../store/ui';
import { registerPanel, type PanelProps } from './registry';
import { matchesFocus, mergeChanges, sessionFiles, totals, type ChangeFile, type ChangeStatus } from './changes/derive';
import { FileDiff } from './changes/FileDiff';
import { refreshGit, selectGit, useGit, useGitSync, type GitState } from './changes/store';
import './panels.css';

type Mode = 'unified' | 'split';
type Scope = 'all' | 'session';
const LETTER: Record<ChangeStatus, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' };
const TITLE: Record<ChangeStatus, string> = { modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', untracked: 'Untracked (new file)' };

function useChanges(sessionId: string, cwd: string): { files: ChangeFile[]; git: GitState } {
  const conv = useSessions((s) => s.sessions[sessionId]?.conv);
  const git = useGit(selectGit(sessionId));
  const session = useMemo(() => (conv ? sessionFiles(conv, cwd) : []), [conv, cwd]);
  const files = useMemo(() => mergeChanges(cwd, git.loaded ? git : null, session), [cwd, git, session]);
  return { files, git };
}

function FileCard({ f, open, onToggle, mode, focused, canRevert, onRevert }: {
  f: ChangeFile; open: boolean; onToggle: () => void; mode: Mode; focused: boolean; canRevert: boolean; onRevert: () => void;
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
          {f.added !== undefined && <span className="stats"><span className="add">+{f.added}</span><span className="del">−{f.removed ?? 0}</span></span>}
        </button>
        <span className="cfile-actions">
          {canRevert && <IconButton icon="undo" label={f.status === 'untracked' || f.status === 'added' ? 'Delete file…' : 'Discard changes…'} size={14} onClick={onRevert} />}
        </span>
      </div>
      {open && (
        <div className="cfile-body">
          {f.binary ? <div className="cdiff-empty">Binary file</div>
            : hasBody ? <FileDiff lines={f.lines!} path={f.path} mode={mode} />
            : f.added === undefined ? <div className="cdiff-empty"><Spinner size={12} /> Loading diff…</div>
            : <div className="cdiff-empty">{f.status === 'deleted' ? 'File deleted.' : 'No textual changes.'}</div>}
        </div>
      )}
    </div>
  );
}

function CommitBox({ sessionId, cwd, count }: { sessionId: string; cwd: string; count: number }) {
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
      const r = await api.gitCommit(cwd, msg.trim());
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
        <span className="muted small">Stages and commits all {count} file{count === 1 ? '' : 's'}</span>
        <button type="button" className="btn primary" disabled={!can} onClick={submit}>{busy ? <Spinner size={12} /> : <Icon name="check" size={13} />} Commit</button>
      </div>
    </div>
  );
}

function ChangesPanel({ sessionId, cwd, focus }: PanelProps) {
  useGitSync(sessionId, cwd);
  const { files: all, git } = useChanges(sessionId, cwd);
  const [mode, setMode] = useState<Mode>(() => (ls.get('ws.diffMode') as Mode) || 'unified');
  const [scope, setScope] = useState<Scope>(() => (ls.get('ws.changesScope') as Scope) || 'all');
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [allState, setAllState] = useState<'default' | 'open' | 'closed'>('default');

  const sessionCount = all.filter((f) => f.bySession).length;
  const effScope: Scope = scope === 'session' && sessionCount > 0 && sessionCount < all.length ? 'session' : 'all';
  const files = effScope === 'session' ? all.filter((f) => f.bySession) : all;
  const tot = totals(files);
  const focusPath = focus ? files.find((f) => matchesFocus(f, focus, cwd))?.path ?? all.find((f) => matchesFocus(f, focus, cwd))?.path : undefined;
  const isOpen = (f: ChangeFile, i: number) => {
    if (f.path === focusPath) return true;
    if (f.path in toggled) return toggled[f.path];
    if (allState !== 'default') return allState === 'open';
    return files.length <= 6 || i < 3;
  };
  const setModeP = (m: Mode) => { setMode(m); ls.set('ws.diffMode', m); };
  const setScopeP = (s: Scope) => { setScope(s); ls.set('ws.changesScope', s); };
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

  if (!git.loaded && !all.length) return <div className="panel-empty"><Spinner size={18} /><span>Checking for changes…</span></div>;

  return (
    <div className="changes">
      <div className="changes-bar">
        <div className="changes-sum">
          {git.isRepo && git.branch && <span className="chip-branch" title="Current branch"><Icon name="branch" size={12} />{git.branch}</span>}
          <span><b>{files.length}</b> file{files.length === 1 ? '' : 's'}</span>
          <span className="stats"><span className="add">+{tot.added}</span><span className="del">−{tot.removed}</span></span>
        </div>
        <div className="changes-tools">
          <Segmented<Mode> value={mode} onChange={setModeP} options={[{ id: 'unified', label: 'Unified' }, { id: 'split', label: 'Split' }]} />
          <IconButton icon={anyOpen ? 'chevron-up' : 'chevron-down'} label={anyOpen ? 'Collapse all' : 'Expand all'} size={15}
            onClick={() => { setToggled({}); setAllState(anyOpen ? 'closed' : 'open'); }} />
          <IconButton icon="refresh" label="Refresh" size={15} onClick={() => void refreshGit(sessionId, cwd)} disabled={git.loading} />
        </div>
      </div>
      {sessionCount > 0 && sessionCount < all.length && (
        <div className="changes-scope" role="tablist" aria-label="Scope">
          <button type="button" role="tab" aria-selected={effScope === 'all'} className={effScope === 'all' ? 'on' : ''} onClick={() => setScopeP('all')}>All changes <i>{all.length}</i></button>
          <button type="button" role="tab" aria-selected={effScope === 'session'} className={effScope === 'session' ? 'on' : ''} onClick={() => setScopeP('session')}>This session <i>{sessionCount}</i></button>
        </div>
      )}
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
          <FileCard key={f.path} f={f} mode={mode} open={isOpen(f, i)} focused={f.path === focusPath}
            onToggle={() => setToggled({ ...toggled, [f.path]: !isOpen(f, i) })}
            canRevert={f.source === 'git' && git.isRepo && f.status !== 'renamed'} onRevert={() => void revert(f)} />
        ))}
      </div>
      {git.isRepo && all.length > 0 && <CommitBox sessionId={sessionId} cwd={cwd} count={all.length} />}
    </div>
  );
}

registerPanel({
  id: 'changes', title: 'Changes', icon: 'file-edit', order: 20, component: ChangesPanel,
  useBadge: (id) => {
    const cwd = useSessions((s) => s.sessions[id]?.cwd ?? '');
    useGitSync(id, cwd);
    const conv = useSessions((s) => s.sessions[id]?.conv);
    const git = useGit(selectGit(id));
    return useMemo(() => {
      if (!conv) return undefined;
      const n = mergeChanges(cwd, git.loaded ? git : null, sessionFiles(conv, cwd)).length;
      return n || undefined;
    }, [conv, cwd, git]);
  },
});
