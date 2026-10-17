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
export interface NoticeItem { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string; ts: number }
export interface ResultItem {
  kind: 'result';
  id: string;
  ok: boolean;
  subtype: string;
  text?: string;
  errors?: string[];
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
  mcpServers: { name: string; status: string; error?: string }[];
  permissionMode?: PermissionMode;
  version?: string;
}

export interface UsageTotals {
  costUsd: number;
  turns: number;
  durationMs: number;
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
