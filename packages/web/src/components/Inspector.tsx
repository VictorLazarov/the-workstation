import { useEffect } from 'react';
import { usePanels, type PanelDef } from '../panels/registry';
import { useUi } from '../store/ui';
import type { SessionData } from '../store/sessions';
import { Icon } from './Icon';
import { IconButton } from './ui';

function Tab({ p, active, sessionId }: { p: PanelDef; active: boolean; sessionId: string }) {
  const badge = p.useBadge?.(sessionId);
  return (
    <button type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1} title={p.title} data-panel={p.id} className={`itab${active ? ' on' : ''}`} onClick={() => useUi.getState().set({ inspectorTab: p.id, inspectorFocus: undefined })}>
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
        <div className="itabs" role="tablist" aria-label="Inspector panels" onKeyDown={(e) => {
          const ids = panels.map((p) => p.id), i = ids.indexOf(active?.id ?? '');
          const to = e.key === 'ArrowRight' ? (i + 1) % ids.length : e.key === 'ArrowLeft' ? (i - 1 + ids.length) % ids.length : e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : -1;
          if (to < 0) return;
          e.preventDefault();
          useUi.getState().set({ inspectorTab: ids[to], inspectorFocus: undefined });
          requestAnimationFrame(() => document.querySelector<HTMLElement>(`.itab[data-panel="${ids[to]}"]`)?.focus());
        }}>{panels.map((p) => <Tab key={p.id} p={p} active={p.id === active?.id} sessionId={session.id} />)}</div>
        <IconButton icon="x" label="Close inspector" onClick={() => useUi.getState().set({ inspectorOpen: false })} />
      </div>
      <div className="inspector-body" role="tabpanel">
        {Body ? <Body key={session.id + active.id} sessionId={session.id} cwd={session.cwd} focus={focus} /> : <div className="panel-empty">No panels registered.</div>}
      </div>
    </aside>
  );
}
