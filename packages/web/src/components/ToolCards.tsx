import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Conversation, PermissionRequest, TaskInfo, ToolResult, ToolUseBlock } from '../lib/types';
import { MAIN_LANE } from '../lib/types';
import { collapseContext, diffLines, diffStats, fromStructuredPatch, type DiffLine } from '../lib/diff';
import { hostOf, isInterruptResult, mcpParts, str, toolKind, toolPath, toolTitle, webVerb } from '../lib/tools';
import { basename, formatDuration, formatTokens, isHttpUrl, relPath, truncate } from '../lib/utils';
import { useHasPanel } from '../panels/registry';
import { useUi } from '../store/ui';
import { Icon, type IconName } from './Icon';
import { CopyButton, Dots, Spinner, Stats } from './ui';
import { DiffView } from './DiffView';
import { Markdown, CodeBlock } from './Markdown';
import { PermissionActions, QuestionCard, PlanCard } from './PermissionCards';
import { RowList } from './RowList';

export type ToolStatus = 'streaming' | 'waiting' | 'running' | 'done' | 'error' | 'denied' | 'stopped';

export interface ToolProps {
  block: ToolUseBlock;
  result?: ToolResult;
  perm?: PermissionRequest;
  outcome?: 'allowed' | 'denied';
  sessionRunning: boolean;
  sessionId: string;
  cwd: string;
  elapsed?: number;
  /** TodoWrite only: true for the most recent snapshot, which is the one live checklist; older ones collapse to a quiet line */
  todoLatest?: boolean;
}

export function toolStatus(p: Pick<ToolProps, 'block' | 'result' | 'perm' | 'outcome' | 'sessionRunning'>): ToolStatus {
  if (p.perm) return 'waiting';
  if (p.result) return p.outcome === 'denied' ? 'denied' : p.result.isError ? (p.result.stopped || isInterruptResult(p.result.content) ? 'stopped' : 'error') : 'done';
  if (!p.block.final && p.block.partialJson !== undefined) return 'streaming';
  return p.sessionRunning ? 'running' : 'stopped';
}

function StatusIcon({ status }: { status: ToolStatus }) {
  if (status === 'running' || status === 'streaming') return <Dots />;
  if (status === 'waiting') return <Icon name="shield" size={13} className="st-wait" />;
  if (status === 'error') return <Icon name="alert" size={13} className="st-err" />;
  if (status === 'denied') return <Icon name="x" size={13} className="st-err" />;
  if (status === 'stopped') return <Icon name="clock" size={12} className="st-dim" />;
  return null; // done: a finished step is just a quiet line
}

const KIND_ICON: Record<string, IconName> = {
  'todo-step': 'list-checks', bash: 'terminal', edit: 'file-edit', write: 'file-plus', read: 'eye', search: 'search', web: 'globe', task: 'bot',
  todo: 'list-checks', ask: 'help', plan: 'list', mcp: 'zap', other: 'wrench',
};
/** Steps that need the reader (checklist, questions, plan review) keep a card; everything else is a one-line row. */
const CARD_KINDS = new Set(['todo', 'ask', 'plan']);

/** Seconds a step has been running: seeded from the SDK's tool progress when it reports one, else counted locally. */
function useElapsed(active: boolean, seedSec = 0): number {
  const t0 = useRef(Date.now() - seedSec * 1000);
  const [, tick] = useState(0);
  useEffect(() => { if (!active) return; const i = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(i); }, [active]);
  return active ? Math.max(seedSec, Math.floor((Date.now() - t0.current) / 1000)) : 0;
}

/**
 * Tool step chrome. Default: a compact muted one-line row ("Edited auth.ts +5 -0 ›") that expands inline to the rich body.
 * A step waiting for permission is forced open and gets a card border; todo/ask/plan keep a card.
 */
export function Shell({ kind, title, subtitle, status, meta, defaultOpen = false, forceOpen, children, actions, flush, tone, elapsed }: {
  kind: string; title: ReactNode; subtitle?: ReactNode; status: ToolStatus; meta?: ReactNode; defaultOpen?: boolean; forceOpen?: boolean;
  children?: ReactNode; actions?: ReactNode; flush?: boolean; tone?: 'warn'; elapsed?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = forceOpen || open;
  const has = children != null && children !== false;
  const live = status === 'running' || status === 'streaming';
  const sec = useElapsed(live, elapsed ?? 0);
  const card = CARD_KINDS.has(kind);
  return (
    <div className={`tool tool-${kind} st-${status}${isOpen ? ' open' : ''}${card ? ' tool-cardlike' : ''}${tone ? ' tone-' + tone : ''}`}>
      <div className="tool-head" role={has ? 'button' : undefined} tabIndex={has ? 0 : undefined} aria-expanded={has ? isOpen : undefined}
        onClick={() => has && setOpen(!open)} onKeyDown={(e) => { if (has && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(!open); } }}>
        <span className="tool-ico"><Icon name={KIND_ICON[kind] ?? 'wrench'} size={14} /></span>
        <span className="tool-title">{title}</span>
        {subtitle && <span className="tool-sub">{subtitle}</span>}
        {card && <span className="tool-spacer" />}
        {(meta || live) && <span className="tool-meta">{meta}{live && sec >= 1 && <span className="tool-elapsed">{formatDuration(sec * 1000)}</span>}</span>}
        <StatusIcon status={status} />
        {has && <Icon name="chevron-right" size={12} className="tool-chev" />}
        {actions}
      </div>
      {has && isOpen && <div className={`tool-body${flush ? ' flush' : ''}`}>{children}</div>}
    </div>
  );
}

function Output({ text, isError, max = 8 }: { text: string; isError?: boolean; max?: number }) {
  const [all, setAll] = useState(false);
  const lines = text.replace(/\s+$/, '').split('\n');
  const long = lines.length > max;
  const shown = all || !long ? text.replace(/\s+$/, '') : lines.slice(0, max).join('\n');
  return (
    <div className={`output${isError ? ' err' : ''}`}>
      <pre>{shown || '(no output)'}</pre>
      {long && <button type="button" className="diff-more" onClick={() => setAll(!all)}>{all ? 'Collapse output' : `Show ${lines.length - max} more lines`}</button>}
    </div>
  );
}

/* ───────────── per-tool bodies ───────────── */
function BashCard(p: ToolProps & { status: ToolStatus; footer: ReactNode }) {
  const cmd = str(p.block.input.command);
  const exit = p.result ? /Exit code:? (\d+)/i.exec(p.result.content)?.[1] : undefined;
  const bg = !!p.block.input.run_in_background;
  const desc = str(p.block.input.description);
  return (
    <Shell kind="bash" status={p.status} defaultOpen={p.status === 'waiting' || p.status === 'error'} forceOpen={p.status === 'waiting'} elapsed={p.elapsed}
      title={p.status === 'waiting' ? (desc || 'Run command') : desc || <>{p.status === 'done' || p.status === 'error' ? 'Ran' : 'Run'} <span className="tool-code">{truncate(cmd.split('\n')[0], 80)}</span></>}
      subtitle={p.status === 'waiting' ? (bg ? 'background' : undefined) : desc ? <span className="tool-code">{truncate(cmd.split('\n')[0], 70)}{bg ? ' (background)' : ''}</span> : bg ? 'background' : undefined}
      meta={<>{exit && exit !== '0' ? <span className="meta-err">exit {exit}</span> : p.status === 'done' ? <span>exit {exit ?? '0'}</span> : null}</>}>
      <div className="cmd">
        <span className="cmd-prompt">$</span>
        <code>{cmd}</code>
        <CopyButton text={cmd} label="Copy command" />
      </div>
      {p.result && <Output text={p.result.content} isError={p.result.isError} />}
      {p.footer}
    </Shell>
  );
}

export function editLines(b: ToolUseBlock, result?: ToolResult): { lines: DiffLine[]; isNew: boolean } {
  const i = b.input;
  if (b.name === 'Write') {
    const lines = diffLines('', str(i.content));
    return { lines, isNew: /created/i.test(result?.content ?? '') };
  }
  const patch = fromStructuredPatch((result?.raw as { structuredPatch?: unknown } | undefined)?.structuredPatch);
  if (patch && b.name === 'Edit') return { lines: patch, isNew: false };
  if (b.name === 'MultiEdit' && Array.isArray(i.edits)) {
    const out: DiffLine[] = [];
    for (const e of i.edits as { old_string?: string; new_string?: string }[]) {
      if (out.length) out.push({ t: '@', text: '' });
      out.push(...collapseContext(diffLines(str(e.old_string), str(e.new_string)), 2));
    }
    return { lines: out, isNew: false };
  }
  if (b.name === 'NotebookEdit') return { lines: diffLines('', str(i.new_source)), isNew: false };
  return { lines: diffLines(str(i.old_string), str(i.new_string)), isNew: false };
}

function editVerb(name: string, isNew: boolean, status: ToolStatus): string {
  const create = name === 'Write';
  if (status === 'waiting') return create ? 'Create' : 'Edit';
  if (status === 'running' || status === 'streaming') return create ? 'Writing' : 'Editing';
  if (status === 'error' || status === 'denied') return create ? 'Write' : 'Edit';
  return create ? (isNew ? 'Created' : 'Wrote') : 'Edited';
}

function EditCard(p: ToolProps & { status: ToolStatus; footer: ReactNode }) {
  const path = toolPath(p.block);
  const { lines, isNew } = useMemo(() => editLines(p.block, p.result), [p.block, p.result]);
  const st = useMemo(() => diffStats(lines), [lines]);
  const hasChanges = useHasPanel('changes');
  const hasInput = Object.keys(p.block.input).length > 0;
  return (
    <Shell kind={p.block.name === 'Write' ? 'write' : 'edit'} status={p.status} flush forceOpen={p.status === 'waiting'} elapsed={p.elapsed}
      title={<>{editVerb(p.block.name, isNew, p.status)} <span className="filename" title={path}>{relPath(path, p.cwd)}</span></>}
      subtitle={p.block.name === 'MultiEdit' ? `${(p.block.input.edits as unknown[] | undefined)?.length ?? 0} edits` : undefined}
      meta={hasInput && p.status !== 'streaming' ? <Stats added={st.added} removed={st.removed} /> : null}
      actions={hasChanges && p.status === 'done' ? <button type="button" className="link-btn row-action" onClick={(e) => { e.stopPropagation(); useUi.getState().openInspector('changes', path); }}>Review</button> : null}>
      {hasInput ? <DiffView lines={lines} path={path} maxLines={p.status === 'waiting' ? 40 : 14} /> : <div className="skeleton-lines"><i /><i /><i /></div>}
      {p.status === 'error' && p.result && <Output text={p.result.content} isError />}
      {p.footer}
    </Shell>
  );
}

function WebCard(p: ToolProps & { status: ToolStatus; footer: ReactNode }) {
  const isSearch = p.block.name === 'WebSearch';
  const url = str(p.block.input.url);
  const text = p.result?.content ?? '';
  return (
    <Shell kind="web" status={p.status} defaultOpen={p.status === 'waiting'} forceOpen={p.status === 'waiting'} elapsed={p.elapsed}
      title={isSearch ? <>{webVerb(true, p.status)}</> : <>{webVerb(false, p.status)} <span className="mono">{hostOf(url)}</span></>}
      subtitle={isSearch ? <span className="query">“{truncate(str(p.block.input.query), 70)}”</span> : <span className="query">{truncate(str(p.block.input.prompt), 70)}</span>}>
      {!isSearch && url && (isHttpUrl(url)
        ? <a className="source-link" href={url} target="_blank" rel="noreferrer noopener"><Icon name="external" size={13} />{url}</a>
        : <span className="source-link">{url}</span>)}
      {text && <Output text={text} isError={p.result?.isError} max={6} />}
      {p.footer}
    </Shell>
  );
}

/** `live`: the agent is still working. A finished turn shows its in-progress item as paused, with no spinner. */
export function TodoList({ todos, compact, live = true }: { todos: { content: string; status: string; activeForm?: string }[]; compact?: boolean; live?: boolean }) {
  return (
    <ul className={`todos${compact ? ' compact' : ''}`}>
      {todos.map((t, i) => (
        <li key={i} className={`todo ${t.status}`}>
          <span className="todo-box" aria-hidden="true">{t.status === 'completed' ? <Icon name="check" size={11} /> : t.status === 'in_progress' ? (live ? <Spinner size={10} /> : <i className="todo-paused" />) : null}</span>
          <span className="todo-text">{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
        </li>
      ))}
    </ul>
  );
}

function TodoCard(p: ToolProps & { status: ToolStatus }) {
  const todos = (Array.isArray(p.block.input.todos) ? p.block.input.todos : []) as { content: string; status: string; activeForm?: string }[];
  const done = todos.filter((t) => t.status === 'completed').length;
  const sub = todos.length ? `${done}/${todos.length} done` : undefined;
  // One live checklist: only the latest TodoWrite is a card; earlier snapshots are a muted one-line step.
  if (p.todoLatest === false) return <Shell kind="todo-step" status={p.status === 'running' || p.status === 'streaming' ? 'done' : p.status} title="Updated plan" subtitle={sub} />;
  return (
    <Shell kind="todo" status={p.status === 'done' ? 'done' : p.status} defaultOpen title="Plan" subtitle={sub}>
      <TodoList todos={todos} live={p.sessionRunning} />
    </Shell>
  );
}

function TaskCard(p: ToolProps & { status: ToolStatus; conv: Conversation; task?: TaskInfo; footer: ReactNode }) {
  const i = p.block.input;
  const lane = p.conv.lanes[p.block.id];
  const running = p.status === 'running' || p.status === 'waiting';
  const [showPrompt, setShowPrompt] = useState(false);
  const toolCount = p.task?.toolUses ?? (lane?.items ?? []).reduce((n, it) => n + (it.kind === 'assistant' ? it.blocks.filter((b) => b.type === 'tool_use').length : 0), 0);
  return (
    <Shell kind="task" status={p.status} defaultOpen={running} forceOpen={p.status === 'waiting'} elapsed={p.elapsed}
      title={<><span className="agent-name">{str(i.subagent_type) || 'Subagent'}</span></>}
      subtitle={truncate(str(i.description), 90)}
      meta={<>
        {toolCount > 0 && <span>{toolCount} tool{toolCount > 1 ? 's' : ''}</span>}
        {p.task?.totalTokens ? <span>{formatTokens(p.task.totalTokens)} tok</span> : null}
        {p.task?.durationMs ? <span>{formatDuration(p.task.durationMs)}</span> : null}
      </>}>
      <div className="subagent">
        {str(i.prompt) && (
          <button type="button" className="subagent-prompt" onClick={() => setShowPrompt(!showPrompt)}>
            <Icon name={showPrompt ? 'chevron-down' : 'chevron-right'} size={12} /> Task prompt
          </button>
        )}
        {showPrompt && <div className="subagent-prompt-body">{str(i.prompt)}</div>}
        {lane && lane.items.length > 0 && (
          <div className="subagent-lane">
            <RowList conv={p.conv} laneKey={p.block.id} sessionId={p.sessionId} cwd={p.cwd} sessionRunning={p.sessionRunning} perms={[]} outcomes={{}} nested />
          </div>
        )}
        {running && !lane?.items.length && <div className="subagent-wait"><Spinner size={12} /> Starting…</div>}
        {p.task?.status === 'running' && p.task.lastToolName && <div className="subagent-wait"><Spinner size={12} /> Using {p.task.lastToolName}…</div>}
        {p.result && (
          <div className="subagent-result">
            <div className="subagent-result-label">Result</div>
            <Markdown text={p.result.content} />
          </div>
        )}
        {p.footer}
      </div>
    </Shell>
  );
}

function GenericCard(p: ToolProps & { status: ToolStatus; footer: ReactNode }) {
  const { server, tool } = mcpParts(p.block.name);
  const kind = toolKind(p.block.name);
  const json = useMemo(() => { try { return JSON.stringify(p.block.input, null, 2); } catch { return ''; } }, [p.block.input]);
  const empty = json === '{}';
  return (
    <Shell kind={kind} status={p.status} defaultOpen={p.status === 'waiting'} forceOpen={p.status === 'waiting'} elapsed={p.elapsed}
      title={server ? <span className="mono-ish">{tool.replace(/_/g, ' ')}</span> : p.block.name}
      subtitle={server ? server : undefined}>
      {!empty && <CodeBlock code={json} lang="json" />}
      {p.result && <Output text={p.result.content} isError={p.result.isError} />}
      {p.footer}
    </Shell>
  );
}

/** Dispatches a tool_use block to its rich rendering. */
export const ToolCard = memo(function ToolCard(p: ToolProps & { conv?: Conversation; task?: TaskInfo; onRespond: (d: import('@workstation/protocol').PermissionDecision) => void }) {
  const status = toolStatus(p);
  const kind = toolKind(p.block.name);
  const footer = p.perm && kind !== 'ask' && kind !== 'plan'
    ? <PermissionActions perm={p.perm} onRespond={p.onRespond} cwd={p.cwd} />
    : p.outcome && !p.result ? <div className="perm-outcome">{p.outcome === 'allowed' ? 'Allowed' : 'Denied'}</div> : null;
  const q = { ...p, status, footer };
  switch (kind) {
    case 'bash': return <BashCard {...q} />;
    case 'edit': case 'write': return <EditCard {...q} />;
    case 'web': return <WebCard {...q} />;
    case 'todo': return <TodoCard {...q} />;
    case 'task': return p.conv ? <TaskCard {...q} conv={p.conv} /> : <GenericCard {...q} />;
    case 'ask': return <QuestionCard {...p} status={status} />;
    case 'plan': return <PlanCard {...p} status={status} />;
    default: return <GenericCard {...q} />;
  }
});

/* ───────────── explore group (Read / Grep / Glob) ───────────── */
export const ExploreGroup = memo(function ExploreGroup({ blocks, results, cwd, sessionRunning }: {
  blocks: ToolUseBlock[]; results: Record<string, ToolResult>; cwd: string; sessionRunning: boolean;
}) {
  const [open, setOpen] = useState(false);
  const reads = blocks.filter((b) => b.name === 'Read' || b.name === 'LS').length;
  const searches = blocks.length - reads;
  const running = sessionRunning && blocks.some((b) => !results[b.id]);
  const label = [reads ? `${running ? 'Reading' : 'Read'} ${reads} file${reads > 1 ? 's' : ''}` : '', searches ? `${running ? 'searching' : 'searched'} ${searches} time${searches > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ');
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const sec = useElapsed(running);
  return (
    <div className={`tool tool-read explore${open ? ' open' : ''}${running ? ' st-running' : ' st-done'}`}>
      <button type="button" className="tool-head explore-head" onClick={() => setOpen(!open)} aria-expanded={open} title={blocks.map((b) => chipTitle(b, cwd)).join('\n')}>
        <span className="tool-ico"><Icon name="eye" size={14} /></span>
        <span className="tool-title explore-label">{cap(label)}</span>
        {running && <span className="tool-meta">{sec >= 1 && <span className="tool-elapsed">{formatDuration(sec * 1000)}</span>}</span>}
        {running && <Dots />}
        <Icon name="chevron-right" size={12} className="tool-chev" />
      </button>
      {open && (
        <ul className="explore-list">
          {blocks.map((b) => {
            const r = results[b.id];
            const t = toolTitle(b);
            const n = r ? r.content.split('\n').filter(Boolean).length : 0;
            return (
              <li key={b.id}>
                <Icon name={b.name === 'Read' || b.name === 'LS' ? 'file' : 'search'} size={13} />
                <span className="explore-verb">{t.verb}</span>
                <span className="mono-ish" title={chipTitle(b, cwd)}>{b.name === 'Read' ? relPath(toolPath(b), cwd) : t.subject}</span>
                {b.name !== 'Read' && r && !r.isError && <span className="explore-n">{n} result{n === 1 ? '' : 's'}</span>}
                {r?.isError && <span className="meta-err">error</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

function chipTitle(b: ToolUseBlock, cwd: string): string {
  if (b.name === 'Read' || b.name === 'LS') return relPath(toolPath(b), cwd);
  return `${b.name}: ${str(b.input.pattern)}${b.input.path ? ' in ' + str(b.input.path) : ''}`;
}

export { MAIN_LANE };
