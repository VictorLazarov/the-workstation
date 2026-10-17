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
  | { type: 'session.attach'; reqId: string; sessionId: SessionId }   // re-subscribe to a live session after reconnect
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
  | { type: 'ping' };

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; remember?: boolean /* apply SDK suggestions */ }
  | { behavior: 'deny'; message?: string; interrupt?: boolean };

// ───────────── Server → Client (WebSocket) ─────────────
export type ServerMessage =
  | { type: 'hello'; version: string; serverCwd: string; mock: boolean }
  | { type: 'ack'; reqId: string; ok: true; data?: unknown }
  | { type: 'error'; reqId?: string; sessionId?: SessionId; message: string }
  | { type: 'session.started'; reqId: string; sessionId: SessionId; cwd: string; init: unknown /* SDK system/init msg */ }
  | { type: 'session.ended'; sessionId: SessionId; reason: string }
  | { type: 'sdk'; sessionId: SessionId; seq: number; message: unknown /* SDKMessage */ }
  | { type: 'permission.request'; sessionId: SessionId; requestId: string; toolName: string;
      input: Record<string, unknown>; toolUseID: string; title?: string; description?: string;
      decisionReason?: string; blockedPath?: string; hasSuggestions: boolean; agentID?: string }
  | { type: 'permission.cancelled'; sessionId: SessionId; requestId: string }
  | { type: 'state'; sessionId: SessionId; state: SessionRuntimeState }
  | { type: 'pong' };

export interface SessionRuntimeState {
  status: 'idle' | 'running' | 'waiting_permission' | 'starting' | 'closed';
  model?: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
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
export interface GitStatus { branch?: string; ahead?: number; behind?: number; files: GitFileStatus[]; isRepo: boolean }

/**
 * REST endpoints (all JSON, `Authorization: Bearer <token>`):
 *  GET  /api/health
 *  GET  /api/config            PUT /api/config  (partial AppConfig)
 *  GET  /api/sessions?cwd=     -> SessionSummary[]
 *  GET  /api/sessions/:id/messages?cwd=  -> { messages: unknown[] }  (SDK getSessionMessages)
 *  PATCH /api/sessions/:id {title}   DELETE /api/sessions/:id
 *  GET  /api/models            -> ModelOption[]
 *  GET  /api/fs/list?path=     -> FsEntry[]        (directory browser / file tree)
 *  GET  /api/fs/read?path=     -> { content, encoding, truncated }
 *  GET  /api/files/search?cwd=&q= -> string[]      (@mention fuzzy search)
 *  GET  /api/git/status?cwd=   -> GitStatus
 *  GET  /api/git/diff?cwd=&path= -> { diff: string }
 *  GET  /api/commands?cwd=     -> SlashCommandInfo[]
 *  WS   /ws
 */
export interface ModelOption { id: string; label: string; description?: string }
export interface SlashCommandInfo { name: string; description: string; argumentHint?: string }

export const DEFAULT_PORT = 7777;
