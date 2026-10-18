import type { PermissionMode } from '@workstation/protocol';

export type TextBlock = { type: 'text'; text: string; final?: boolean };
export type ThinkingBlock = { type: 'thinking'; text: string; final?: boolean; redacted?: boolean };
export type ToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  partialJson?: string;
  final?: boolean;
};
export type Block = TextBlock | ThinkingBlock | ToolUseBlock;

export interface AssistantItem {
  kind: 'assistant';
  id: string;
  msgId: string;
  blocks: Block[];
  error?: string;
  ts: number;
}
export interface ImageRef { mediaType: string; dataBase64?: string; url?: string; name?: string }
export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
  images: ImageRef[];
  uuid?: string;
  pending?: boolean;
  failed?: boolean;
  ts: number;
}
export type NoticeAction = 'settings' | 'retry' | 'close-idle';
export interface NoticeItem { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string; ts: number; code?: string; action?: NoticeAction }
/**
 * How a turn ended, from structural signals only (never from error text):
 * ok; stopped (the user interrupted: our own interrupt request, or the SDK's aborted_* terminal reason with no error reported);
 * reported (an error event already told the user why: shown once as a notice, not again as a banner); error (anything else).
 */
export type ResultOutcome = 'ok' | 'stopped' | 'reported' | 'error';
export interface ResultItem {
  kind: 'result';
  id: string;
  ok: boolean;
  outcome: ResultOutcome;
  subtype: string;
  text?: string;
  errors?: string[];
  /** the human-readable failure for outcome 'error' (SDK diagnostics removed; those go to the console) */
  message?: string;
  action?: NoticeAction;
  costUsd: number;
  turnCostUsd: number;
  durationMs: number;
  turns: number;
  ts: number;
}
export type Item = AssistantItem | UserItem | NoticeItem | ResultItem;

export interface Lane {
  items: Item[];
  /** item currently receiving stream deltas + stream index -> block index map */
  live: { id: string; map: Record<number, number> } | null;
}

export interface ToolResult {
  content: string;
  isError: boolean;
  images: ImageRef[];
  /** the step was cut short by the user's Stop (its error result is not a failure) */
  stopped?: boolean;
  /** SDK `tool_use_result` (structured patch etc.), when provided */
  raw?: unknown;
}

export interface TaskInfo {
  taskId: string;
  toolUseId?: string;
  description: string;
  subagentType?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  summary?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  lastToolName?: string;
}

export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

export interface InitInfo {
  model?: string;
  cwd?: string;
  tools: string[];
  slashCommands: string[];
  skills: string[];
  agents: string[];
  mcpServers: { name: string; status: string; error?: string; tools?: string[] }[];
  permissionMode?: PermissionMode;
  version?: string;
  /** set when the server created a git worktree for this session */
  worktree?: { path: string; branch: string; root?: string } | null;
}

export interface UsageTotals {
  costUsd: number;
  turns: number;
  durationMs: number;
  /** false for a resumed session whose past usage cannot be read (the transcript has no result messages): show "–", not $0.00 / 0 turns */
  known?: boolean;
  /** cost of earlier runs of this session: the SDK's total_cost_usd restarts from 0 in every new process */
  costBase?: number;
}

export interface Conversation {
  lanes: Record<string, Lane>;
  toolResults: Record<string, ToolResult>;
  toolProgress: Record<string, number>;
  tasks: Record<string, TaskInfo>;
  retry: { attempt: number; max: number; delayMs: number; status: number | null; message: string; at: number } | null;
  statusText: string | null;
  init?: InitInfo;
  usage: UsageTotals;
  contextTokens?: number;
  todos: Todo[] | null;
  plan: string | null;
  seq: number;
  /** the user pressed Stop (or the server reported our interrupt) during the running turn; cleared when the turn's result arrives */
  interruptRequested: boolean;
  /** an `error` event already reported why the running turn failed; cleared when the result arrives */
  turnError: string | null;
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  hasSuggestions: boolean;
  agentID?: string;
  at: number;
}

export const MAIN_LANE = '';
