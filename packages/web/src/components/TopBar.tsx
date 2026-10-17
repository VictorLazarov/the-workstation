import { formatCost } from '../lib/utils';
import { projectName, sessionStatus, useSessions, type SessionData } from '../store/sessions';
import { useSidebarDrawer, useUi } from '../store/ui';
import { isMac } from '../lib/utils';
import { Icon } from './Icon';
import { useBranch, useGitSync } from '../panels/changes/store';
import { IconButton, Kbd, StatusDot } from './ui';

/** Keeps git fresh for the active session and resolves its single branch (see useBranch). */
function useSessionBranch(session?: SessionData): string | undefined {
  useGitSync(session?.id ?? '', session?.cwd ?? '');
  return useBranch(session?.id ?? '');
}

export function TopBar({ session }: { session?: SessionData }) {
  const branch = useSessionBranch(session);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const drawer = useSidebarDrawer();
  const inspectorOpen = useUi((s) => s.inspectorOpen);
  const status = session ? sessionStatus(session) : 'idle';
  const label = { running: 'Working', 'needs-input': 'Needs your input', error: 'Error', done: 'Finished', idle: 'Idle', starting: 'Starting' }[status];
  const cost = session?.conv.usage.known === false ? 0 : session?.conv.usage.costUsd ?? 0; // unknown after a resume: hidden, not $0.00
  const mod = isMac() ? '⌘' : 'Ctrl';
  return (
    <header className="topbar">
      {!sidebarOpen && <IconButton icon={drawer ? 'menu' : 'sidebar'} label={drawer ? 'Open sessions menu' : 'Show sidebar (Ctrl+B)'} className="topbar-nav" onClick={() => useUi.getState().set({ sidebarOpen: true })} />}
      {session ? (
        <>
          <div className="topbar-title">
            <span className="crumb" title={session.cwd}><Icon name="folder" size={13} /><span className="crumb-name">{projectName(session.cwd)}</span></span>
            {branch && <span className="crumb branch" title={`Branch ${branch}`}><Icon name="branch" size={13} /><span className="crumb-name">{branch}</span></span>}
            <span className="topbar-session" title={session.title}>{session.title}</span>
          </div>
          <div className="topbar-spacer" />
          <div className="topbar-chips">
            <span className={`status-pill st-${status}`}><StatusDot status={status} />{label}</span>
            {cost > 0 && <span className="cost" title={`${session.conv.usage.turns} turn(s)`}>{formatCost(cost)}</span>}
          </div>
        </>
      ) : <div className="topbar-spacer" />}
      <button type="button" className="palette-btn" onClick={() => useUi.getState().set({ paletteOpen: true })} aria-label="Command palette">
        <Icon name="search" size={13} /><Kbd>{mod} K</Kbd>
      </button>
      {session && <IconButton icon="panel-right" label="Toggle inspector (Ctrl+Alt+B)" active={inspectorOpen} onClick={() => useUi.getState().set({ inspectorOpen: !inspectorOpen })} />}
    </header>
  );
}
