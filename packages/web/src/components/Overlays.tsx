import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzy, isMac, modelLabel, relativeTime } from '../lib/utils';
import { clearRemoteServer, getRemoteServer } from '../lib/storage';
import { projectName, useActiveSession, useSessions } from '../store/sessions';
import { useUi } from '../store/ui';
import { Icon, type IconName } from './Icon';
import { Dialog, IconButton, Kbd, Spinner } from './ui';
import { MODES } from './Chips';

/* ───────── toasts ───────── */
export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : t.kind === 'attention' ? 'shield' : 'info'} size={16} />
          <div className="toast-text"><b>{t.title}</b>{t.body && <span>{t.body}</span>}</div>
          {t.action && <button type="button" className="link-btn" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
          <IconButton icon="x" label="Dismiss" size={13} onClick={() => dismiss(t.id)} />
        </div>
      ))}
    </div>
  );
}

/* ───────── confirm / prompt ───────── */
export function ConfirmHost() {
  const c = useUi((s) => s.confirm);
  const p = useUi((s) => s.prompt);
  const [val, setVal] = useState('');
  useEffect(() => { if (p) setVal(p.initial ?? ''); }, [p]);
  return (
    <>
      <Dialog open={!!c} onClose={() => c?.resolve(false)} title={c?.title} width={440}
        footer={<><button type="button" className="btn ghost" onClick={() => c?.resolve(false)}>Cancel</button><button type="button" className={`btn ${c?.danger ? 'danger-solid' : 'primary'}`} onClick={() => c?.resolve(true)} autoFocus>{c?.confirmLabel ?? 'Confirm'}</button></>}>
        {c?.body && <p className="dlg-p">{c.body}</p>}
        {c?.details && c.details.length > 0 && <ul className="dlg-list">{c.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
      </Dialog>
      <Dialog open={!!p} onClose={() => p?.resolve(null)} title={p?.title} width={420}
        footer={<><button type="button" className="btn ghost" onClick={() => p?.resolve(null)}>Cancel</button><button type="button" className="btn primary" onClick={() => p?.resolve(val)}>{p?.confirmLabel ?? 'OK'}</button></>}>
        <input className="field" autoFocus value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') p?.resolve(val); }} aria-label={p?.label ?? p?.title} />
      </Dialog>
    </>
  );
}

/* ───────── reconnect banner ───────── */
export function ConnectionBanner() {
  const conn = useSessions((s) => s.conn);
  const ready = useSessions((s) => s.ready);
  const cfgErr = useSessions((s) => s.configError);
  const [grace, setGrace] = useState(false);
  useEffect(() => { const t = setTimeout(() => setGrace(true), 900); return () => clearTimeout(t); }, []);
  const remote = getRemoteServer();
  if (remote && conn === 'open' && !cfgErr) {
    // Security: always show which non-same-origin server receives the token (B1). Switch back in Settings.
    return (
      <div className="conn-banner" role="status" data-testid="remote-server-banner">
        <Icon name="alert" size={14} />
        <span>Connected to another server: <b>{remote.origin}</b></span>
        <button type="button" className="link-btn" onClick={() => { clearRemoteServer(); location.reload(); }}>Use this page's server</button>
      </div>
    );
  }
  if (conn === 'open' && !cfgErr) return null;
  if (!grace && !ready) return null;
  return (
    <div className="conn-banner" role="alert">
      {conn === 'open' ? <Icon name="alert" size={14} /> : <Spinner size={13} />}
      <span>{conn === 'open' ? `Server error: ${cfgErr}. Check your access token.` : ready ? 'Connection lost. Reconnecting…' : 'Connecting to the server…'}</span>
      {conn !== 'open' && <button type="button" className="link-btn" onClick={() => useSessions.getState().reconnectNow()}>Retry now</button>}
    </div>
  );
}

/* ───────── shortcuts ───────── */
export function shortcutList(): { keys: string; label: string }[] {
  const m = isMac() ? '⌘' : 'Ctrl';
  return [
    { keys: `${m} K`, label: 'Command palette' },
    { keys: `${m} N`, label: 'New session' },
    { keys: `${m} O`, label: 'Open project' },
    { keys: `${m} B`, label: 'Toggle sidebar' },
    { keys: `${m} Alt B`, label: 'Toggle inspector' },
    { keys: `${m} ,`, label: 'Settings' },
    { keys: `${m} 1-9`, label: 'Jump to session in sidebar order' },
    { keys: `${m} Enter`, label: 'Allow the pending permission request' },
    { keys: 'Shift Tab', label: 'Cycle permission mode (in composer)' },
    { keys: 'Esc', label: 'Stop the running agent (empty composer)' },
    { keys: '@', label: 'Mention a file' },
    { keys: '/', label: 'Commands and skills' },
    { keys: `${m} /`, label: 'This list' },
  ];
}
export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  return (
    <Dialog open={open} onClose={() => useUi.getState().set({ shortcutsOpen: false })} title="Keyboard shortcuts" width={460}>
      <dl className="shortcuts">
        {shortcutList().map((s) => <div key={s.label}><dt>{s.keys.split(' ').map((k, i) => <Kbd key={i}>{k}</Kbd>)}</dt><dd>{s.label}</dd></div>)}
      </dl>
    </Dialog>
  );
}

/* ───────── command palette ───────── */
interface Cmd { id: string; label: string; hint?: string; icon: IconName; group: string; run: () => void; keywords?: string }

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const close = () => useUi.getState().set({ paletteOpen: false });
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const sessions = useSessions((s) => s.sessions);
  const summaries = useSessions((s) => s.summaries);
  const projects = useSessions((s) => s.projects);
  const models = useSessions((s) => s.models);
  const active = useActiveSession();
  const theme = useUi((s) => s.theme);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) { setQ(''); setIdx(0); } }, [open]);

  const cmds = useMemo<Cmd[]>(() => {
    if (!open) return [];
    const S = useSessions.getState(), U = useUi.getState();
    const out: Cmd[] = [
      { id: 'new', label: 'New session', icon: 'plus', group: 'Actions', hint: isMac() ? '⌘N' : 'Ctrl N', run: () => { const c = active?.cwd ?? projects[0]; c ? S.newSession(c) : U.set({ pickerOpen: true }); } },
      { id: 'open', label: 'Open project…', icon: 'folder-open', group: 'Actions', run: () => U.set({ pickerOpen: true }) },
      { id: 'sidebar', label: 'Toggle sidebar', icon: 'sidebar', group: 'View', run: () => U.set({ sidebarOpen: !U.sidebarOpen }) },
      { id: 'inspector', label: 'Toggle inspector', icon: 'panel-right', group: 'View', run: () => U.set({ inspectorOpen: !U.inspectorOpen }) },
      { id: 'settings', label: 'Settings', icon: 'settings', group: 'Actions', run: () => U.set({ settingsOpen: true }) },
      { id: 'keys', label: 'Keyboard shortcuts', icon: 'command', group: 'Actions', run: () => U.set({ shortcutsOpen: true }) },
      ...(['light', 'dark', 'system'] as const).map((t): Cmd => ({ id: 'theme-' + t, label: `Theme: ${t[0].toUpperCase() + t.slice(1)}`, icon: t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'monitor', group: 'View', hint: theme === t ? 'current' : undefined, run: () => U.setTheme(t) })),
    ];
    if (active) {
      for (const m of MODES) out.push({ id: 'mode-' + m.id, label: `Mode: ${m.label}`, icon: m.icon, group: 'Session', keywords: 'permission', hint: active.runtime.permissionMode === m.id ? 'current' : undefined, run: () => S.setMode(active.id, m.id) });
      for (const m of models) out.push({ id: 'model-' + m.id, label: `Model: ${m.label}`, icon: 'sparkles', group: 'Session', hint: active.runtime.model === m.id ? 'current' : undefined, run: () => S.setModel(active.id, m.id) });
      out.push({ id: 'fork', label: 'Fork this session', icon: 'fork', group: 'Session', run: () => S.forkSession(active.id) });
      if (active.runtime.status === 'running') out.push({ id: 'stop', label: 'Stop the agent', icon: 'stop', group: 'Session', run: () => S.interrupt(active.id) });
    }
    const seen = new Set<string>();
    for (const s of Object.values(sessions)) { seen.add(s.id); out.push({ id: 's-' + s.id, label: s.title, icon: 'chat', group: 'Sessions', hint: projectName(s.cwd), keywords: s.branch, run: () => S.setActive(s.id) }); }
    for (const s of [...summaries].sort((a, b) => b.lastModified - a.lastModified).slice(0, 40)) if (!seen.has(s.sessionId)) out.push({ id: 's-' + s.sessionId, label: s.title, icon: 'chat', group: 'Sessions', hint: `${s.cwd ? projectName(s.cwd) : ''} · ${relativeTime(s.lastModified)}`, run: () => S.openSession(s) });
    for (const p of projects) out.push({ id: 'p-' + p, label: `New session in ${projectName(p)}`, icon: 'folder', group: 'Projects', hint: p, run: () => S.newSession(p) });
    return out;
  }, [open, sessions, summaries, projects, models, active, theme]);

  const results = useMemo(() => {
    if (!q) { const order = ['Session', 'Actions', 'View', 'Sessions', 'Projects'];
    return cmds.filter((c) => c.group !== 'Projects').sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group)).slice(0, 30); }
    return cmds.map((c) => ({ c, s: fuzzy(q, `${c.label} ${c.keywords ?? ''} ${c.group}`) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 30).map((x) => x.c);
  }, [cmds, q]);
  useEffect(() => setIdx(0), [q]);
  useEffect(() => { list.current?.querySelector('.pal-item.sel')?.scrollIntoView({ block: 'nearest' }); }, [idx]);

  const run = (c?: Cmd) => { if (!c) return; close(); setTimeout(c.run, 0); };
  return (
    <Dialog open={open} onClose={close} width={600} className="palette">
      <div className="pal-input">
        <Icon name="search" size={16} />
        <input
          autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sessions, run a command…" aria-label="Command palette"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(results[idx]); }
          }}
        />
      </div>
      <div className="pal-list" ref={list} role="listbox">
        {results.length === 0 && <div className="pal-empty">No results</div>}
        {results.map((c, i) => (
          <div key={c.id}>
            {(i === 0 || results[i - 1].group !== c.group) && <div className="pal-group">{c.group}</div>}
            <button type="button" role="option" aria-selected={i === idx} className={`pal-item${i === idx ? ' sel' : ''}`} onMouseMove={() => setIdx(i)} onClick={() => run(c)}>
              <Icon name={c.icon} size={15} /><span className="pal-label">{c.label}</span>{c.hint && <span className="pal-hint">{c.hint}</span>}
            </button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
void modelLabel;
