import { useMemo } from 'react';
import { formatDuration, formatTokens } from '../lib/utils';
import { Icon } from '../components/Icon';
import { IconButton, Spinner } from '../components/ui';
import { useUi } from '../store/ui';
import { useSessions } from '../store/sessions';
import { registerPanel, type PanelProps } from './registry';
import { deriveTasks, isActive, sortTasks, type TaskRow, type TaskStatus } from './tasks/derive';
import './panels.css';

const LABEL: Record<TaskStatus, string> = {
  running: 'Running', pending: 'Starting', completed: 'Done', failed: 'Failed', stopped: 'Stopped', started: 'In background',
};

/** Scroll the conversation to a tool call card and flash it. */
export function scrollToToolCall(id: string): boolean {
  const el = document.querySelector<HTMLElement>(`[data-tool-id="${CSS.escape(id)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash-target');
  void el.offsetWidth;
  el.classList.add('flash-target');
  setTimeout(() => el.classList.remove('flash-target'), 1800);
  return true;
}

function StatusIcon({ s }: { s: TaskStatus }) {
  if (isActive(s)) return <Spinner size={14} />;
  if (s === 'completed') return <Icon name="check" size={15} className="st-ok" />;
  if (s === 'failed') return <Icon name="alert" size={15} className="st-err" />;
  if (s === 'started') return <Icon name="terminal" size={14} className="st-dim" />;
  return <Icon name="stop" size={13} className="st-dim" />;
}

function Row({ t, sessionId }: { t: TaskRow; sessionId: string }) {
  const canJump = !!t.toolUseId;
  const canStop = isActive(t.status) && !!t.taskId;
  const stop = () => { void useSessions.getState().stopTask(sessionId, t.taskId!).catch((e: Error) => useUi.getState().toast({ kind: 'error', title: 'Could not stop the task', body: e.message })); };
  return (
    <li className="task-li">
      <button type="button" className={`task-row st-${t.status}`} disabled={!canJump} onClick={() => t.toolUseId && scrollToToolCall(t.toolUseId)}
        title={canJump ? 'Show in conversation' : undefined}>
        <span className="task-ico"><StatusIcon s={t.status} /></span>
        <span className="task-main">
          <span className="task-top">
            <b className="task-title">{t.title}</b>
            <span className={`task-state ts-${t.status}`}>{LABEL[t.status]}</span>
          </span>
          {t.description && <span className="task-desc">{t.description}</span>}
          {t.lastTool && <span className="task-last"><Spinner size={10} /> Using {t.lastTool}…</span>}
          {t.summary && !isActive(t.status) && t.summary.trim() !== t.description.trim() && <span className="task-summary">{t.summary}</span>}
          {(t.tools || t.tokens || t.durationMs) ? (
            <span className="task-meta">
              {t.tools ? <span className="pill">{t.tools} tool{t.tools > 1 ? 's' : ''}</span> : null}
              {t.tokens ? <span className="pill">{formatTokens(t.tokens)} tok</span> : null}
              {t.durationMs ? <span className="pill">{formatDuration(t.durationMs)}</span> : null}
            </span>
          ) : null}
        </span>
        {canJump && <Icon name="chevron-right" size={13} className="task-go" />}
      </button>
      {canStop && <IconButton icon="stop" label={`Stop ${t.title}`} size={12} className="task-stop" onClick={stop} />}
    </li>
  );
}

function useTasks(id: string): TaskRow[] {
  const conv = useSessions((s) => s.sessions[id]?.conv);
  const running = useSessions((s) => { const r = s.sessions[id]?.runtime.status; return r === 'running' || r === 'waiting_permission'; });
  const live = useSessions((s) => !!s.sessions[id]?.live);
  return useMemo(() => (conv ? sortTasks(deriveTasks(conv, running, live)) : []), [conv, running, live]);
}

function TasksPanel({ sessionId }: PanelProps) {
  const rows = useTasks(sessionId);
  if (!rows.length) {
    return (
      <div className="panel-empty">
        <Icon name="bot" size={22} />
        <b>No tasks</b>
        <span>Subagents and background commands Claude starts show up here with live progress.</span>
      </div>
    );
  }
  const active = rows.filter((r) => isActive(r.status));
  const rest = rows.filter((r) => !isActive(r.status));
  return (
    <div className="tasks">
      {active.length > 0 && (<section><div className="panel-title"><span>Running</span><span className="muted">{active.length}</span></div><ul className="task-list">{active.map((t) => <Row key={t.id} t={t} sessionId={sessionId} />)}</ul></section>)}
      {rest.length > 0 && (<section><div className="panel-title"><span>{active.length ? 'Finished' : 'Tasks'}</span><span className="muted">{rest.length}</span></div><ul className="task-list">{rest.map((t) => <Row key={t.id} t={t} sessionId={sessionId} />)}</ul></section>)}
    </div>
  );
}

registerPanel({
  id: 'tasks', title: 'Tasks', icon: 'bot', order: 40, component: TasksPanel,
  useBadge: (id) => {
    const rows = useTasks(id);
    const n = rows.filter((r) => isActive(r.status)).length;
    return n || undefined;
  },
});
