import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@workstation/protocol';
import { fuzzy, relativeTime } from '../lib/utils';
import { projectName, sessionStatus, useSessions, type SessionStatus } from '../store/sessions';
import { useUi } from '../store/ui';
import { Icon } from './Icon';
import { IconButton, MenuList, StatusDot, useOutsideClose, type MenuEntry } from './ui';
import { createPortal } from 'react-dom';

interface Entry {
  id: string; title: string; cwd: string; branch?: string; time: number; status: SessionStatus; summary?: SessionSummary; live: boolean;
}

function useEntries(): Entry[] {
  const sessions = useSessions((s) => s.sessions);
  const summaries = useSessions((s) => s.summaries);
  return useMemo(() => {
    const m = new Map<string, Entry>();
    for (const s of summaries) m.set(s.sessionId, { id: s.sessionId, title: s.title, cwd: s.cwd ?? '', branch: s.gitBranch, time: s.lastModified, status: 'idle', summary: s, live: s.live });
    for (const s of Object.values(sessions)) {
      const prev = m.get(s.id);
      m.set(s.id, { id: s.id, title: s.title || prev?.title || 'Session', cwd: s.cwd || prev?.cwd || '', branch: s.branch ?? prev?.branch, time: Math.max(s.lastActivity, prev?.time ?? 0), status: sessionStatus(s), summary: prev?.summary, live: s.live });
    }
    return [...m.values()];
  }, [sessions, summaries]);
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, onClose, true);
  const left = Math.min(x, window.innerWidth - 220), top = Math.min(y, window.innerHeight - 220);
  return createPortal(<div ref={ref} className="popover" style={{ position: 'fixed', left, top }}><MenuList items={items} onClose={onClose} /></div>, document.body);
}

export function Sidebar() {
  const entries = useEntries();
  const projects = useSessions((s) => s.projects);
  const activeId = useSessions((s) => s.activeId);
  const conn = useSessions((s) => s.conn);
  const { openSession, newSession, setActive, renameSession, deleteSession, forkSession } = useSessions.getState();
  const query = useUi((s) => s.sidebarQuery);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; e: Entry } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);

  const groups = useMemo(() => {
    const by = new Map<string, Entry[]>();
    for (const p of projects) by.set(p, []);
    for (const e of entries) {
      if (!e.cwd) continue;
      if (query) { const hay = `${e.title} ${e.branch ?? ''} ${projectName(e.cwd)}`; if (fuzzy(query, hay) < 0) continue; }
      (by.get(e.cwd) ?? by.set(e.cwd, []).get(e.cwd)!).push(e);
    }
    const list = [...by.entries()].map(([cwd, es]) => ({ cwd, es: es.sort((a, b) => b.time - a.time) }));
    return list.filter((g) => !query || g.es.length).sort((a, b) => (b.es[0]?.time ?? 0) - (a.es[0]?.time ?? 0));
  }, [entries, projects, query]);

  const open = (e: Entry) => (e.summary ? openSession({ ...e.summary, live: e.live }) : setActive(e.id));

  const rename = async (e: Entry) => {
    const t = await useUi.getState().askText({ title: 'Rename session', initial: e.title, confirmLabel: 'Rename' });
    if (t && t.trim()) {
      if (!useSessions.getState().sessions[e.id]) openSession({ ...(e.summary as SessionSummary) });
      void renameSession(e.id, t.trim());
    }
  };
  const del = async (e: Entry) => {
    const ok = await useUi.getState().ask({ title: 'Delete this session?', body: `“${e.title}” and its history will be permanently removed.`, confirmLabel: 'Delete', danger: true });
    if (ok) void deleteSession(e.id);
  };
  const menuItems = (e: Entry): MenuEntry[] => [
    { id: 'open', label: 'Open', icon: 'chat', onSelect: () => open(e) },
    { id: 'rename', label: 'Rename…', icon: 'pencil', onSelect: () => void rename(e) },
    { id: 'fork', label: 'Fork session', icon: 'fork', onSelect: () => forkSession(e.id) },
    'sep',
    { id: 'delete', label: 'Delete…', icon: 'trash', danger: true, onSelect: () => void del(e) },
  ];

  const first = projects[0];
  const startNew = () => {
    const cwd = (activeId && useSessions.getState().sessions[activeId]?.cwd) || first;
    if (cwd) newSession(cwd); else useUi.getState().set({ pickerOpen: true });
  };

  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-head">
        <div className="brand"><span className="brand-mark" aria-hidden="true" /><span className="brand-name serif">Workstation</span></div>
        <IconButton icon="sidebar" label="Hide sidebar (Ctrl+B)" onClick={() => useUi.getState().set({ sidebarOpen: false })} />
      </div>
      <div className="sidebar-actions">
        <button type="button" className="btn primary block" onClick={startNew}><Icon name="plus" size={15} /> New session</button>
        <div className="search">
          <Icon name="search" size={14} />
          <input value={query} onChange={(e) => useUi.getState().set({ sidebarQuery: e.target.value })} placeholder="Search sessions" aria-label="Search sessions" />
          {query && <IconButton icon="x" label="Clear search" size={12} onClick={() => useUi.getState().set({ sidebarQuery: '' })} />}
        </div>
      </div>
      <nav className="sidebar-list">
        {groups.length === 0 && (
          <div className="sidebar-empty">
            {query ? 'No sessions match.' : conn === 'open' ? 'No projects yet.' : 'Connecting…'}
            {!query && <button type="button" className="btn" onClick={() => useUi.getState().set({ pickerOpen: true })}>Open a project</button>}
          </div>
        )}
        {groups.map((g) => {
          const isC = collapsed[g.cwd];
          const limit = showAll[g.cwd] || query ? 99 : 6;
          const running = g.es.filter((e) => e.status === 'running' || e.status === 'needs-input').length;
          return (
            <section key={g.cwd} className="proj">
              <div className="proj-head">
                <button type="button" className="proj-toggle" onClick={() => setCollapsed({ ...collapsed, [g.cwd]: !isC })} aria-expanded={!isC} title={g.cwd}>
                  <Icon name="chevron-down" size={12} className={`proj-chev${isC ? ' closed' : ''}`} />
                  <Icon name="folder" size={14} /><span className="proj-name">{projectName(g.cwd)}</span>
                  {running > 0 && <span className="proj-live">{running}</span>}
                </button>
                <IconButton icon="plus" label={`New session in ${projectName(g.cwd)}`} size={14} className="proj-add" onClick={() => newSession(g.cwd)} />
              </div>
              {!isC && (
                <ul className="sess-list">
                  {g.es.slice(0, limit).map((e) => (
                    <li key={e.id}>
                      <button
                        type="button" className={`sess${activeId === e.id ? ' active' : ''}${e.status === 'needs-input' ? ' attn' : ''}`}
                        onClick={() => open(e)} onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, e }); }}
                        aria-current={activeId === e.id ? 'true' : undefined}
                      >
                        <StatusDot status={e.status} />
                        <span className="sess-main">
                          <span className="sess-title">{e.title}</span>
                          <span className="sess-meta">
                            {e.status === 'needs-input' ? <b className="attn-text">Needs input</b> : e.status === 'running' ? <b className="run-text">Running</b> : null}
                            {e.branch && <><Icon name="branch" size={11} />{e.branch}</>}
                          </span>
                        </span>
                        <span className="sess-time">{relativeTime(e.time)}</span>
                        <span className="sess-more" role="button" tabIndex={-1} aria-label="Session actions" onClick={(ev) => { ev.stopPropagation(); const r = ev.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4, e }); }}><Icon name="more" size={15} /></span>
                      </button>
                    </li>
                  ))}
                  {g.es.length === 0 && <li className="sess-none">No sessions yet</li>}
                  {g.es.length > limit && <li><button type="button" className="sess-showall" onClick={() => setShowAll({ ...showAll, [g.cwd]: true })}>Show {g.es.length - limit} more</button></li>}
                </ul>
              )}
            </section>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        <button type="button" className="foot-btn" onClick={() => useUi.getState().set({ pickerOpen: true })}><Icon name="folder-open" size={15} /> Open project</button>
        <IconButton icon="settings" label="Settings (Ctrl+,)" onClick={() => useUi.getState().set({ settingsOpen: true })} />
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.e)} onClose={() => setMenu(null)} />}
    </aside>
  );
}
