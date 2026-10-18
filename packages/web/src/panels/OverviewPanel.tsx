import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { basename, formatDuration, formatTokens, relPath } from '../lib/utils';
import { ls } from '../lib/storage';
import { Icon, type IconName } from '../components/Icon';
import { IconButton, MiddleEllipsis, Spinner, Stats } from '../components/ui';
import { contextWindowFor } from '../lib/utils';
import { projectName, sessionProject, sessionWorktree, useSessions } from '../store/sessions';
import { useUi } from '../store/ui';
import { useContextUsage } from '../store/context';
import { registerPanel, type PanelProps } from './registry';
import { mcpEnabled, mcpTone } from './context/derive';
import { pctLabel, tone, usageView } from './context/usage';
import { useBranch, useGitSync, useProjectChanges } from './changes/store';
import { deriveTasks, isActive, sortTasks, type TaskRow } from './tasks/derive';
import { scrollToToolCall } from './TasksPanel';
import './panels.css';

/* ───────── collapsible card ───────── */
function OvCard({ id, title, icon, aside, defaultOpen = true, children }: { id: string; title: string; icon: IconName; aside?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const key = 'ws.ov.' + id;
  const [open, setOpen] = useState(() => { const v = ls.get(key); return v === null ? defaultOpen : v === '1'; });
  const toggle = () => { ls.set(key, open ? '0' : '1'); setOpen(!open); };
  return (
    <section className={`ovc${open ? ' open' : ''}`} data-card={id}>
      <button type="button" className="ovc-head" aria-expanded={open} onClick={toggle}>
        <Icon name="chevron-down" size={13} className="ovc-chev" />
        <Icon name={icon} size={14} className="ovc-ico" />
        <span className="ovc-title">{title}</span>
        {aside != null && <span className="ovc-aside">{aside}</span>}
      </button>
      {open && <div className="ovc-body">{children}</div>}
    </section>
  );
}

function Row({ icon, children, label, title }: { icon: IconName; children: ReactNode; label?: string; title?: string }) {
  return <div className="ov-row" title={title}><Icon name={icon} size={14} /><span className="ov-val">{children}</span>{label && <span className="ov-label">{label}</span>}</div>;
}

const openTab = (tab: string, focus?: string) => useUi.getState().openInspector(tab, focus);

/* ───────── Environment ───────── */
function EnvironmentCard({ sessionId }: { sessionId: string }) {
  const s = useSessions((x) => x.sessions[sessionId]);
  const branch = useBranch(sessionId);
  if (!s) return null;
  const wt = sessionWorktree(s);
  return (
    <OvCard id="env" title="Environment" icon="folder">
      <Row icon="folder" label="Project" title={sessionProject(s)}>{projectName(sessionProject(s))}</Row>
      {branch && <Row icon="branch" label="Branch">{branch}</Row>}
      <Row icon="layers" label="Checkout" title={wt?.path ?? s.cwd}>{wt ? (s.wtRemoved ? 'Worktree (removed)' : 'Worktree') : 'Project folder'}</Row>
      {wt && <Row icon="folder-open" label="Path" title={wt.path}><MiddleEllipsis text={wt.path} tail={22} /></Row>}
      {wt && !s.wtRemoved && !s.isDraft && (
        <div className="ov-actions"><button type="button" className="btn" onClick={() => void useSessions.getState().removeWorktree(sessionId)}><Icon name="trash" size={13} /> Remove worktree…</button></div>
      )}
    </OvCard>
  );
}

/* ───────── Context ───────── */
export function ContextBar({ rows, className = '' }: { rows: { key: string; tokens: number; swatch: string; name: string }[]; className?: string }) {
  return <div className={`cx-bar ${className}`} aria-hidden="true">{rows.map((r) => <i key={r.key} className={`cx-${r.swatch}`} title={r.name} style={{ flexGrow: Math.max(r.tokens, 1) }} />)}</div>;
}

/** Shared by the Overview card and the Context tab: real SDK numbers when the session is live, measured total otherwise. */
export function useContextSummary(sessionId: string) {
  const entry = useContextUsage(sessionId);
  const model = useSessions((x) => x.sessions[sessionId]?.runtime.model ?? x.sessions[sessionId]?.conv.init?.model);
  const measured = useSessions((x) => x.sessions[sessionId]?.conv.contextTokens ?? 0);
  const view = useMemo(() => (entry.data ? usageView(entry.data, entry.prevTotal) : null), [entry.data, entry.prevTotal]);
  // After a reload / resume the live breakdown is not there yet and the transcript only knows the last turn: show the
  // last real snapshot (kept per session) instead of a misleading near-zero number until the live one arrives.
  const stored = useMemo(() => ls.getJson<{ used: number; max: number } | null>('ws.ctx.' + sessionId, null), [sessionId, view]);
  useEffect(() => { if (view && view.used > 0) ls.setJson('ws.ctx.' + sessionId, { used: view.used, max: view.max }); }, [view, sessionId]);
  const used = view?.used ?? (stored?.used || measured);
  const max = view?.max ?? (stored?.max || contextWindowFor(model));
  const pct = view?.pct ?? (max ? Math.min(100, (used / max) * 100) : 0);
  return { entry, view, used, max, pct, tone: tone(pct) };
}

export function ContextBody({ sessionId, compact = true }: { sessionId: string; compact?: boolean }) {
  const s = useSessions((x) => x.sessions[sessionId]);
  const { entry, view, used, max, pct } = useContextSummary(sessionId);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [defOpen, setDefOpen] = useState(false);
  if (!s) return null;
  const running = s.runtime.status !== 'idle';
  return (
    <>
      {view ? (
        <>
          <ContextBar rows={view.bar} />
          <ul className="cx-list">
            {view.rows.map((r) => (
              <li key={r.key} className={`cx-row kind-${r.kind}`}>
                {r.expandable ? (
                  <button type="button" className="cx-line" aria-expanded={mcpOpen} onClick={() => setMcpOpen(!mcpOpen)}>
                    <i className={`cx-sw cx-${r.swatch}`} /><span className="cx-name">{r.name}<Icon name="chevron-right" size={11} className={`cx-more${mcpOpen ? ' open' : ''}`} /></span>
                    <span className="cx-tok">{formatTokens(r.tokens)}</span><span className="cx-pct">{pctText(r.pct)}</span>
                  </button>
                ) : (
                  <div className="cx-line">
                    <i className={`cx-sw cx-${r.swatch}`} /><span className="cx-name">{r.name}</span>
                    <span className="cx-tok">{r.name === 'Since last update' ? '+' : ''}{formatTokens(r.tokens)}</span><span className="cx-pct">{pctText(r.pct)}</span>
                  </div>
                )}
                {r.expandable && mcpOpen && entry.data && (
                  <ul className="cx-sub">
                    {entry.data.mcpTools.map((m) => (
                      <li key={m.name} className="cx-line" title={m.name}><span className="cx-name mono-ish">{m.name.replace(/^mcp__/, '').replace('__', ' · ')}</span><span className="cx-tok">{formatTokens(m.tokens)}</span></li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
            {view.deferred.length > 0 && (
              <li className="cx-row kind-deferred">
                <button type="button" className="cx-line" aria-expanded={defOpen} onClick={() => setDefOpen(!defOpen)}>
                  <i className="cx-sw cx-deferred" /><span className="cx-name">Deferred<Icon name="chevron-right" size={11} className={`cx-more${defOpen ? ' open' : ''}`} /></span>
                  <span className="cx-tok">{formatTokens(view.deferred.reduce((n, r) => n + r.tokens, 0))}</span><span className="cx-pct" title="Tool schemas that are not loaded into the window">–</span>
                </button>
                {defOpen && <ul className="cx-sub">{view.deferred.map((r) => <li key={r.key} className="cx-line"><span className="cx-name">{r.name}</span><span className="cx-tok">{formatTokens(r.tokens)}</span></li>)}</ul>}
              </li>
            )}
          </ul>
        </>
      ) : (
        <>
          {used > 0 ? <ContextBar rows={[{ key: 'used', tokens: used, swatch: 'messages', name: 'Used' }, { key: 'free', tokens: Math.max(max - used, 1), swatch: 'free', name: 'Free space' }]} /> : null}
          <p className="ov-note">
            {entry.loading ? <><Spinner size={11} /> Reading context…</>
              : s.live ? (entry.error ? `Breakdown unavailable: ${entry.error}` : 'Breakdown appears after the session starts.')
              : used ? 'Total from the last turn. Send a message to see the full breakdown.' : 'Usage appears after the first response.'}
          </p>
        </>
      )}
      <div className="ov-actions">
        {pct >= 60 && <button type="button" className="btn sm" disabled={running} onClick={() => useSessions.getState().send(sessionId, '/compact')}><Icon name="layers" size={13} /> Compact</button>}
        {compact && <button type="button" className="link-btn" onClick={() => openTab('context')}>Details</button>}
      </div>
    </>
  );
}

export function ContextCard({ sessionId }: { sessionId: string }) {
  const { used, max, pct, tone: t } = useContextSummary(sessionId);
  const aside = used ? <span className={`cx-head ${t}`}><b>{pctLabel(pct, used)} used</b><span>{formatTokens(used)} / {formatTokens(max)}</span></span> : <span className="cx-head"><span>{formatTokens(max)} window</span></span>;
  return (
    <OvCard id="context" title="Context" icon="layers" aside={aside}>
      <ContextBody sessionId={sessionId} />
    </OvCard>
  );
}
const pctText = (p: number) => (p < 0.1 ? '<0.1%' : p < 10 ? p.toFixed(1) + '%' : Math.round(p) + '%');

/* ───────── Connectors ───────── */
function ConnectorsCard({ sessionId }: { sessionId: string }) {
  const servers = useSessions((s) => s.sessions[sessionId]?.conv.init?.mcpServers) ?? [];
  const live = useSessions((s) => !!s.sessions[sessionId]?.live);
  const started = useSessions((s) => !!s.sessions[sessionId]?.conv.init);
  const { mcpToggle } = useSessions.getState();
  const ok = servers.filter((m) => m.status === 'connected').length;
  return (
    <OvCard id="connectors" title="Connectors" icon="plug" aside={servers.length ? `${ok}/${servers.length}` : undefined}>
      {servers.length === 0 ? <p className="ov-note">{started ? 'No MCP servers configured for this session.' : 'Connectors connect when the session starts, with your first message.'}</p> : (
        <ul className="ov-list">
          {servers.map((m) => {
            const on = mcpEnabled(m.status);
            return (
              <li key={m.name} className={`ov-item mcp-tone-${mcpTone(m.status)}`}>
                <span className="mcp-dot" aria-hidden="true" />
                <span className="ov-item-main" title={m.error}>{m.name}</span>
                <span className="ov-item-meta">{m.status === 'pending' ? <><Spinner size={10} /> connecting</> : m.status}</span>
                <button type="button" role="switch" aria-checked={on} aria-label={`${on ? 'Disable' : 'Enable'} ${m.name}`} disabled={!live} className={`switch sm${on ? ' on' : ''}`} onClick={() => mcpToggle(sessionId, m.name, !on)}><i /></button>
              </li>
            );
          })}
        </ul>
      )}
    </OvCard>
  );
}

/* ───────── Outputs ───────── */
function OutputsCard({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const { outputs, planFiles } = useProjectChanges(sessionId, cwd);
  const files = useMemo(() => outputs.slice().reverse(), [outputs]);
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, 5);
  const count = files.length + planFiles.length;
  return (
    <OvCard id="outputs" title="Outputs" icon="file-plus" aside={count || undefined}>
      {count === 0 ? <p className="ov-note">Files Claude creates or edits appear here.</p> : (
        <>
          <ul className="ov-list">
            {shown.map((f) => {
              const rel = relPath(f.path, cwd);
              const name = rel.split('/').pop() ?? rel;
              const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
              return (
                <li key={f.path}>
                  <button type="button" className="ov-item link" title={rel} onClick={() => openTab('files', f.path)}>
                    <Icon name={f.isNew ? 'file-plus' : 'file-edit'} size={14} />
                    <span className="ov-item-main"><MiddleEllipsis text={name} tail={10} className="ov-name" />{dir && <MiddleEllipsis text={dir} tail={12} className="ov-dir" />}</span>
                    {f.isNew ? <span className="pill pill-ok">new</span> : null}
                  </button>
                </li>
              );
            })}
            {planFiles.map((f) => (
              <li key={f.path}>
                <div className="ov-item" title={`Plan file (outside the project, not a change): ${f.path}`}>
                  <Icon name="list" size={14} />
                  <span className="ov-item-main"><MiddleEllipsis text={basename(f.path)} tail={10} className="ov-name" /></span>
                  <span className="pill">Plan file</span>
                </div>
              </li>
            ))}
          </ul>
          {files.length > 5 && <button type="button" className="ov-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show ${files.length - 5} more`}</button>}
        </>
      )}
    </OvCard>
  );
}

/* ───────── Changes ───────── */
function ChangesCard({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  // the same selector as the Changes tab, the tab badge and the Commit box: the count here is what Commit will stage
  const { files, added, removed, git } = useProjectChanges(sessionId, cwd);
  return (
    <OvCard id="changes" title="Changes" icon="file-edit" aside={files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : undefined}>
      {files.length === 0 ? <p className="ov-note">{git.loaded && git.isRepo ? 'Working tree is clean.' : 'No changes yet.'}</p> : (
        <>
          <button type="button" className="ov-item link ov-changes" onClick={() => openTab('changes')} title="Open the diff review">
            <Icon name="file-edit" size={14} />
            <span className="ov-item-main">Review changes</span>
            <Stats added={added} removed={removed} />
            <Icon name="chevron-right" size={13} className="ov-go" />
          </button>
          {git.isRepo && (
            <div className="ov-actions">
              <button type="button" className="btn sm primary" onClick={() => { openTab('changes'); setTimeout(() => window.dispatchEvent(new Event('ws:focus-commit')), 120); }}><Icon name="check" size={13} /> Commit…</button>
              <button type="button" className="link-btn" onClick={() => openTab('changes')}>Review</button>
            </div>
          )}
        </>
      )}
    </OvCard>
  );
}

/* ───────── Background tasks ───────── */
function useNow(active: boolean) {
  const [, tick] = useState(0);
  useEffect(() => { if (!active) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [active]);
  return Date.now();
}

function TaskLine({ t, since, now, onStop }: { t: TaskRow; since: number; now: number; onStop?: () => void }) {
  const active = isActive(t.status);
  const elapsed = active ? Math.max(t.durationMs ?? 0, now - since) : t.durationMs;
  return (
    <li className="ov-task">
      <button type="button" className="ov-item link" disabled={!t.toolUseId} onClick={() => t.toolUseId && scrollToToolCall(t.toolUseId)} title={t.description || t.title}>
        {active ? <Spinner size={12} /> : t.status === 'completed' ? <Icon name="check" size={14} className="st-ok" /> : t.status === 'failed' ? <Icon name="alert" size={14} className="st-err" /> : <Icon name={t.kind === 'background' ? 'terminal' : 'stop'} size={13} className="st-dim" />}
        <span className="ov-item-main">{t.description || t.title}</span>
        {elapsed ? <span className="ov-item-meta tnum">{formatDuration(elapsed)}</span> : null}
      </button>
      {active && onStop && <IconButton icon="stop" label={`Stop ${t.title}`} size={12} className="ov-stop" onClick={onStop} />}
    </li>
  );
}

function TasksCard({ sessionId }: { sessionId: string }) {
  const conv = useSessions((s) => s.sessions[sessionId]?.conv);
  const running = useSessions((s) => { const r = s.sessions[sessionId]?.runtime.status; return r === 'running' || r === 'waiting_permission'; });
  const live = useSessions((s) => !!s.sessions[sessionId]?.live);
  const rows = useMemo(() => (conv ? sortTasks(deriveTasks(conv, running, live)) : []), [conv, running, live]);
  const active = rows.filter((r) => isActive(r.status));
  const done = rows.filter((r) => !isActive(r.status));
  const seen = useRef(new Map<string, number>());
  for (const r of active) if (!seen.current.has(r.id)) seen.current.set(r.id, Date.now());
  const now = useNow(active.length > 0);
  const [showDone, setShowDone] = useState(false);
  const stop = (t: TaskRow) => { if (t.taskId) void useSessions.getState().stopTask(sessionId, t.taskId).catch((e: Error) => useUi.getState().toast({ kind: 'error', title: 'Could not stop the task', body: e.message })); };
  return (
    <OvCard id="tasks" title="Background tasks" icon="bot" aside={active.length ? `${active.length} running` : done.length ? `${done.length} finished` : undefined}>
      {rows.length === 0 ? <p className="ov-note">Subagents and background commands show up here while they run.</p> : (
        <>
          {active.length > 0 && <ul className="ov-list">{active.map((t) => <TaskLine key={t.id} t={t} since={seen.current.get(t.id) ?? now} now={now} onStop={t.taskId ? () => stop(t) : undefined} />)}</ul>}
          {done.length > 0 && (
            <>
              <button type="button" className="ov-more" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
                <Icon name="chevron-right" size={11} className={`cx-more${showDone ? ' open' : ''}`} /> {done.length} finished
              </button>
              {showDone && <ul className="ov-list">{done.map((t) => <TaskLine key={t.id} t={t} since={0} now={now} />)}</ul>}
            </>
          )}
        </>
      )}
    </OvCard>
  );
}

function OverviewPanel({ sessionId, cwd }: PanelProps) {
  useGitSync(sessionId, cwd);
  return (
    <div className="ov">
      <EnvironmentCard sessionId={sessionId} />
      <ContextCard sessionId={sessionId} />
      <ConnectorsCard sessionId={sessionId} />
      <OutputsCard sessionId={sessionId} cwd={cwd} />
      <ChangesCard sessionId={sessionId} cwd={cwd} />
      <TasksCard sessionId={sessionId} />
    </div>
  );
}

registerPanel({ id: 'overview', title: 'Overview', icon: 'home', order: 5, component: OverviewPanel });
