import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Options, PermissionResult, PermissionUpdate, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  ClientMessage, EffortLevel, ImageAttachment, PermissionDecision, PermissionMode, ServerMessage, SessionId, SessionRule, SessionRuntimeState,
} from '@workstation/protocol';
import type { ConfigStore } from './config.js';
import { HttpError, requireDir } from './files.js';
import { createWorktree, gitRoot } from './git.js';
import { headSha, removeWorktree, WorktreeRegistry, type WorktreeRemoval } from './worktrees.js';
import { buildCliEnv, type QueryHandle, type SdkAdapter } from './sdk.js';

export interface Subscriber {
  id: string;
  send(msg: ServerMessage): void;
}

type Json = Record<string, unknown>;

class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private done = false;
  push(m: SDKUserMessage) {
    if (this.done) return;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w({ value: m, done: false }); } else this.items.push(m);
  }
  end() {
    this.done = true;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w({ value: undefined, done: true }); }
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => { this.waiter = r; });
      },
      return: () => { this.end(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

interface Pending {
  requestId: string;
  toolName: string;
  input: Json;
  suggestions?: PermissionUpdate[];
  toolUseID: string;
  request: Extract<ServerMessage, { type: 'permission.request' }>;
  resolve: (r: PermissionResult) => void;
}

interface BufferedEvent { seq: number; message: unknown; bytes: number }

export interface LiveSession {
  id: SessionId;
  cwd: string;
  worktree?: { path: string; branch: string };
  query: QueryHandle;
  queue: PromptQueue;
  subs: Set<Subscriber>;
  buffer: BufferedEvent[];
  seq: number;
  /** highest seq evicted because the buffer was full (not by compaction) */
  evictedThrough: number;
  pending: Map<string, Pending>;
  /** uuids of prompts we queued that the CLI has not finished yet (it may fold several into one turn) */
  inflight: Map<string, 'queued' | 'started'>;
  /** true once the CLI emitted command_lifecycle messages (then `result` no longer retires prompts) */
  lifecycle: boolean;
  autoTurn: boolean;
  /** rules remembered through `remember` during this session */
  rules: SessionRule[];
  /** timer that auto-denies pending permission requests while no browser is attached */
  orphanTimer?: NodeJS.Timeout;
  bufferBytes: number;
  /** a fatal API error already interrupted the current turn */
  fatalInterrupted: boolean;
  model?: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  lastStatus: SessionRuntimeState['status'];
  init: unknown;
  title?: string;
  createdAt: number;
  closed: boolean;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const BUFFER_SIZE = Math.max(100, Number(process.env.WORKSTATION_REPLAY_BUFFER) || 3000);
/** Replay buffer is bounded by event count and by (approximate) serialized size. */
const BUFFER_BYTES = Math.max(1_000_000, Number(process.env.WORKSTATION_REPLAY_BUFFER_BYTES) || 64 * 1024 * 1024);
/** tool_result text beyond this is cut before it is forwarded to browsers (the model still saw all of it) */
const MAX_FORWARDED_TEXT = Math.max(100_000, Number(process.env.WORKSTATION_MAX_TOOL_RESULT_CHARS) || 2_000_000);
/** API errors that retrying cannot fix: stop the CLI's retry loop and tell the user immediately. */
const FATAL_API_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'invalid_request', 'model_not_found', 'cloud_credential_error']);
const MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export class SessionManager {
  private sessions = new Map<SessionId, LiveSession>();
  readonly worktrees: WorktreeRegistry;

  constructor(private adapter: SdkAdapter, private config: ConfigStore, private serverCwd: string) {
    this.worktrees = new WorktreeRegistry(path.join(path.dirname(config.file), 'worktrees.json'));
  }

  /** 0 = wait forever. AppConfig.permissionTimeoutSec, or WORKSTATION_PERMISSION_TIMEOUT_SEC. */
  private permissionTimeoutMs(): number {
    const sec = this.config.app.permissionTimeoutSec ?? (Number(process.env.WORKSTATION_PERMISSION_TIMEOUT_SEC) || 0);
    return sec > 0 ? sec * 1000 : 0;
  }

  get(id: string): LiveSession | undefined { return this.sessions.get(id); }
  isLive(id: string): boolean { return this.sessions.has(id); }
  list(): LiveSession[] { return [...this.sessions.values()]; }

  runtimeState(s: LiveSession): SessionRuntimeState {
    return { status: s.closed ? 'closed' : this.status(s), model: s.model, permissionMode: s.permissionMode, effort: s.effort, ...(s.rules.length ? { rules: s.rules } : {}) };
  }
  private status(s: LiveSession): SessionRuntimeState['status'] {
    if (s.pending.size > 0) return 'waiting_permission';
    return s.inflight.size > 0 || s.autoTurn ? 'running' : 'idle';
  }

  private broadcast(s: LiveSession, msg: ServerMessage) {
    for (const sub of s.subs) {
      try { sub.send(msg); } catch { /* dead socket is cleaned up on close */ }
    }
  }
  private emitState(s: LiveSession, force = false) {
    const st = s.closed ? 'closed' : this.status(s);
    if (!force && st === s.lastStatus) return;
    s.lastStatus = st;
    this.broadcast(s, { type: 'state', sessionId: s.id, state: this.runtimeState(s) });
  }

  // ───────────── dispatch ─────────────
  async handle(sub: Subscriber, msg: ClientMessage): Promise<void> {
    const sessionId = (msg as { sessionId?: string }).sessionId;
    const reqId = (msg as { reqId?: string }).reqId;
    try {
      switch (msg.type) {
        case 'ping': sub.send({ type: 'pong' }); return;
        case 'session.start': await this.start(sub, msg); return;
        case 'session.attach': this.attach(sub, msg.reqId, msg.sessionId, msg.fromSeq); return;
        case 'session.close': this.close(this.must(msg.sessionId), 'closed'); return;
        case 'prompt': this.prompt(this.must(msg.sessionId), msg.text, msg.images, msg.clientMsgId); return;
        case 'interrupt': await this.interrupt(this.must(msg.sessionId)); return;
        case 'permission.respond': this.respond(this.must(msg.sessionId), msg.requestId, msg.decision); return;
        case 'set.model': {
          const s = this.must(msg.sessionId);
          if (msg.model !== undefined && typeof msg.model !== 'string') throw new Error('model must be a string');
          await s.query.setModel(msg.model || undefined);
          s.model = msg.model || undefined;
          this.emitState(s, true);
          return;
        }
        case 'set.permissionMode': {
          const s = this.must(msg.sessionId);
          if (!MODES.has(msg.mode)) throw new Error('invalid permission mode');
          await s.query.setPermissionMode(msg.mode);
          s.permissionMode = msg.mode;
          this.emitState(s, true);
          return;
        }
        case 'set.effort': {
          const s = this.must(msg.sessionId);
          if (!EFFORTS.has(msg.effort)) throw new Error('invalid effort');
          await s.query.applyFlagSettings({ effortLevel: msg.effort });
          s.effort = msg.effort;
          this.emitState(s, true);
          return;
        }
        case 'rewind': {
          const s = this.must(msg.sessionId);
          if (typeof msg.userMessageId !== 'string' || !msg.userMessageId) throw new Error('userMessageId required');
          const res = await s.query.rewindFiles(msg.userMessageId, { dryRun: !!msg.dryRun });
          sub.send({ type: 'ack', reqId: msg.reqId, ok: true, data: res });
          return;
        }
        case 'mcp.toggle': {
          const s = this.must(msg.sessionId);
          await s.query.toggleMcpServer(String(msg.server), !!msg.enabled);
          this.broadcast(s, { type: 'ack', reqId: `mcp:${s.id}`, ok: true, data: { mcpServers: await s.query.mcpServerStatus() } });
          return;
        }
        case 'mcp.reconnect': {
          const s = this.must(msg.sessionId);
          await s.query.reconnectMcpServer(String(msg.server));
          this.broadcast(s, { type: 'ack', reqId: `mcp:${s.id}`, ok: true, data: { mcpServers: await s.query.mcpServerStatus() } });
          return;
        }
        case 'worktree.remove': {
          const res = await this.removeSessionWorktree(msg.sessionId, !!msg.force);
          sub.send({ type: 'ack', reqId: msg.reqId, ok: true, data: res });
          return;
        }
        default:
          sub.send({ type: 'error', message: `unknown message type: ${(msg as { type?: string }).type}` });
      }
    } catch (e) {
      sub.send({ type: 'error', reqId, sessionId, message: e instanceof Error ? e.message : String(e) });
    }
  }

  private must(id: unknown): LiveSession {
    const s = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (!s) throw new Error(`no live session ${String(id)}`);
    return s;
  }

  // ───────────── lifecycle ─────────────
  async start(sub: Subscriber, msg: Extract<ClientMessage, { type: 'session.start' }>): Promise<LiveSession> {
    if (typeof msg.cwd !== 'string') throw new Error('cwd required');
    if (msg.resume !== undefined && (typeof msg.resume !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(msg.resume))) throw new Error('invalid resume id');
    // resuming something that is already live just attaches
    if (msg.resume && !msg.fork && this.sessions.has(msg.resume)) {
      this.attach(sub, msg.reqId, msg.resume);
      return this.sessions.get(msg.resume)!;
    }
    let cwd: string;
    try { cwd = await requireDir(msg.cwd); } catch (e) { throw new Error(e instanceof HttpError ? `cwd: ${e.message}` : String(e)); }

    const app = this.config.app;
    const id = msg.resume && !msg.fork ? msg.resume : randomUUID();
    let worktree: LiveSession['worktree'];
    if (msg.worktree) {
      const root = await gitRoot(cwd);
      const baseSha = await headSha(cwd);
      worktree = await createWorktree(cwd, id.slice(0, 8));
      if (root && baseSha) {
        const name = id.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'session';
        this.worktrees.add({ sessionId: id, root, dir: path.join(root, '.claude', 'worktrees', name), branch: worktree.branch, baseSha, createdAt: Date.now() });
      }
      cwd = worktree.path;
    }
    const permissionMode = msg.permissionMode ?? app.defaultPermissionMode ?? 'default';
    const model = msg.model ?? app.defaultModel;
    const effort = msg.effort ?? app.defaultEffort;

    const queue = new PromptQueue();
    const abort = new AbortController();
    const s: LiveSession = {
      id, cwd, worktree, queue, subs: new Set(), buffer: [], seq: 0, evictedThrough: 0, pending: new Map(), inflight: new Map(), lifecycle: false, autoTurn: false, rules: [], bufferBytes: 0, fatalInterrupted: false,
      model, permissionMode, effort, lastStatus: 'starting', init: undefined, createdAt: Date.now(), closed: false,
      query: undefined as unknown as QueryHandle,
    };

    const options: Options = {
      cwd,
      abortController: abort,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      enableFileCheckpointing: true,
      permissionMode,
      allowDangerouslySkipPermissions: true,
      canUseTool: (toolName, input, o) => this.canUseTool(s, toolName, input, o),
      env: buildCliEnv({ CLAUDE_AGENT_SDK_CLIENT_APP: 'the-workstation/0.1.0', ...this.config.providerEnv() }),
      stderr: (d) => { if (process.env.WORKSTATION_DEBUG) process.stderr.write(`[claude ${id.slice(0, 8)}] ${d}`); },
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(msg.resume ? { resume: msg.resume } : {}),
      ...(msg.resume && msg.fork ? { forkSession: true, sessionId: id } : {}),
      ...(!msg.resume ? { sessionId: id } : {}),
    };
    s.query = this.adapter.query({ prompt: queue, options });
    this.sessions.set(id, s);
    this.config.addRecentProject(msg.cwd === cwd ? cwd : path.resolve(msg.cwd));
    void this.consume(s);

    // Collect commands/models for the init payload (real init only arrives with the first prompt).
    let boot: { commands?: unknown; models?: unknown; [k: string]: unknown } = {};
    try {
      boot = await Promise.race([
        s.query.initializationResult(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('init timeout')), 20_000)),
      ]);
    } catch (e) {
      // A session that cannot initialize (bad resume id, bad cwd, CLI missing, ...) is useless: tear it down and report.
      const why = e instanceof Error ? e.message : String(e);
      this.close(s, `failed to start: ${why}`, true);
      if (msg.worktree && worktree && !msg.resume) void this.removeSessionWorktree(id, false).catch(() => {});
      throw new Error(`Claude Code did not initialize: ${why}`);
    }
    const current = boot.current_permission_mode as PermissionMode | undefined;
    s.init = {
      type: 'system', subtype: 'init', synthetic: true, session_id: id, cwd, model: model ?? null, permissionMode: current ?? permissionMode,
      slash_commands: ((boot.commands as Array<{ name: string }> | undefined) ?? []).map((c) => c.name),
      commands: boot.commands ?? [], models: boot.models ?? [], agents: boot.agents ?? [], account: boot.account,
      claude_code_version: boot.claude_code_version, worktree: worktree ?? null, mock: this.adapter.mock,
    };
    s.lastStatus = 'idle';
    sub.send({ type: 'session.started', reqId: msg.reqId, sessionId: id, cwd, init: s.init });
    s.subs.add(sub);
    this.clearOrphanTimer(s);
    sub.send({ type: 'state', sessionId: id, state: this.runtimeState(s) });
    for (const e of s.buffer) sub.send({ type: 'sdk', sessionId: id, seq: e.seq, message: e.message });
    for (const p of s.pending.values()) sub.send(p.request);
    return s;
  }

  attach(sub: Subscriber, reqId: string, sessionId: SessionId, fromSeq?: number) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`no live session ${sessionId} (it may have ended; resume it with session.start)`);
    const wasMember = s.subs.has(sub);
    s.subs.add(sub);
    this.clearOrphanTimer(s);
    const from = typeof fromSeq === 'number' && Number.isFinite(fromSeq) ? fromSeq : undefined;
    const truncated = from === undefined ? s.evictedThrough > 0 : from < s.evictedThrough;
    const events = s.buffer.filter((e) => from === undefined || e.seq > from);
    sub.send({
      type: 'ack', reqId, ok: true,
      data: { sessionId, cwd: s.cwd, init: s.init, state: this.runtimeState(s), lastSeq: s.seq, replayed: events.length, truncated, alreadyAttached: wasMember, worktree: s.worktree ?? null },
    });
    for (const e of events) sub.send({ type: 'sdk', sessionId, seq: e.seq, message: e.message });
    for (const p of s.pending.values()) sub.send(p.request);
    sub.send({ type: 'state', sessionId, state: this.runtimeState(s) });
  }

  /** Browser went away: drop the subscription, keep sessions running. */
  detach(sub: Subscriber) {
    for (const s of this.sessions.values()) {
      if (s.subs.delete(sub) && s.subs.size === 0) this.armOrphanTimer(s);
    }
  }

  /** While nobody is attached, unanswered permission requests are auto-denied after the configured timeout (default: never). */
  private armOrphanTimer(s: LiveSession) {
    const ms = this.permissionTimeoutMs();
    if (!ms || s.closed || s.orphanTimer || s.pending.size === 0 || s.subs.size > 0) return;
    s.orphanTimer = setTimeout(() => {
      s.orphanTimer = undefined;
      if (s.subs.size === 0 && s.pending.size > 0) this.cancelAllPending(s, `No one answered this permission request within ${Math.round(ms / 1000)}s (browser disconnected); it was denied.`);
    }, ms);
    s.orphanTimer.unref?.();
  }
  private clearOrphanTimer(s: LiveSession) {
    if (s.orphanTimer) { clearTimeout(s.orphanTimer); s.orphanTimer = undefined; }
  }

  /** `quiet`: tear down without telling subscribers (start failed; the caller reports the error). */
  close(s: LiveSession, reason: string, quiet = false) {
    if (s.closed) return;
    s.closed = true;
    this.clearOrphanTimer(s);
    this.cancelAllPending(s, 'Session closed');
    s.queue.end();
    try { s.query.close(); } catch { /* ignore */ }
    this.sessions.delete(s.id);
    if (!quiet) {
      this.broadcast(s, { type: 'state', sessionId: s.id, state: this.runtimeState(s) });
      this.broadcast(s, { type: 'session.ended', sessionId: s.id, reason });
    }
    s.subs.clear();
  }

  closeAll() {
    for (const s of this.list()) this.close(s, 'server shutdown');
  }

  // ───────────── worktrees ─────────────
  /** Remove the worktree we created for `sessionId` (live or not). Never touches worktrees we did not create. */
  async removeSessionWorktree(sessionId: string, force: boolean): Promise<WorktreeRemoval | { removed: false; branchDeleted: false; reason: string }> {
    const rec = this.worktrees.get(sessionId);
    if (!rec) return { removed: false, branchDeleted: false, reason: 'session has no workstation-created worktree' };
    const live = this.sessions.get(sessionId);
    if (live) this.close(live, 'worktree removed');
    const res = await removeWorktree(rec, force);
    if (res.removed) this.worktrees.delete(sessionId);
    return res;
  }

  // ───────────── prompting ─────────────
  prompt(s: LiveSession, text: unknown, images: ImageAttachment[] | undefined, clientMsgId: string) {
    if (typeof text !== 'string') throw new Error('text must be a string');
    const imgs = Array.isArray(images) ? images : [];
    if (!text.trim() && imgs.length === 0) throw new Error('empty prompt');
    const blocks: Json[] = [];
    for (const im of imgs) {
      if (!im || !IMAGE_TYPES.has(im.mediaType) || typeof im.dataBase64 !== 'string' || im.dataBase64.length > 30_000_000) throw new Error('unsupported image attachment');
      blocks.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.dataBase64 } });
    }
    if (text) blocks.push({ type: 'text', text });
    const content = blocks.length === 1 && blocks[0]!.type === 'text' ? text : blocks;
    const uuid = randomUUID();
    const user = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: s.id, uuid } as unknown as SDKUserMessage;
    // Echo the user turn into the event stream: the SDK does not, and the UI needs the uuid for rewind.
    const echoContent = typeof content === 'string' ? content : (content as Json[]).map((b) => (b.type === 'image' ? { type: 'image', name: imgs.find((i) => i.dataBase64 === (b.source as Json).data)?.name } : b));
    this.emitSdk(s, { type: 'user', message: { role: 'user', content: echoContent }, parent_tool_use_id: null, session_id: s.id, uuid, clientMsgId, origin: 'workstation' });
    s.inflight.set(uuid, 'queued');
    if (!s.title) s.title = text.slice(0, 80);
    this.emitState(s);
    s.queue.push(user);
  }

  async interrupt(s: LiveSession) {
    this.cancelAllPending(s, 'Interrupted by user', true);
    await s.query.interrupt();
  }

  // ───────────── SDK stream ─────────────
  private emitSdk(s: LiveSession, message: unknown) {
    const seq = ++s.seq;
    message = capHugeToolResults(message);
    const m = message as { type?: string; parent_tool_use_id?: string | null };
    // Finished messages supersede their partial stream_events: drop those to keep replay small.
    if (m.type === 'assistant') {
      const parent = m.parent_tool_use_id ?? null;
      this.dropFromBuffer(s, (e) => { const b = e.message as typeof m; return b.type === 'stream_event' && (b.parent_tool_use_id ?? null) === parent; });
    } else if (m.type === 'result') {
      this.dropFromBuffer(s, (e) => (e.message as typeof m).type === 'stream_event');
    }
    let bytes = 256;
    try { bytes = JSON.stringify(message).length; } catch { /* keep estimate */ }
    s.buffer.push({ seq, message, bytes });
    s.bufferBytes += bytes;
    while (s.buffer.length > BUFFER_SIZE || (s.bufferBytes > BUFFER_BYTES && s.buffer.length > 0)) {
      const old = s.buffer.shift()!;
      s.bufferBytes -= old.bytes;
      s.evictedThrough = old.seq;
    }
    this.broadcast(s, { type: 'sdk', sessionId: s.id, seq, message });
  }

  private dropFromBuffer(s: LiveSession, pred: (e: BufferedEvent) => boolean) {
    const keep: BufferedEvent[] = [];
    for (const e of s.buffer) { if (pred(e)) s.bufferBytes -= e.bytes; else keep.push(e); }
    s.buffer = keep;
  }

  private emitError(s: LiveSession, message: string, code?: string) {
    this.broadcast(s, { type: 'error', sessionId: s.id, message, ...(code ? { code } : {}) });
  }

  private async consume(s: LiveSession) {
    let reason = 'process exited';
    try {
      for await (const raw of s.query) {
        if (s.closed) break;
        const msg = raw as {
          type?: string; subtype?: string; model?: string; permissionMode?: PermissionMode | null; command_uuid?: string; state?: string;
          error?: string; error_status?: number; attempt?: number; max_retries?: number; is_error?: boolean;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        if (msg.type === 'system' && msg.subtype === 'init') {
          if (msg.model) s.model = msg.model;
          if (msg.permissionMode) s.permissionMode = msg.permissionMode;
          s.init = { ...(msg as object), synthetic: false };
          this.emitSdk(s, msg);
          this.emitState(s, true);
          continue;
        }
        if (msg.type === 'system' && msg.subtype === 'status' && msg.permissionMode && msg.permissionMode !== s.permissionMode) {
          // The CLI changes mode on its own (ExitPlanMode approval, EnterPlanMode, setMode permission updates): follow it.
          s.permissionMode = msg.permissionMode;
          this.emitSdk(s, msg);
          this.emitState(s, true);
          continue;
        }
        if (msg.type === 'command_lifecycle') {
          s.lifecycle = true;
          if (msg.command_uuid && msg.state === 'started' && s.inflight.has(msg.command_uuid)) s.inflight.set(msg.command_uuid, 'started');
          if ((msg.state === 'completed' || msg.state === 'cancelled') && msg.command_uuid && s.inflight.delete(msg.command_uuid)) {
            this.emitSdk(s, msg);
            if (s.inflight.size === 0) s.autoTurn = false;
            this.emitState(s);
            continue;
          }
        }
        if (msg.type === 'stream_event' || msg.type === 'assistant') {
          if (s.inflight.size === 0 && !s.autoTurn) { s.autoTurn = true; this.emitState(s); }
        }
        if (msg.type === 'assistant' && typeof msg.error === 'string') {
          const text = (msg.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
          this.emitError(s, text || `API error: ${msg.error}`, msg.error);
        }
        if (msg.type === 'system' && msg.subtype === 'api_retry' && typeof msg.error === 'string' && FATAL_API_ERRORS.has(msg.error) && !s.fatalInterrupted) {
          // Retrying a 401/402/404-class error cannot succeed (the CLI would loop ~10 times with growing delays): stop the turn now.
          s.fatalInterrupted = true;
          this.emitError(s, `API error${msg.error_status ? ` ${msg.error_status}` : ''}: ${msg.error}. Check the provider settings (base URL, API key/token, model).`, msg.error);
          void s.query.interrupt().catch(() => {});
        }
        this.emitSdk(s, msg);
        if (msg.type === 'result') {
          s.fatalInterrupted = false;
          // The CLI may fold several queued prompts into one turn: every prompt that had started is done now.
          if (s.lifecycle) { for (const [id, st] of s.inflight) if (st === 'started') s.inflight.delete(id); }
          else { const first = s.inflight.keys().next(); if (!first.done) s.inflight.delete(first.value); }
          if (s.inflight.size === 0) s.autoTurn = false;
          this.emitState(s);
        }
      }
    } catch (e) {
      reason = `error: ${e instanceof Error ? e.message : String(e)}`;
      if (!s.closed) this.emitError(s, reason, 'process_exited');
    }
    if (!s.closed) this.close(s, reason);
  }

  // ───────────── permissions ─────────────
  private canUseTool(
    s: LiveSession, toolName: string, input: Json,
    o: { signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string; decisionReason?: string; title?: string; description?: string; toolUseID: string; agentID?: string },
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID();
      const request: Pending['request'] = {
        type: 'permission.request', sessionId: s.id, requestId, toolName, input, toolUseID: o.toolUseID,
        title: o.title, description: o.description, decisionReason: o.decisionReason, blockedPath: o.blockedPath,
        hasSuggestions: rememberable(o.suggestions).length > 0, agentID: o.agentID,
        ...(o.suggestions?.length ? { suggestions: o.suggestions } : {}),
      };
      const p: Pending = { requestId, toolName, input, suggestions: o.suggestions, toolUseID: o.toolUseID, request, resolve };
      s.pending.set(requestId, p);
      const onAbort = () => this.cancelPending(s, requestId, 'Cancelled');
      if (o.signal.aborted) { onAbort(); return; }
      o.signal.addEventListener('abort', onAbort, { once: true });
      this.broadcast(s, request);
      this.emitState(s);
      if (s.subs.size === 0) this.armOrphanTimer(s);
    });
  }

  respond(s: LiveSession, requestId: string, d: PermissionDecision) {
    const p = s.pending.get(requestId);
    if (!p) throw new Error(`no pending permission request ${requestId}`);
    if (!d || (d.behavior !== 'allow' && d.behavior !== 'deny')) throw new Error('invalid decision');
    s.pending.delete(requestId);
    if (d.behavior === 'allow') {
      const updatedInput = d.updatedInput && typeof d.updatedInput === 'object' ? d.updatedInput : p.input;
      const updates: PermissionUpdate[] = [];
      if (d.remember) {
        // Only rule/directory suggestions: the SDK also suggests `setMode acceptEdits`, which "always allow" must not trigger.
        for (const u of rememberable(p.suggestions)) {
          const upd = d.remember === 'session' ? { ...u, destination: 'session' as const } : u;
          updates.push(upd);
          if (upd.type === 'setMode') s.permissionMode = upd.mode;
          if (upd.type === 'addRules') for (const r of upd.rules) s.rules.push({ toolName: r.toolName, ...(r.ruleContent ? { ruleContent: r.ruleContent } : {}), behavior: upd.behavior, destination: upd.destination });
        }
      }
      if (d.setMode) {
        if (!MODES.has(d.setMode)) throw new Error('invalid permission mode');
        updates.push({ type: 'setMode', mode: d.setMode, destination: 'session' });
      }
      p.resolve({ behavior: 'allow', updatedInput, toolUseID: p.toolUseID, ...(updates.length ? { updatedPermissions: updates } : {}) });
      if (d.setMode) s.permissionMode = d.setMode;
      if (updates.some((u) => u.type === 'addRules' || u.type === 'setMode')) this.emitState(s, true);
    } else {
      p.resolve({ behavior: 'deny', message: d.message || 'The user denied this action.', interrupt: !!d.interrupt, toolUseID: p.toolUseID });
    }
    this.emitState(s);
  }

  private cancelPending(s: LiveSession, requestId: string, message: string, interrupt = false) {
    const p = s.pending.get(requestId);
    if (!p) return;
    s.pending.delete(requestId);
    p.resolve({ behavior: 'deny', message, interrupt, toolUseID: p.toolUseID });
    this.broadcast(s, { type: 'permission.cancelled', sessionId: s.id, requestId });
    if (!s.closed) this.emitState(s);
  }

  private cancelAllPending(s: LiveSession, message: string, interrupt = false) {
    for (const id of [...s.pending.keys()]) this.cancelPending(s, id, message, interrupt);
  }
}

/**
 * What "always allow" applies from the SDK's suggestions: rules and directories; the `setMode acceptEdits` suggestion
 * only when it is the sole way to remember (file edits), so that remembering a Bash rule never flips the session mode.
 */
function rememberable(suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] {
  const all = suggestions ?? [];
  const hasRule = all.some((u) => u.type === 'addRules');
  return all.filter((u) => u.type === 'addRules' || u.type === 'addDirectories' || (u.type === 'setMode' && !hasRule));
}

/** Cut gigantic tool_result text before it is buffered/forwarded (the model has already seen the full output). */
function capHugeToolResults(message: unknown): unknown {
  const m = message as { type?: string; message?: { content?: unknown } };
  if (m?.type !== 'user' || !Array.isArray(m.message?.content)) return message;
  let changed = false;
  const cut = (t: string) => { changed = true; return `${t.slice(0, MAX_FORWARDED_TEXT)}\n\n[... ${t.length - MAX_FORWARDED_TEXT} more characters omitted by The Workstation]`; };
  const content = (m.message!.content as Array<Record<string, unknown>>).map((b) => {
    if (b?.type !== 'tool_result') return b;
    if (typeof b.content === 'string' && b.content.length > MAX_FORWARDED_TEXT) return { ...b, content: cut(b.content) };
    if (Array.isArray(b.content)) {
      return { ...b, content: (b.content as Array<Record<string, unknown>>).map((c) => (c?.type === 'text' && typeof c.text === 'string' && c.text.length > MAX_FORWARDED_TEXT ? { ...c, text: cut(c.text) } : c)) };
    }
    return b;
  });
  return changed ? { ...m, message: { ...m.message, content } } : message;
}
