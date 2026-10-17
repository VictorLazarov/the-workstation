import { memo, useMemo, useState, type ReactNode } from 'react';
import type { Conversation, PermissionRequest, TaskInfo, ToolResult, ToolUseBlock } from '../lib/types';
import { MAIN_LANE } from '../lib/types';
import { collapseContext, diffLines, diffStats, fromStructuredPatch, type DiffLine } from '../lib/diff';
import { hostOf, mcpParts, str, toolKind, toolPath, toolTitle } from '../lib/tools';
import { basename, formatDuration, formatTokens, relPath, truncate } from '../lib/utils';
import { useHasPanel } from '../panels/registry';
import { useUi } from '../store/ui';
import { Icon, type IconName } from './Icon';
import { CopyButton, Spinner } from './ui';
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
}

export function toolStatus(p: Pick<ToolProps, 'block' | 'result' | 'perm' | 'outcome' | 'sessionRunning'>): ToolStatus {
  if (p.perm) return 'waiting';
  if (p.result) return p.outcome === 'denied' ? 'denied' : p.result.isError ? 'error' : 'done';
  if (!p.block.final && p.block.partialJson !== undefined) return 'streaming';
  return p.sessionRunning ? 'running' : 'stopped';
}

function StatusIcon({ status }: { status: ToolStatus }) {
  if (status === 'running' || status === 'streaming') return <Spinner size={13} />;
  if (status === 'waiting') return <Icon name="shield" size={14} className="st-wait" />;
  if (status === 'done') return <Icon name="check" size={14} className="st-ok" />;
  if (status === 'error') return <Icon name="alert" size={14} className="st-err" />;
  if (status === 'denied') return <Icon name="x" size={14} className="st-err" />;
  return <Icon name="clock" size={13} className="st-dim" />;
}

const KIND_ICON: Record<string, IconName> = {
  bash: 'terminal', edit: 'file-edit', write: 'file-plus', read: 'eye', search: 'search', web: 'globe', task: 'bot',
  todo: 'list-checks', ask: 'help', plan: 'list', mcp: 'zap', other: 'wrench',
};

/** Collapsible card chrome shared by all tool renderings. */
export function Shell({ kind, title, subtitle, status, meta, defaultOpen = false, forceOpen, children, actions, flush, tone }: {
  kind: string; title: ReactNode; subtitle?: ReactNode; status: ToolStatus; meta?: ReactNode; defaultOpen?: boolean; forceOpen?: boolean;
  children?: ReactNode; actions?: ReactNode; flush?: boolean; tone?: 'warn';
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = forceOpen || open;
  const has = children != null && children !== false;
  return (
    <div className={`tool tool-${kind} st-${status}${isOpen ? ' open' : ''}${tone ? ' tone-' + tone : ''}`}>
      <div className="tool-head" role={has ? 'button' : undefined} tabIndex={has ? 0 : undefined} aria-expanded={has ? isOpen : undefined}
        onClick={() => has && setOpen(!open)} onKeyDown={(e) => { if (has && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(!open); } }}>
        <span className="tool-ico"><Icon name={KIND_ICON[kind] ?? 'wrench'} size={15} /></span>
        <span className="tool-title">{title}</span>
        {subtitle && <span className="tool-sub">{subtitle}</span>}
        <span className="tool-spacer" />
        {meta && <span className="tool-meta">{meta}</span>}
        {actions}
        <StatusIcon status={status} />
        {has && <Icon name="chevron-right" size={14} className="tool-chev" />}
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
    <Shell kind="bash" status={p.status} defaultOpen={p.status === 'waiting' || p.status === 'running' || p.status === 'error'} forceOpen={p.status === 'waiting'}
      title={desc || 'Run command'} subtitle={bg ? 'background' : undefined}
      meta={<>{p.elapsed ? <span className="pill">{formatDuration(p.elapsed * 1000)}</span> : null}{exit && exit !== '0' ? <span className="pill pill-err">exit {exit}</span> : p.status === 'done' ? <span className="pill pill-ok">exit 0</span> : null}</>}>
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

function EditCard(p: ToolProps & { status: ToolStatus; footer: ReactNode }) {
  const path = toolPath(p.block);
  const { lines, isNew } = useMemo(() => editLines(p.block, p.result), [p.block, p.result]);
  const st = useMemo(() => diffStats(lines), [lines]);
  const hasChanges = useHasPanel('changes');
  const hasInput = Object.keys(p.block.input).length > 0;
  return (
    <Shell kind={p.block.name === 'Write' ? 'write' : 'edit'} status={p.status} flush defaultOpen forceOpen={p.status === 'waiting'}
      title={<span className="filename" title={path}>{relPath(path, p.cwd)}</span>}
      subtitle={isNew ? <span className="pill pill-ok">new</span> : p.block.name === 'MultiEdit' ? <span className="pill">{(p.block.input.edits as unknown[] | undefined)?.length ?? 0} edits</span> : undefined}
      meta={hasInput ? <span className="stats"><span className="add">+{st.added}</span><span className="del">−{st.removed}</span></span> : null}
      actions={hasChanges && p.status === 'done' ? <button type="button" className="link-btn" onClick={(e) => { e.stopPropagation(); useUi.getState().openInspector('changes', path); }}>Review</button> : null}>
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
    <Shell kind="web" status={p.status} defaultOpen={p.status === 'waiting'} forceOpen={p.status === 'waiting'}
      title={isSearch ? <>Searched the web</> : <>Fetched <span className="mono">{hostOf(url)}</span></>}
      subtitle={isSearch ? <span className="query">“{truncate(str(p.block.input.query), 70)}”</span> : <span className="query">{truncate(str(p.block.input.prompt), 70)}</span>}>
      {!isSearch && url && <a className="source-link" href={url} target="_blank" rel="noreferrer noopener"><Icon name="external" size={13} />{url}</a>}
      {text && <Output text={text} isError={p.result?.isError} max={6} />}
      {p.footer}
    </Shell>
  );
}

export function TodoList({ todos, compact }: { todos: { content: string; status: string; activeForm?: string }[]; compact?: boolean }) {
  return (
    <ul className={`todos${compact ? ' compact' : ''}`}>
      {todos.map((t, i) => (
        <li key={i} className={`todo ${t.status}`}>
          <span className="todo-box" aria-hidden="true">{t.status === 'completed' ? <Icon name="check" size={11} /> : t.status === 'in_progress' ? <Spinner size={10} /> : null}</span>
          <span className="todo-text">{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
        </li>
      ))}
    </ul>
  );
}

function TodoCard(p: ToolProps & { status: ToolStatus }) {
  const todos = (Array.isArray(p.block.input.todos) ? p.block.input.todos : []) as { content: string; status: string; activeForm?: string }[];
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <Shell kind="todo" status={p.status === 'done' ? 'done' : p.status} defaultOpen title="Plan" subtitle={todos.length ? `${done}/${todos.length} done` : undefined}>
      <TodoList todos={todos} />
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
    <Shell kind="task" status={p.status} defaultOpen={running} forceOpen={p.status === 'waiting'}
      title={<><span className="agent-name">{str(i.subagent_type) || 'Subagent'}</span></>}
      subtitle={truncate(str(i.description), 90)}
      meta={<>
        {toolCount > 0 && <span className="pill">{toolCount} tool{toolCount > 1 ? 's' : ''}</span>}
        {p.task?.totalTokens ? <span className="pill">{formatTokens(p.task.totalTokens)} tok</span> : null}
        {p.task?.durationMs ? <span className="pill">{formatDuration(p.task.durationMs)}</span> : null}
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
    <Shell kind={kind} status={p.status} defaultOpen={p.status === 'waiting'} forceOpen={p.status === 'waiting'}
      title={server ? <span className="mono-ish">{tool.replace(/_/g, ' ')}</span> : p.block.name}
      subtitle={server ? <span className="pill">{server}</span> : undefined}>
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
    ? <PermissionActions perm={p.perm} onRespond={p.onRespond} />
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
  return (
    <div className={`explore${open ? ' open' : ''}`}>
      <button type="button" className="explore-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {running ? <Spinner size={12} /> : <Icon name="eye" size={14} />}
        <span className="explore-label">{cap(label)}</span>
        <span className="chips">
          {!open && blocks.slice(0, 5).map((b) => <span key={b.id} className="chip" title={chipTitle(b, cwd)}>{chipLabel(b)}</span>)}
          {!open && blocks.length > 5 && <span className="chip chip-more">+{blocks.length - 5}</span>}
        </span>
        <Icon name="chevron-right" size={13} className="tool-chev" />
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
                {b.name !== 'Read' && r && !r.isError && <span className="pill">{n} result{n === 1 ? '' : 's'}</span>}
                {r?.isError && <span className="pill pill-err">error</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

function chipLabel(b: ToolUseBlock): string {
  if (b.name === 'Read') return basename(toolPath(b));
  if (b.name === 'LS') return basename(toolPath(b)) || '.';
  return truncate(str(b.input.pattern), 24);
}
function chipTitle(b: ToolUseBlock, cwd: string): string {
  if (b.name === 'Read' || b.name === 'LS') return relPath(toolPath(b), cwd);
  return `${b.name}: ${str(b.input.pattern)}${b.input.path ? ' in ' + str(b.input.path) : ''}`;
}

export { MAIN_LANE };
