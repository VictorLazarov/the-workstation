import { formatCost } from '../lib/utils';
import { projectName, sessionStatus, useSessions, type SessionData } from '../store/sessions';
import { useUi } from '../store/ui';
import { isMac } from '../lib/utils';
import { EffortChip, ModeChip, ModelChip } from './Chips';
import { Icon } from './Icon';
import { IconButton, Kbd, StatusDot } from './ui';

export function TopBar({ session }: { session?: SessionData }) {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const inspectorOpen = useUi((s) => s.inspectorOpen);
  const status = session ? sessionStatus(session) : 'idle';
  const label = { running: 'Working', 'needs-input': 'Needs your input', error: 'Error', done: 'Finished', idle: 'Idle', starting: 'Starting' }[status];
  const cost = session?.conv.usage.costUsd ?? 0;
  const mod = isMac() ? '⌘' : 'Ctrl';
  return (
    <header className="topbar">
      {!sidebarOpen && <IconButton icon="sidebar" label="Show sidebar (Ctrl+B)" onClick={() => useUi.getState().set({ sidebarOpen: true })} />}
      {session ? (
        <>
          <div className="topbar-title">
            <span className="crumb"><Icon name="folder" size={13} />{projectName(session.cwd)}</span>
            {session.branch && <span className="crumb branch"><Icon name="branch" size={13} />{session.branch}</span>}
            <span className="topbar-session" title={session.title}>{session.title}</span>
          </div>
          <div className="topbar-spacer" />
          <div className="topbar-chips">
            <span className={`status-pill st-${status}`}><StatusDot status={status} />{label}</span>
            <ModeChip session={session} />
            <ModelChip session={session} />
            <EffortChip session={session} />
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
