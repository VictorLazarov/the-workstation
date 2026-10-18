import { allToolUses } from '../../lib/reducer';
import type { Conversation } from '../../lib/types';
import { str, toolKind } from '../../lib/tools';

export type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'started' | 'pending';
export interface TaskRow {
  /** tool_use id when known (used to scroll the conversation), else the task id */
  id: string;
  toolUseId?: string;
  /** SDK task id (what `stopTask` takes) when the task_* events told us */
  taskId?: string;
  kind: 'subagent' | 'background';
  title: string;
  description: string;
  status: TaskStatus;
  tools?: number;
  tokens?: number;
  durationMs?: number;
  lastTool?: string;
  summary?: string;
}

export const isActive = (s: TaskStatus) => s === 'running' || s === 'pending';

/**
 * Subagents (Task/Agent tool calls enriched with task_* system events) and background shell commands.
 * A task the CLI announced (`task_started`) is running until it says otherwise (`task_notification`: completed, failed or
 * stopped, also after a Stop or an interrupt): background subagents and commands keep running after the main turn is over,
 * so an idle session does not mean a stopped task. Only when the session itself is gone (`live=false`) is unfinished work
 * shown as `stopped` rather than a spinner that never ends. Work with no task events falls back to the turn state.
 */
export function deriveTasks(conv: Conversation, sessionRunning: boolean, live: boolean = sessionRunning): TaskRow[] {
  const rows: TaskRow[] = [];
  const seen = new Set<string>();
  for (const b of allToolUses(conv)) {
    const kind = toolKind(b.name);
    const bg = b.name === 'Bash' && !!b.input.run_in_background;
    if (kind !== 'task' && !bg) continue;
    const info = conv.tasks[b.id];
    const res = conv.toolResults[b.id];
    seen.add(b.id);
    let status: TaskStatus;
    if (info) status = info.status === 'running' && !live ? 'stopped' : info.status;
    else if (bg) status = res ? (res.isError ? 'failed' : 'started') : sessionRunning ? 'pending' : 'stopped';
    else status = res ? (res.isError ? 'failed' : 'completed') : sessionRunning ? 'running' : 'stopped';
    const lane = conv.lanes[b.id];
    const laneTools = lane ? lane.items.reduce((n, it) => n + (it.kind === 'assistant' ? it.blocks.filter((x) => x.type === 'tool_use').length : 0), 0) : 0;
    rows.push({
      id: b.id, toolUseId: b.id, taskId: info?.taskId, kind: bg ? 'background' : 'subagent',
      title: bg ? 'Background command' : str(b.input.subagent_type) || info?.subagentType || 'Subagent',
      description: bg ? str(b.input.description) || str(b.input.command) : str(b.input.description) || info?.description || '',
      status, tools: info?.toolUses ?? (laneTools || undefined), tokens: info?.totalTokens, durationMs: info?.durationMs,
      lastTool: status === 'running' ? info?.lastToolName : undefined, summary: info?.summary,
    });
  }
  for (const [key, info] of Object.entries(conv.tasks)) {
    if (seen.has(key) || (info.toolUseId && seen.has(info.toolUseId))) continue;
    rows.push({
      id: key, toolUseId: info.toolUseId, taskId: info.taskId, kind: info.subagentType ? 'subagent' : 'background', title: info.subagentType || 'Background task',
      description: info.description, status: info.status === 'running' && !live ? 'stopped' : info.status, tools: info.toolUses,
      tokens: info.totalTokens, durationMs: info.durationMs, lastTool: info.lastToolName, summary: info.summary,
    });
  }
  return rows;
}

/** Running first, then the rest in reverse chronological order. */
export function sortTasks(rows: TaskRow[]): TaskRow[] {
  const act = rows.filter((r) => isActive(r.status));
  const rest = rows.filter((r) => !isActive(r.status)).reverse();
  return [...act, ...rest];
}
