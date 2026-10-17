import { useEffect } from 'react';
import { Composer } from './components/Composer';
import { Conversation, Home } from './components/Conversation';
import { Inspector } from './components/Inspector';
import { CommandPalette, ConfirmHost, ConnectionBanner, ShortcutsDialog, Toasts } from './components/Overlays';
import { ProjectPicker } from './components/ProjectPicker';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { Resizer } from './components/ui';
import { isMac } from './lib/utils';
import { useActiveSession, useSessions } from './store/sessions';
import { applyTheme, useUi } from './store/ui';
import './panels';

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      const U = useUi.getState(), S = useSessions.getState();
      const k = e.key.toLowerCase();
      const act = (fn: () => void) => { e.preventDefault(); fn(); };
      if (k === 'k') act(() => U.set({ paletteOpen: !U.paletteOpen }));
      else if (k === 'n') act(() => { const c = (S.activeId && S.sessions[S.activeId]?.cwd) || S.projects[0]; c ? S.newSession(c) : U.set({ pickerOpen: true }); });
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
  const sessions = useSessions((s) => s.sessions);
  useEffect(() => {
    applyTheme(theme);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const meta = () => document.querySelector('meta[name=color-scheme]');
    void meta; void mq;
  }, [theme]);
  useEffect(() => {
    const attn = Object.values(sessions).filter((s) => s.perms.length).length;
    document.title = (attn ? `(${attn}) ` : '') + 'The Workstation';
  }, [sessions]);
}

export function App() {
  const session = useActiveSession();
  const ui = useUi();
  useShortcuts();
  useChrome();
  useEffect(() => { void useSessions.getState().init(); }, []);
  useEffect(() => { const f = () => useSessions.getState().activeId && useSessions.getState().setActive(useSessions.getState().activeId); window.addEventListener('focus', f); return () => window.removeEventListener('focus', f); }, []);

  return (
    <div className="app">
      <ConnectionBanner />
      <div className="shell" style={{ ['--sidebar-w' as string]: `${ui.sidebarOpen ? ui.sidebarWidth : 0}px`, ['--inspector-w' as string]: `${session && ui.inspectorOpen ? ui.inspectorWidth : 0}px` }}>
        {ui.sidebarOpen && (
          <>
            <Sidebar />
            <Resizer label="Resize sidebar" onDrag={(dx) => ui.set({ sidebarWidth: Math.min(480, Math.max(220, useUi.getState().sidebarWidth + dx)) })} />
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
            <Resizer label="Resize inspector" onDrag={(dx) => ui.set({ inspectorWidth: Math.min(720, Math.max(280, useUi.getState().inspectorWidth - dx)) })} />
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
