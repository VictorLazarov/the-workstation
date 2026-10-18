import { useMemo, useState, type ReactNode } from 'react';
import { contextWindowFor, formatCost, formatDuration, formatTokens, modelLabel } from '../lib/utils';
import { MODES } from '../components/Chips';
import { Icon } from '../components/Icon';
import { IconButton, Spinner } from '../components/ui';
import { useSessions } from '../store/sessions';
import { registerPanel, type PanelProps } from './registry';
import { groupTools, mcpEnabled, mcpTone, turnCosts } from './context/derive';
import { pctLabel } from './context/usage';
import { ContextBody, useContextSummary } from './OverviewPanel';
import './panels.css';

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return <section className="ctx-sec"><div className="panel-title"><span>{title}</span>{aside}</div>{children}</section>;
}

function Disclosure({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!count) return null;
  return (
    <div className={`disc${open ? ' open' : ''}`}>
      <button type="button" className="disc-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron-right" size={12} className="disc-chev" /><span>{title}</span><span className="pill">{count}</span>
      </button>
      {open && <div className="disc-body">{children}</div>}
    </div>
  );
}

const Chips = ({ items, prefix = '' }: { items: string[]; prefix?: string }) => <div className="ctx-chips">{items.map((i) => <span key={i} className="chip">{prefix}{i}</span>)}</div>;

function Meter({ sessionId }: { sessionId: string }) {
  const model = useSessions((s) => s.sessions[sessionId]?.runtime.model ?? s.sessions[sessionId]?.conv.init?.model);
  const { used, max, pct, tone } = useContextSummary(sessionId);
  return (
    <Section title="Context window" aside={<span className="muted">{modelLabel(model)}</span>}>
      <div className="meter-head">
        <b className={`meter-pct ${tone}`}>{used ? pctLabel(pct, used) : '–'}</b>
        <span className="muted">{used ? `${formatTokens(used)} of ${formatTokens(max)} tokens` : `${formatTokens(max)} token window`}</span>
      </div>
      <ContextBody sessionId={sessionId} compact={false} />
    </Section>
  );
}

function Usage({ sessionId }: { sessionId: string }) {
  const conv = useSessions((s) => s.sessions[sessionId]?.conv);
  const costs = useMemo(() => (conv ? turnCosts(conv) : []), [conv]);
  if (!conv) return null;
  const u = conv.usage;
  const known = u.known !== false; // a resumed session's past usage is not in its transcript
  const max = Math.max(...costs, 0.0001);
  return (
    <Section title="Usage">
      <div className="stat-grid">
        <div className="stat"><span>Cost</span><b>{known ? formatCost(u.costUsd) : '–'}</b></div>
        <div className="stat"><span>Turns</span><b>{known ? u.turns : '–'}</b></div>
        <div className="stat"><span>Time</span><b>{known && u.durationMs ? formatDuration(u.durationMs) : '–'}</b></div>
        <div className="stat"><span>Avg / turn</span><b>{known && u.turns ? formatCost(u.costUsd / u.turns) : '–'}</b></div>
      </div>
      {!known && <p className="muted small">Usage of earlier runs is not available for a resumed session. It counts from the next message.</p>}
      {costs.length > 1 && (
        <div className="spark" aria-label="Cost per turn">
          {costs.map((c, i) => <i key={i} title={formatCost(c)} style={{ height: `${Math.max(8, (c / max) * 100)}%` }} />)}
        </div>
      )}
    </Section>
  );
}

function Mcp({ sessionId }: { sessionId: string }) {
  const servers = useSessions((s) => s.sessions[sessionId]?.conv.init?.mcpServers) ?? [];
  const live = useSessions((s) => !!s.sessions[sessionId]?.live);
  const started = useSessions((s) => !!s.sessions[sessionId]?.conv.init);
  const { mcpToggle, mcpReconnect } = useSessions.getState();
  return (
    <Section title="MCP servers" aside={<span className="muted">{servers.length || ''}</span>}>
      {servers.length === 0 ? <p className="muted small">{started ? 'No MCP servers configured for this session.' : 'MCP servers connect when the session starts, with your first message.'}</p> : (
        <ul className="mcp-list">
          {servers.map((m) => {
            const on = mcpEnabled(m.status);
            return (
              <li key={m.name} className={`mcp tone-${mcpTone(m.status)}`}>
                <span className="mcp-dot" aria-hidden="true" />
                <span className="mcp-main"><b>{m.name}</b><span className="muted small mcp-state" title={m.error}>{m.status === 'pending' ? <><Spinner size={10} /> connecting…</> : m.error ? `${m.status}: ${m.error}` : m.status === 'connected' && m.tools ? `connected · ${m.tools.length} tool${m.tools.length === 1 ? '' : 's'}` : m.status}</span></span>
                {on && live && <IconButton icon="refresh" label={`Reconnect ${m.name}`} size={14} onClick={() => mcpReconnect(sessionId, m.name)} />}
                <button type="button" role="switch" aria-checked={on} aria-label={`${on ? 'Disable' : 'Enable'} ${m.name}`} disabled={!live} className={`switch${on ? ' on' : ''}`} onClick={() => mcpToggle(sessionId, m.name, !on)}><i /></button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function Loaded({ sessionId }: { sessionId: string }) {
  const init = useSessions((s) => s.sessions[sessionId]?.conv.init);
  const tools = useMemo(() => groupTools(init?.tools ?? []), [init?.tools]);
  if (!init) return <Section title="Loaded"><p className="muted small">Details appear once the session has started.</p></Section>;
  const mcpNames = Object.keys(tools.mcp);
  return (
    <Section title="Loaded">
      <Disclosure title="Skills" count={init.skills.length}><Chips items={init.skills} /></Disclosure>
      <Disclosure title="Slash commands" count={init.slashCommands.length}><Chips items={init.slashCommands} prefix="/" /></Disclosure>
      <Disclosure title="Agents" count={init.agents.length}><Chips items={init.agents} /></Disclosure>
      <Disclosure title="Tools" count={(init.tools ?? []).length}>
        <Chips items={tools.builtin} />
        {mcpNames.map((n) => <div key={n} className="ctx-group"><span className="muted small">{n}</span><Chips items={tools.mcp[n]} /></div>)}
      </Disclosure>
      <dl className="kv">
        {init.model && <><dt>Model</dt><dd>{modelLabel(init.model)}</dd></>}
        {init.permissionMode && <><dt>Mode</dt><dd>{MODES.find((m) => m.id === init.permissionMode)?.label ?? init.permissionMode}</dd></>}
        {init.version && <><dt>Agent runtime</dt><dd>{init.version}</dd></>}
      </dl>
    </Section>
  );
}

function ContextPanel({ sessionId }: PanelProps) {
  return (
    <div className="ctxp">
      <Meter sessionId={sessionId} />
      <Usage sessionId={sessionId} />
      <Mcp sessionId={sessionId} />
      <Loaded sessionId={sessionId} />
    </div>
  );
}

registerPanel({
  id: 'context', title: 'Context', icon: 'layers', order: 50, component: ContextPanel,
  useBadge: (id) => {
    const used = useSessions((s) => s.sessions[id]?.conv.contextTokens);
    const model = useSessions((s) => s.sessions[id]?.runtime.model ?? s.sessions[id]?.conv.init?.model);
    if (!used) return undefined;
    const pct = Math.round((used / contextWindowFor(model)) * 100);
    return pct >= 50 ? `${pct}%` : undefined;
  },
});
