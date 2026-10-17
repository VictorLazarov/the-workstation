import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@workstation/protocol';
import { fuzzy, relativeTime } from '../lib/utils';
import { projectName, sessionStatus, useSessions, type SessionStatus } from '../store/sessions';
import { sidebarIsDrawer, useUi, type Brand, type Density, type Theme } from '../store/ui';
import { Icon } from './Icon';
import { newSessionShortcut } from '../lib/shortcuts';
import { IconButton, MenuList, Popover, Segmented, Spinner, useOutsideClose, type MenuEntry } from './ui';
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
  const left = Math.max(8, Math.min(x, window.innerWidth - 228)), top = Math.max(8, Math.min(y, window.innerHeight - 220));
  return createPortal(<div ref={ref} className="popover" style={{ position: 'fixed', left, top }}><MenuList items={items} onClose={onClose} /></div>, document.body);
}

const STATUS_LABEL: Record<SessionStatus, string> = { running: 'Running', 'needs-input': 'Needs your input', error: 'Error', done: 'Finished, unread', idle: '', starting: 'Starting' };

/** Right-hand status glyph of a session row: violet spinner = running, blue dot = needs you, branch glyph = idle. */
function RowStatus({ e }: { e: Entry }) {
  switch (e.status) {
    case 'running': return <span className="sess-st st-run" title="Running"><Spinner size={12} /><span className="run-text sr-only">Running</span></span>;
    case 'starting': return <span className="sess-st" title="Starting"><Spinner size={12} /><span className="sr-only">Starting</span></span>;
    case 'needs-input': return <span className="sess-st sess-attn" title="Needs your input"><i className="st-dot st-attn" /><span className="attn-text">Needs input</span></span>;
    case 'error': return <span className="sess-st" title="Error"><i className="st-dot st-error" /><span className="sr-only">Error</span></span>;
    case 'done': return <span className="sess-st" title="Finished, unread"><i className="st-dot st-done" /><span className="sr-only">Finished, unread</span></span>;
    default: return e.branch && !/^(main|master)$/.test(e.branch) ? <span className="sess-st sess-branch"><Icon name="branch" size={12} /></span> : null;
  }
}

function AppearanceMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const theme = useUi((s) => s.theme);
  const brand = useUi((s) => s.brand);
  const density = useUi((s) => s.density);
  return (
    <>
      <button ref={ref} type="button" className={`icon-btn${open ? ' active' : ''}`} aria-label="Appearance" title="Appearance: theme, brand, density" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="sliders" size={15} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} className="appearance">
        <div className="appearance-body" role="dialog" aria-label="Appearance">
          <div className="ap-row"><span>Theme</span><Segmented<Theme> value={theme} onChange={(t) => useUi.getState().setTheme(t)} options={[{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]} /></div>
          <div className="ap-row"><span>Brand</span><Segmented<Brand> value={brand} onChange={(b) => useUi.getState().setBrand(b)} options={[{ id: 'horizon', label: 'Horizon' }, { id: 'warm', label: 'Warm' }]} /></div>
          <div className="ap-row"><span>Density</span><Segmented<Density> value={density} onChange={(d) => useUi.getState().setDensity(d)} options={[{ id: 'compact', label: 'Compact' }, { id: 'comfortable', label: 'Comfortable' }]} /></div>
        </div>
      </Popover>
    </>
  );
}

export function Sidebar() {
  const entries = useEntries();
  const projects = useSessions((s) => s.projects);
  const activeId = useSessions((s) => s.activeId);
  const conn = useSessions((s) => s.conn);
  const serverCwd = useSessions((s) => s.hello?.serverCwd);
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

  // On a narrow window the sidebar is a drawer: choosing something closes it.
  const dismissDrawer = () => { if (sidebarIsDrawer()) useUi.getState().set({ sidebarOpen: false }); };
  const open = (e: Entry) => { dismissDrawer(); if (e.summary) openSession({ ...e.summary, live: e.live }); else setActive(e.id); };

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
    dismissDrawer();
    if (cwd) newSession(cwd); else useUi.getState().set({ pickerOpen: true });
  };

  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-head">
        <div className="brand"><span className="brand-mark" aria-hidden="true" /><span className="brand-name serif">Workstation</span></div>
        <IconButton icon="sidebar" label="Hide sidebar (Ctrl+B)" onClick={() => useUi.getState().set({ sidebarOpen: false })} />
      </div>
      <div className="side-quick">
        <button type="button" className="qa" onClick={startNew} title={`New session (${newSessionShortcut()})`}><Icon name="plus" size={15} /><span>New session</span></button>
        <label className="qa search">
          <Icon name="search" size={15} />
          <input value={query} onChange={(e) => useUi.getState().set({ sidebarQuery: e.target.value })} placeholder="Search" aria-label="Search sessions" />
          {query && <IconButton icon="x" label="Clear search" size={12} onClick={() => useUi.getState().set({ sidebarQuery: '' })} />}
        </label>
      </div>
      <nav className="sidebar-list">
        {groups.length === 0 && (
          <div className="sidebar-empty">
            {query ? 'No sessions match.' : conn === 'open' ? 'No projects yet.' : 'Connecting…'}
            {!query && serverCwd && <button type="button" className="btn primary" title={serverCwd} onClick={() => useSessions.getState().newSession(serverCwd)}>Open {projectName(serverCwd)}</button>}
            {!query && <button type="button" className="btn" onClick={() => useUi.getState().set({ pickerOpen: true })}>{serverCwd ? 'Choose another folder' : 'Open a project'}</button>}
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
                  <Icon name="chevron-down" size={11} className={`proj-chev${isC ? ' closed' : ''}`} />
                  <span className="proj-name">{projectName(g.cwd)}</span>
                  {running > 0 && <span className="proj-live" title={`${running} running or waiting`}>{running}</span>}
                </button>
                <IconButton icon="plus" label={`New session in ${projectName(g.cwd)}`} size={14} className="proj-add" onClick={() => newSession(g.cwd)} />
              </div>
              {!isC && (
                <ul className="sess-list">
                  {g.es.slice(0, limit).map((e) => (
                    <li key={e.id} className="sess-item">
                      <button
                        type="button" className={`sess${activeId === e.id ? ' active' : ''}${e.status === 'needs-input' ? ' attn' : ''}${e.status === 'running' ? ' run' : ''}`}
                        onClick={() => open(e)} onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, e }); }}
                        onKeyDown={(ev) => { if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) { ev.preventDefault(); const r = ev.currentTarget.getBoundingClientRect(); setMenu({ x: r.left + 24, y: r.bottom, e }); } }}
                        aria-current={activeId === e.id ? 'true' : undefined}
                        title={[e.title, [e.branch, relativeTime(e.time)].filter(Boolean).join(' · '), STATUS_LABEL[e.status]].filter(Boolean).join('\n')}
                      >
                        <span className="sess-title">{e.title}</span>
                        <RowStatus e={e} />
                        <span className="sess-hover" aria-hidden="true">
                          <span className="sess-time">{relativeTime(e.time)}</span>
                        </span>
                      </button>
                      <button type="button" className="sess-more" aria-label={`Actions for ${e.title}`} aria-haspopup="menu" onClick={(ev) => { const r = ev.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4, e }); }}><Icon name="more" size={15} /></button>
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
        <div className="foot-icons">
          <IconButton icon="search" label="Command palette (Ctrl+K)" onClick={() => useUi.getState().set({ paletteOpen: true })} />
          <AppearanceMenu />
          <IconButton icon="settings" label="Settings (Ctrl+,)" onClick={() => useUi.getState().set({ settingsOpen: true })} />
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.e)} onClose={() => setMenu(null)} />}
    </aside>
  );
}
