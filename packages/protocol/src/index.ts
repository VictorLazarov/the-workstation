/**
 * Wire protocol between @workstation/web and @workstation/server.
 * SDK messages are forwarded verbatim (`SdkEvent.message`) so the UI can render any
 * message type the Agent SDK adds; the web package narrows them by `type`/`subtype`.
 */

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto' | 'dontAsk';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Client-visible id of a live or historical session (== SDK session_id). */
export type SessionId = string;

export interface ImageAttachment { mediaType: string; dataBase64: string; name?: string }

// ───────────── Client → Server (WebSocket) ─────────────
export type ClientMessage =
  | { type: 'session.start'; reqId: string; cwd: string; resume?: SessionId; fork?: boolean;
      model?: string; effort?: EffortLevel; permissionMode?: PermissionMode; worktree?: boolean }
  // re-subscribe to a live session after reconnect; replays buffered `sdk` events with seq > fromSeq (all buffered if omitted)
  | { type: 'session.attach'; reqId: string; sessionId: SessionId; fromSeq?: number }
  | { type: 'session.close'; sessionId: SessionId }
  | { type: 'prompt'; sessionId: SessionId; text: string; images?: ImageAttachment[]; clientMsgId: string }
  | { type: 'interrupt'; sessionId: SessionId }
  | { type: 'permission.respond'; sessionId: SessionId; requestId: string; decision: PermissionDecision }
  | { type: 'set.model'; sessionId: SessionId; model?: string }
  | { type: 'set.permissionMode'; sessionId: SessionId; mode: PermissionMode }
  | { type: 'set.effort'; sessionId: SessionId; effort: EffortLevel }
  | { type: 'rewind'; sessionId: SessionId; reqId: string; userMessageId: string; dryRun?: boolean }
  | { type: 'mcp.toggle'; sessionId: SessionId; server: string; enabled: boolean }
  | { type: 'mcp.reconnect'; sessionId: SessionId; server: string }
  /** Remove the git worktree this server created for the session (acks with { removed, branchDeleted, reason? }). Refuses a dirty worktree unless `force`. */
  | { type: 'worktree.remove'; reqId: string; sessionId: SessionId; force?: boolean }
  /** Ask the live session's SDK query for its real context-window breakdown (acks with `ContextUsage`). `detail` defaults to 'full' ('summary' skips the per-category token-count calls). */
  /** Stop one running subagent / background task by its SDK task id (`task_started.task_id`). Acks `{ stopped: true }`. */
  | { type: 'task.stop'; reqId: string; sessionId: SessionId; taskId: string }
  | { type: 'context.usage'; reqId: string; sessionId: SessionId; detail?: 'summary' | 'full' }
  | { type: 'ping' };

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>;
      /** Persist the SDK's rule suggestions (addRules/addDirectories only; never a mode switch). `true` keeps each
       *  suggestion's own destination (normally `.claude/settings.local.json`); `'session'` keeps them in memory for this session only. */
      remember?: boolean | 'session';
      /** Also switch the session's permission mode (e.g. ExitPlanMode "approve & auto-accept edits" => `acceptEdits`). */
      setMode?: PermissionMode }
  | { behavior: 'deny'; message?: string; interrupt?: boolean };

// ───────────── Server → Client (WebSocket) ─────────────
export type ServerMessage =
  | { type: 'hello'; version: string; serverCwd: string; mock: boolean }
  | { type: 'ack'; reqId: string; ok: true; data?: unknown }
  /** `code` is set for API/runtime failures surfaced from the SDK (e.g. `authentication_failed`, `rate_limit`, `process_exited`). */
  | { type: 'error'; reqId?: string; sessionId?: SessionId; message: string; code?: string }
  | { type: 'session.started'; reqId: string; sessionId: SessionId; cwd: string; init: unknown /* SDK system/init msg */ }
  | { type: 'session.ended'; sessionId: SessionId; reason: string }
  | { type: 'sdk'; sessionId: SessionId; seq: number; message: unknown /* SDKMessage */ }
  | { type: 'permission.request'; sessionId: SessionId; requestId: string; toolName: string;
      input: Record<string, unknown>; toolUseID: string; title?: string; description?: string;
      decisionReason?: string; blockedPath?: string; hasSuggestions: boolean; agentID?: string;
      /** Raw SDK PermissionUpdate[] that `remember` would apply (for display, e.g. "Always allow `Bash(npm test)`"). */
      suggestions?: unknown[] }
  | { type: 'permission.cancelled'; sessionId: SessionId; requestId: string }
  | { type: 'state'; sessionId: SessionId; state: SessionRuntimeState }
  | { type: 'pong' };

export interface SessionRuntimeState {
  status: 'idle' | 'running' | 'waiting_permission' | 'starting' | 'closed';
  model?: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  /** Permission rules remembered during this session via `remember` (informational list). */
  rules?: SessionRule[];
}
export interface SessionRule { toolName: string; ruleContent?: string; behavior: 'allow' | 'deny' | 'ask'; destination: string }

/** One row of the context-window breakdown (name is display text from the SDK; classify on `kind`). */
export interface ContextUsageCategory { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' | 'deferred'; isDeferred?: boolean }
export interface ContextUsageTool { name: string; serverName: string; tokens: number; isLoaded?: boolean }
export interface ContextMessageBreakdown {
  toolCallTokens: number; toolResultTokens: number; attachmentTokens: number; assistantMessageTokens: number; userMessageTokens: number;
  redirectedContextTokens: number; unattributedTokens: number;
}
/**
 * Real context-window usage of a live session: the SDK's `query.getContextUsage()` response with the bulky per-square
 * `gridRows` dropped. `source` is 'sdk' for the real thing and 'mock' for the offline mock agent.
 */
export interface ContextUsage {
  source: 'sdk' | 'mock';
  detail: 'summary' | 'full';
  model: string;
  categories: ContextUsageCategory[];
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  /** 0..100 */
  percentage: number;
  mcpTools: ContextUsageTool[];
  isAutoCompactEnabled: boolean;
  autoCompactThreshold?: number;
  messageBreakdown?: ContextMessageBreakdown;
  apiUsage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } | null;
  /** epoch ms when the server produced this snapshot */
  at: number;
}

// ───────────── REST (/api) ─────────────
export interface SessionSummary {
  sessionId: SessionId; title: string; cwd?: string; gitBranch?: string;
  lastModified: number; createdAt?: number; live: boolean; tag?: string;
}
export interface AppConfig {
  anthropicBaseUrl?: string;
  /** Never returned in full by GET; use `hasApiKey`. Accepted on PUT. */
  apiKey?: string; hasApiKey?: boolean;
  authToken?: string; hasAuthToken?: boolean;
  /** Auto-deny permission requests that nobody can answer (no browser attached) after this many seconds. Unset/0 = wait forever. */
  permissionTimeoutSec?: number;
  defaultModel?: string; defaultEffort?: EffortLevel; defaultPermissionMode?: PermissionMode;
  /** Extra env vars passed to Claude Code (e.g. ANTHROPIC_DEFAULT_SONNET_MODEL). */
  env?: Record<string, string>;
  /** Additional model ids offered in the model picker (custom providers). */
  customModels?: string[];
  recentProjects?: string[];
  theme?: 'system' | 'light' | 'dark';
}
export interface FsEntry { name: string; path: string; kind: 'file' | 'dir' | 'symlink'; size?: number }
export interface GitFileStatus { path: string; index: string; worktree: string }
/** `files[].path` is relative to the repository `root` (git porcelain semantics), not to the requested cwd. */
export interface GitStatus { branch?: string; ahead?: number; behind?: number; files: GitFileStatus[]; isRepo: boolean; root?: string }
export interface GitCommitResult { ok: true; commit: string; summary: string }
export interface GitRevertResult { ok: true; action: 'restored' | 'deleted' }

/**
 * REST endpoints (all JSON, `Authorization: Bearer <token>`):
 *  GET  /api/health
 *  GET  /api/config            PUT /api/config  (partial AppConfig)
 *  GET  /api/sessions?cwd=     -> SessionSummary[]
 *  GET  /api/sessions/:id/messages?cwd=  -> { messages: unknown[] }  (SDK getSessionMessages)
 *  PATCH /api/sessions/:id {title}   DELETE /api/sessions/:id[?force=1]  -> { ok, worktree? } (also removes a server-created clean worktree)
 *  GET  /api/sessions/:id/context?detail=summary|full -> ContextUsage   (live sessions only; 404 otherwise)
 *  GET  /api/models            -> ModelOption[]
 *  GET  /api/fs/list?path=     -> FsEntry[]        (directory browser / file tree)
 *  GET  /api/fs/read?path=     -> { content, encoding, truncated }
 *  GET  /api/files/search?cwd=&q= -> string[]      (@mention fuzzy search)
 *  GET  /api/git/status?cwd=   -> GitStatus
 *  GET  /api/git/diff?cwd=&path= -> { diff: string }
 *  POST /api/git/commit {cwd, message, files[]} -> GitCommitResult (stages and commits exactly `files`, each a current
 *                                       git status entry; repository hooks run, a hook failure is a 409 with its output)
 *  POST /api/git/revert {cwd, path}     -> GitRevertResult   (restore tracked file to HEAD / delete untracked; `path` must
 *                                       equal one status entry literally: no globs, no pathspec magic, inside the repo)
 *  GET  /api/git/diff?path=             only serves files inside the repository (tracked or untracked-not-ignored)
 *  GET  /api/commands?cwd=     -> SlashCommandInfo[]
 *  WS   /ws
 */
export interface ModelOption { id: string; label: string; description?: string; supportsEffort?: boolean; supportedEffortLevels?: EffortLevel[] }
export interface SlashCommandInfo { name: string; description: string; argumentHint?: string }

export const DEFAULT_PORT = 7777;
