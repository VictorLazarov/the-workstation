import { useCallback, useEffect, useState } from 'react';
import type { FsEntry } from '@workstation/protocol';
import { api } from '../lib/api';
import { dirname } from '../lib/utils';
import { platform } from '../platform';
import { projectName, useSessions } from '../store/sessions';
import { useUi } from '../store/ui';
import { Icon } from './Icon';
import { Dialog, Spinner } from './ui';

export function ProjectPicker() {
  const open = useUi((s) => s.pickerOpen);
  const close = () => useUi.getState().set({ pickerOpen: false });
  const projects = useSessions((s) => s.projects);
  const serverCwd = useSessions((s) => s.hello?.serverCwd);
  const [path, setPath] = useState('');
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [hidden, setHidden] = useState(false);

  const load = useCallback(async (p?: string) => {
    setLoading(true); setErr('');
    try {
      const list = await api.fsList(p);
      setEntries(list);
      const resolved = p && p !== '~' ? p : list[0] ? dirname(list[0].path) : p ?? '';
      setPath(resolved); setInput(resolved);
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { if (open) void load(serverCwd || projects[0]); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (cwd: string) => { close(); useSessions.getState().newSession(cwd); };
  const dirs = entries.filter((e) => e.kind === 'dir' && (hidden || !e.name.startsWith('.')));
  const crumbs = path.split('/').filter(Boolean);

  return (
    <Dialog open={open} onClose={close} title="Open a project" width={600} className="picker"
      footer={<><span className="picker-path" title={path}>{path}</span><button type="button" className="btn ghost" onClick={close}>Cancel</button><button type="button" className="btn primary" disabled={!path} onClick={() => choose(path)}>Open “{projectName(path) || '/'}”</button></>}>
      {(projects.length > 0 || serverCwd) && (
        <div className="picker-recent">
          <div className="picker-label">{projects.length ? 'Recent' : 'This server\'s project'}</div>
          {(serverCwd && !projects.includes(serverCwd) ? [serverCwd, ...projects] : projects).slice(0, 5).map((p) => <button type="button" key={p} className="recent-row" onClick={() => choose(p)}><Icon name="folder" size={14} /><b>{projectName(p)}</b><span>{p}</span></button>)}
        </div>
      )}
      <div className="picker-label">Browse{platform.pickFolder && <button type="button" className="link-btn" onClick={async () => { const p = await platform.pickFolder!(); if (p) choose(p); }}>System dialog…</button>}</div>
      <form className="picker-bar" onSubmit={(e) => { e.preventDefault(); void load(input); }}>
        <button type="button" className="icon-btn" aria-label="Parent folder" disabled={!path || path === '/'} onClick={() => void load(dirname(path) || '/')}><Icon name="chevron-up" size={15} /></button>
        <input className="field" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Folder path" spellCheck={false} />
        <label className="check"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> Hidden</label>
      </form>
      {crumbs.length > 0 && (
        <div className="crumbs">
          <button type="button" onClick={() => void load('/')}>/</button>
          {crumbs.map((c, i) => <button type="button" key={i} onClick={() => void load('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button>)}
        </div>
      )}
      <div className="dir-list" role="listbox" aria-label="Folders">
        {loading && <div className="dir-empty"><Spinner /> Loading…</div>}
        {err && <div className="dir-empty err">{err}</div>}
        {!loading && !err && dirs.length === 0 && <div className="dir-empty">No subfolders</div>}
        {!loading && dirs.map((d) => (
          <button type="button" role="option" aria-selected={false} key={d.path} className="dir-row" onClick={() => void load(d.path)} onDoubleClick={() => choose(d.path)}>
            <Icon name="folder" size={15} /><span>{d.name}</span><Icon name="chevron-right" size={13} />
          </button>
        ))}
      </div>
    </Dialog>
  );
}
