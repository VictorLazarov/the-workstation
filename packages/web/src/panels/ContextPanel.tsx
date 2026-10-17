import { useMemo, useState, type ReactNode } from 'react';
import { contextWindowFor, formatCost, formatDuration, formatTokens, modelLabel } from '../lib/utils';
import { Icon } from '../components/Icon';
import { IconButton, Spinner } from '../components/ui';
import { useSessions } from '../store/sessions';
import { registerPanel, type PanelProps } from './registry';
import { deriveContext, groupTools, mcpEnabled, mcpTone, turnCosts, type Category } from './context/derive';
import './panels.css';

const COLOR: Record<Category['id'], string> = {
  system: 'var(--muted)', user: 'var(--info)', assistant: 'var(--accent)', thinking: 'var(--warn)', calls: 'var(--ok)', results: '#8e6bb8',
};

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
  const conv = useSessions((s) => s.sessions[sessionId]?.conv);
  const model = useSessions((s) => s.sessions[sessionId]?.runtime.model) ?? conv?.init?.model;
  const running = useSessions((s) => s.sessions[sessionId]?.runtime.status !== 'idle');
  const win = contextWindowFor(model);
  const d = useMemo(() => (conv ? deriveContext(conv, win) : null), [conv, win]);
  if (!d) return null;
  const tone = d.pct >= 85 ? 'hot' : d.pct >= 65 ? 'warm' : '';
  return (
    <Section title="Context window" aside={<span className="muted">{modelLabel(model)}</span>}>
      <div className="meter-head">
        <b className={`meter-pct ${tone}`}>{d.used ? `${d.pct < 10 ? d.pct.toFixed(1) : Math.round(d.pct)}%` : '–'}</b>
        <span className="muted">{d.used ? `${formatTokens(d.used)} of ${formatTokens(d.window)} tokens` : `${formatTokens(d.window)} token window`}</span>
      </div>
      <div className={`meter ${tone}`} role="meter" aria-valuenow={Math.round(d.pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Context window used">
        {d.categories.map((c) => <i key={c.id} title={`${c.label}: ${formatTokens(c.tokens)}`} style={{ width: `${(c.tokens / d.window) * 100}%`, background: COLOR[c.id] }} />)}
      </div>
      {d.used === 0 ? <p className="muted small ctx-note">Usage appears after Claude's first response.</p> : (
        <>
          <ul className="legend">
            {d.categories.map((c) => (
              <li key={c.id}><i style={{ background: COLOR[c.id] }} /><span>{c.label}</span><span className="muted">{formatTokens(c.tokens)}</span><span className="legend-pct">{((c.tokens / d.used) * 100).toFixed(0)}%</span></li>
            ))}
            <li className="free"><i /><span>Free space</span><span className="muted">{formatTokens(d.free)}</span><span className="legend-pct">{(100 - d.pct).toFixed(0)}%</span></li>
          </ul>
          <p className="muted small ctx-note">Total is measured; the split is estimated from message sizes.</p>
        </>
      )}
      {d.pct >= 60 && (
        <button type="button" className="btn" disabled={running} onClick={() => useSessions.getState().send(sessionId, '/compact')}>
          <Icon name="layers" size={14} /> Compact conversation
        </button>
      )}
    </Section>
  );
}

function Usage({ sessionId }: { sessionId: string }) {
  const conv = useSessions((s) => s.sessions[sessionId]?.conv);
  const costs = useMemo(() => (conv ? turnCosts(conv) : []), [conv]);
  if (!conv) return null;
  const u = conv.usage;
  const max = Math.max(...costs, 0.0001);
  return (
    <Section title="Usage">
      <div className="stat-grid">
        <div className="stat"><span>Cost</span><b>{formatCost(u.costUsd)}</b></div>
        <div className="stat"><span>Turns</span><b>{u.turns}</b></div>
        <div className="stat"><span>Time</span><b>{u.durationMs ? formatDuration(u.durationMs) : '–'}</b></div>
        <div className="stat"><span>Avg / turn</span><b>{u.turns ? formatCost(u.costUsd / u.turns) : '–'}</b></div>
      </div>
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
  const { mcpToggle, mcpReconnect } = useSessions.getState();
  return (
    <Section title="MCP servers" aside={<span className="muted">{servers.length || ''}</span>}>
      {servers.length === 0 ? <p className="muted small">No MCP servers configured for this session.</p> : (
        <ul className="mcp-list">
          {servers.map((m) => {
            const on = mcpEnabled(m.status);
            return (
              <li key={m.name} className={`mcp tone-${mcpTone(m.status)}`}>
                <span className="mcp-dot" aria-hidden="true" />
                <span className="mcp-main"><b>{m.name}</b><span className="muted small">{m.status === 'pending' ? <><Spinner size={10} /> connecting…</> : m.error ? m.error : m.status}</span></span>
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
        {init.permissionMode && <><dt>Mode</dt><dd>{init.permissionMode}</dd></>}
        {init.version && <><dt>Claude Code</dt><dd>{init.version}</dd></>}
      </dl>
    </Section>
  );
}

function ContextPanel({ sessionId }: PanelProps) {
  return (
    <div className="ctx">
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
