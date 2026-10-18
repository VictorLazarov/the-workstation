import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzy, isMac, modelLabel, relativeTime } from '../lib/utils';
import { clearRemoteServer, getRemoteServer } from '../lib/storage';
import { projectName, sessionProject, useActiveSession, useSessions } from '../store/sessions';
import { MAX_TOAST_LIFE, useSidebarDrawer, useUi, visibleToasts, type Toast } from '../store/ui';
import { Icon, type IconName } from './Icon';
import { Dialog, IconButton, Kbd, Spinner } from './ui';
import { usableModes } from './Chips';
import { newSessionShortcut } from '../lib/shortcuts';
import { usePanels } from '../panels/registry';
import { copyDebugInfo, useLogs } from '../store/logs';

/* ───────── toasts ───────── */
function ToastView({ t, more }: { t: Toast; more?: number }) {
  const dismiss = useUi((s) => s.dismissToast);
  // the timer runs only while the toast is on screen (queued ones get their full time once shown) and restarts when a repeat refreshes it
  useEffect(() => {
    // every toast ends: a repeat restarts the timer, but never past MAX_TOAST_LIFE since it first appeared (ttl 0 is not "forever")
    const left = Math.max(1000, Math.min(t.ttl > 0 ? t.ttl : MAX_TOAST_LIFE, t.since + MAX_TOAST_LIFE - Date.now()));
    const h = setTimeout(() => dismiss(t.id), left);
    return () => clearTimeout(h);
  }, [t.id, t.rev, t.ttl, dismiss]);
  return (
    <div className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
      <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : t.kind === 'attention' ? 'shield' : 'info'} size={16} />
      <div className="toast-text"><b>{t.title}{t.count > 1 && <span className="toast-count" aria-label={`${t.count} times`}>×{t.count}</span>}{!!more && <span className="toast-more">+{more} more</span>}</b>{t.body && <span>{t.body}</span>}</div>
      {t.action && <button type="button" className="link-btn" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
      {(t.kind === 'error' || t.logs) && <button type="button" className="link-btn" onClick={() => { useLogs.getState().openLogs({ sessionId: t.logs?.sessionId, ts: t.since }); dismiss(t.id); }}>View details</button>}
      <IconButton icon="x" label="Dismiss" size={13} onClick={() => dismiss(t.id)} />
    </div>
  );
}

/** At most two toasts at a time (one on narrow screens); the rest wait in the queue and appear as the visible ones go. */
export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const narrow = useSidebarDrawer();
  const visible = visibleToasts(toasts, narrow);
  const queued = toasts.length - visible.length;
  // Toasts still waiting in the queue go stale like visible ones: a "needs approval" from a minute ago is not news (the sidebar and the card say it)
  useEffect(() => {
    if (toasts.length <= visible.length) return;
    const h = setInterval(() => {
      const { toasts: now, dismissToast } = useUi.getState();
      const shown = new Set(visibleToasts(now, narrow).map((x) => x.id));
      for (const x of now) if (!shown.has(x.id) && Date.now() - x.since > (x.ttl > 0 ? x.ttl : MAX_TOAST_LIFE) + 1000) dismissToast(x.id);
    }, 1000);
    return () => clearInterval(h);
  }, [toasts.length, visible.length, narrow]);
  // On a narrow screen the toast gets its own strip under the topbar (the conversation moves down) instead of covering it.
  useEffect(() => {
    const el = document.documentElement;
    if (visible.length) el.setAttribute('data-toast', ''); else el.removeAttribute('data-toast');
    return () => el.removeAttribute('data-toast');
  }, [visible.length]);
  return (
    <div className="toasts" aria-live="polite" data-queued={queued || undefined}>
      {visible.map((t, i) => <ToastView key={t.id} t={t} more={i === visible.length - 1 ? queued : 0} />)}
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
        {c?.summary && <p className="dlg-summary">{c.summary}</p>}
        {c?.note && <p className="dlg-note"><Icon name="info" size={14} /><span>{c.note}</span></p>}
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
  const offline = conn === 'offline';
  return (
    <div className="conn-banner" role="alert">
      {conn === 'open' || offline ? <Icon name="alert" size={14} /> : <Spinner size={13} />}
      <span>{conn === 'open' ? `Server error: ${cfgErr}.` : offline ? 'Cannot reach the server. Check that it is still running.' : ready ? 'Connection lost. Reconnecting…' : 'Connecting to the server…'}</span>
      {conn !== 'open' && <button type="button" className="link-btn" onClick={() => useSessions.getState().reconnectNow()}>{offline ? 'Retry' : 'Retry now'}</button>}
    </div>
  );
}

/* ───────── shortcuts ───────── */
export function shortcutList(): { keys: string; label: string }[] {
  const m = isMac() ? '⌘' : 'Ctrl';
  return [
    { keys: `${m} K`, label: 'Command palette' },
    { keys: newSessionShortcut().replace(/^Alt\+/, 'Alt '), label: 'New session' },
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
  const panels = usePanels();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) { setQ(''); setIdx(0); } }, [open]);

  const cmds = useMemo<Cmd[]>(() => {
    if (!open) return [];
    const S = useSessions.getState(), U = useUi.getState();
    const out: Cmd[] = [
      { id: 'new', label: 'New session', icon: 'plus', group: 'Actions', hint: newSessionShortcut(), run: () => { const c = active?.cwd ?? projects[0]; c ? S.newSession(c) : U.set({ pickerOpen: true }); } },
      { id: 'open', label: 'Open project…', icon: 'folder-open', group: 'Actions', run: () => U.set({ pickerOpen: true }) },
      { id: 'sidebar', label: 'Toggle sidebar', icon: 'sidebar', group: 'View', run: () => U.set({ sidebarOpen: !U.sidebarOpen }) },
      { id: 'inspector', label: 'Toggle inspector', icon: 'panel-right', group: 'View', run: () => U.set({ inspectorOpen: !U.inspectorOpen }) },
      { id: 'settings', label: 'Settings', icon: 'settings', group: 'Actions', run: () => U.set({ settingsOpen: true }) },
      { id: 'keys', label: 'Keyboard shortcuts', icon: 'command', group: 'Actions', run: () => U.set({ shortcutsOpen: true }) },
      { id: 'logs', label: 'Open logs', icon: 'logs', group: 'View', keywords: 'diagnostics errors log server', run: () => useLogs.getState().openLogs() },
      ...(['light', 'dark', 'system'] as const).map((t): Cmd => ({ id: 'theme-' + t, label: `Theme: ${t[0].toUpperCase() + t.slice(1)}`, icon: t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'monitor', group: 'View', hint: theme === t ? 'current' : undefined, run: () => U.setTheme(t) })),
    ];
    if (active) {
      for (const m of usableModes(S.hello?.bypass ?? { available: true })) out.push({ id: 'mode-' + m.id, label: `Mode: ${m.label}`, icon: m.icon, group: 'Session', keywords: 'permission', hint: active.runtime.permissionMode === m.id ? 'current' : undefined, run: () => S.setMode(active.id, m.id) });
      for (const m of models) out.push({ id: 'model-' + m.id, label: `Model: ${m.label}`, icon: 'sparkles', group: 'Session', hint: active.runtime.model === m.id ? 'current' : undefined, run: () => S.setModel(active.id, m.id) });
      out.push({ id: 'debug-info', label: 'Copy debug info', icon: 'copy', group: 'Session', keywords: 'bug report diagnostics version', run: () => void copyDebugInfo(active.id) });
      for (const p of panels.filter((x) => x.id !== 'logs')) out.push({ id: 'panel-' + p.id, label: p.id === 'terminal' ? 'Open terminal' : `Open ${p.title}`, icon: p.icon, group: 'View', keywords: `panel inspector tab ${p.title}`, run: () => U.openInspector(p.id) });
      out.push({ id: 'fork', label: 'Fork this session', icon: 'fork', group: 'Session', run: () => S.forkSession(active.id) });
      if (active.runtime.status === 'running') out.push({ id: 'stop', label: 'Stop the agent', icon: 'stop', group: 'Session', run: () => S.interrupt(active.id) });
    }
    const seen = new Set<string>();
    for (const s of Object.values(sessions)) { seen.add(s.id); out.push({ id: 's-' + s.id, label: s.title, icon: 'chat', group: 'Sessions', hint: projectName(sessionProject(s)), keywords: s.branch, run: () => S.setActive(s.id) }); }
    for (const s of [...summaries].sort((a, b) => b.lastModified - a.lastModified).slice(0, 40)) if (!seen.has(s.sessionId)) out.push({ id: 's-' + s.sessionId, label: s.title, icon: 'chat', group: 'Sessions', hint: `${s.worktree?.root ?? s.cwd ? projectName(s.worktree?.root ?? s.cwd!) : ''} · ${relativeTime(s.lastModified)}${s.worktree?.removed ? ' · worktree removed' : ''}`, run: () => S.openSession(s) });
    for (const p of projects) out.push({ id: 'p-' + p, label: `New session in ${projectName(p)}`, icon: 'folder', group: 'Projects', hint: p, run: () => S.newSession(p) });
    return out;
  }, [open, sessions, summaries, projects, models, active, theme, panels]);

  const results = useMemo(() => {
    if (!q) { const order = ['Session', 'Actions', 'View', 'Sessions', 'Projects'];
    return cmds.filter((c) => c.group !== 'Projects').sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group)).slice(0, 30); }
    return cmds.map((c) => ({ c, s: fuzzy(q, `${c.label} ${c.keywords ?? ''} ${c.group}`) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 30).map((x) => x.c);
  }, [cmds, q]);
  useEffect(() => setIdx(0), [q]);
  useEffect(() => { list.current?.querySelector('.pal-item.sel')?.scrollIntoView({ block: 'nearest' }); }, [idx]);

  const run = (c?: Cmd) => { if (!c) return; close(); setTimeout(c.run, 0); };
  return (
    <Dialog open={open} onClose={close} width={600} className="palette" label="Command palette">
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
