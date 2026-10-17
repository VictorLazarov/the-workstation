import { useEffect } from 'react';
import { usePanels, type PanelDef } from '../panels/registry';
import { useUi } from '../store/ui';
import type { SessionData } from '../store/sessions';
import { Icon } from './Icon';
import { IconButton } from './ui';

function Tab({ p, active, sessionId }: { p: PanelDef; active: boolean; sessionId: string }) {
  const badge = p.useBadge?.(sessionId);
  return (
    <button type="button" role="tab" aria-selected={active} title={p.title} className={`itab${active ? ' on' : ''}`} onClick={() => useUi.getState().set({ inspectorTab: p.id, inspectorFocus: undefined })}>
      <Icon name={p.icon} size={14} />{p.title}{badge !== undefined && badge !== 0 && <span className="itab-badge">{badge}</span>}
    </button>
  );
}

export function Inspector({ session }: { session: SessionData }) {
  const panels = usePanels();
  const tab = useUi((s) => s.inspectorTab);
  const focus = useUi((s) => s.inspectorFocus);
  const active = panels.find((p) => p.id === tab) ?? panels[0];
  useEffect(() => { if (active && active.id !== tab) useUi.getState().set({ inspectorTab: active.id }); }, [active, tab]);
  const Body = active?.component;
  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector-head">
        <div className="itabs" role="tablist">{panels.map((p) => <Tab key={p.id} p={p} active={p.id === active?.id} sessionId={session.id} />)}</div>
        <IconButton icon="x" label="Close inspector" onClick={() => useUi.getState().set({ inspectorOpen: false })} />
      </div>
      <div className="inspector-body" role="tabpanel">
        {Body ? <Body key={session.id + active.id} sessionId={session.id} cwd={session.cwd} focus={focus} /> : <div className="panel-empty">No panels registered.</div>}
      </div>
    </aside>
  );
}
