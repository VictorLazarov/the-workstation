import { formatCost } from '../lib/utils';
import { projectName, sessionProject, sessionStatus, sessionWorktree, useSessions, type SessionData } from '../store/sessions';
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
  const wt = sessionWorktree(session);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const drawer = useSidebarDrawer();
  const inspectorOpen = useUi((s) => s.inspectorOpen);
  const status = session ? sessionStatus(session) : 'idle';
  const conn = useSessions((x) => x.conn);
  // a session we cannot see right now is not "Idle": say so
  const offline = !!session?.live && (conn === 'closed' || conn === 'offline');
  const label = offline ? 'Disconnected' : { running: 'Working', 'needs-input': 'Needs your input', error: 'Error', done: 'Finished', idle: 'Idle', starting: 'Starting' }[status];
  const cost = session?.conv.usage.known === false ? 0 : session?.conv.usage.costUsd ?? 0; // unknown after a resume: hidden, not $0.00
  const mod = isMac() ? '⌘' : 'Ctrl';
  return (
    <header className="topbar">
      {!sidebarOpen && <IconButton icon={drawer ? 'menu' : 'sidebar'} label={drawer ? 'Open sessions menu' : 'Show sidebar (Ctrl+B)'} className="topbar-nav" onClick={() => useUi.getState().set({ sidebarOpen: true })} />}
      {session ? (
        <>
          <div className="topbar-title">
            <span className="crumb" title={sessionProject(session)}><Icon name="folder" size={13} /><span className="crumb-name">{projectName(sessionProject(session))}</span></span>
            {branch && <span className="crumb branch" title={wt ? `Worktree ${wt.path}\nBranch ${branch}` : `Branch ${branch}`}><Icon name={wt ? 'layers' : 'branch'} size={13} /><span className="crumb-name">{branch}</span></span>}
            <span className="topbar-session" title={session.title}>{session.title}</span>
          </div>
          <div className="topbar-spacer" />
          <div className="topbar-chips">
            <span className={`status-pill st-${status}`} title={label}><StatusDot status={status} /><span className="pill-text">{label}</span></span>
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
