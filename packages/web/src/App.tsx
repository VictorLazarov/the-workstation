import { useEffect } from 'react';
import { AccessScreen } from './components/AccessScreen';
import { Composer } from './components/Composer';
import { Conversation, Home } from './components/Conversation';
import { Inspector } from './components/Inspector';
import { CommandPalette, ConfirmHost, ConnectionBanner, ShortcutsDialog, Toasts } from './components/Overlays';
import { ProjectPicker } from './components/ProjectPicker';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { Resizer } from './components/ui';
import { isNewSessionKey } from './lib/shortcuts';
import { isMac } from './lib/utils';
import { useActiveSession, useSessions } from './store/sessions';
import { applyBrand, applyDensity, applyTheme, inspectorIsDrawer, sidebarIsDrawer, useInspectorDrawer, useSidebarDrawer, useUi } from './store/ui';
import './panels';

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const U = useUi.getState(), S = useSessions.getState();
      const act = (fn: () => void) => { e.preventDefault(); fn(); };
      // Esc inside a drawer (sidebar / inspector on a narrow window) closes it
      if (e.key === 'Escape' && !document.querySelector('[role=dialog]') && (e.target as HTMLElement | null)?.closest?.('.sidebar, .inspector')) {
        if (sidebarIsDrawer() && U.sidebarOpen && (e.target as HTMLElement).closest('.sidebar')) { U.set({ sidebarOpen: false }); return; }
        if (inspectorIsDrawer() && U.inspectorOpen && (e.target as HTMLElement).closest('.inspector')) { U.set({ inspectorOpen: false }); return; }
      }
      // New session: Alt+N in the browser (Ctrl+N is reserved by Chrome), Cmd/Ctrl+N in the desktop app
      if (isNewSessionKey(e)) { act(() => { const c = (S.activeId && S.sessions[S.activeId]?.cwd) || S.projects[0]; c ? S.newSession(c) : U.set({ pickerOpen: true }); }); return; }
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'k') act(() => U.set({ paletteOpen: !U.paletteOpen }));
      else if (k === 'o') act(() => U.set({ pickerOpen: true }));
      else if (k === 'b' && e.altKey) act(() => U.set({ inspectorOpen: !U.inspectorOpen }));
      else if (k === 'b') act(() => U.set({ sidebarOpen: !U.sidebarOpen }));
      else if (k === ',') act(() => U.set({ settingsOpen: true }));
      else if (k === '/') act(() => U.set({ shortcutsOpen: !U.shortcutsOpen }));
      else if (k === 'enter' && S.activeId) {
        const btn = document.querySelector<HTMLButtonElement>('[data-perm-allow]');
        if (btn) act(() => btn.click());
      } else if (/^[1-9]$/.test(k)) {
        const items = [...document.querySelectorAll<HTMLButtonElement>('.sess')];
        const it = items[Number(k) - 1];
        if (it) act(() => it.click());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function useChrome() {
  const theme = useUi((s) => s.theme);
  const brand = useUi((s) => s.brand);
  const density = useUi((s) => s.density);
  const sessions = useSessions((s) => s.sessions);
  useEffect(() => {
    applyTheme(theme);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const meta = () => document.querySelector('meta[name=color-scheme]');
    void meta; void mq;
  }, [theme]);
  useEffect(() => { applyBrand(brand); }, [brand]);
  useEffect(() => { applyDensity(density); }, [density]);
  useEffect(() => {
    const attn = Object.values(sessions).filter((s) => s.perms.length).length;
    document.title = (attn ? `(${attn}) ` : '') + 'The Workstation';
  }, [sessions]);
}

export function App() {
  const session = useActiveSession();
  const ui = useUi();
  const sidebarDrawer = useSidebarDrawer();
  const inspectorDrawer = useInspectorDrawer();
  useShortcuts();
  useChrome();
  const access = useSessions((s) => s.access);
  useEffect(() => { void useSessions.getState().init(); }, []);
  useEffect(() => { const f = () => useSessions.getState().activeId && useSessions.getState().setActive(useSessions.getState().activeId); window.addEventListener('focus', f); return () => window.removeEventListener('focus', f); }, []);

  if (access === 'missing' || access === 'invalid') return <AccessScreen reason={access} />;

  return (
    // The pane-width variables live on .app (the common ancestor of the shell AND the toasts), so everything that
    // positions itself around the panes (toasts, drawers) sees the real values. -dock is the width a pane really takes
    // from the page: 0 while it is an overlay drawer (see the breakpoints in app.css).
    <div
      className="app" data-sidebar={ui.sidebarOpen && !sidebarDrawer ? 'docked' : 'hidden'}
      style={{ ['--sidebar-w' as string]: `${ui.sidebarOpen ? ui.sidebarWidth : 0}px`, ['--inspector-w' as string]: `${session && ui.inspectorOpen ? ui.inspectorWidth : 0}px` }}
    >
      <ConnectionBanner />
      <div className="shell">
        {ui.sidebarOpen && (
          <>
            {sidebarDrawer && <div className="drawer-scrim side" data-testid="sidebar-scrim" onClick={() => ui.set({ sidebarOpen: false })} />}
            <Sidebar />
            {!sidebarDrawer && <Resizer label="Resize sidebar" onDrag={(dx) => ui.set({ sidebarWidth: Math.min(480, Math.max(220, useUi.getState().sidebarWidth + dx)) })} />}
          </>
        )}
        <main className="main">
          <TopBar session={session} />
          {session ? (
            <>
              <Conversation session={session} />
              <Composer session={session} />
            </>
          ) : <Home />}
        </main>
        {session && ui.inspectorOpen && (
          <>
            {inspectorDrawer && <div className="drawer-scrim insp" data-testid="inspector-scrim" onClick={() => ui.set({ inspectorOpen: false })} />}
            {!inspectorDrawer && <Resizer label="Resize inspector" onDrag={(dx) => ui.set({ inspectorWidth: Math.min(720, Math.max(280, useUi.getState().inspectorWidth - dx)) })} />}
            <Inspector session={session} />
          </>
        )}
      </div>
      <CommandPalette />
      <SettingsDialog />
      <ProjectPicker />
      <ShortcutsDialog />
      <ConfirmHost />
      <Toasts />
    </div>
  );
}
