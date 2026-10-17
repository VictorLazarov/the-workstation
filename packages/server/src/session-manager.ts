import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Options, PermissionResult, PermissionUpdate, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  ClientMessage, EffortLevel, ImageAttachment, PermissionDecision, PermissionMode, ServerMessage, SessionId, SessionRuntimeState,
} from '@workstation/protocol';
import type { ConfigStore } from './config.js';
import { HttpError, requireDir } from './files.js';
import { createWorktree } from './git.js';
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

interface BufferedEvent { seq: number; message: unknown }

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
  outstanding: number;
  autoTurn: boolean;
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
const MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export class SessionManager {
  private sessions = new Map<SessionId, LiveSession>();

  constructor(private adapter: SdkAdapter, private config: ConfigStore, private serverCwd: string) {}

  get(id: string): LiveSession | undefined { return this.sessions.get(id); }
  isLive(id: string): boolean { return this.sessions.has(id); }
  list(): LiveSession[] { return [...this.sessions.values()]; }

  runtimeState(s: LiveSession): SessionRuntimeState {
    return { status: s.closed ? 'closed' : this.status(s), model: s.model, permissionMode: s.permissionMode, effort: s.effort };
  }
  private status(s: LiveSession): SessionRuntimeState['status'] {
    if (s.pending.size > 0) return 'waiting_permission';
    return s.outstanding > 0 || s.autoTurn ? 'running' : 'idle';
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
      worktree = await createWorktree(cwd, id.slice(0, 8));
      cwd = worktree.path;
    }
    const permissionMode = msg.permissionMode ?? app.defaultPermissionMode ?? 'default';
    const model = msg.model ?? app.defaultModel;
    const effort = msg.effort ?? app.defaultEffort;

    const queue = new PromptQueue();
    const abort = new AbortController();
    const s: LiveSession = {
      id, cwd, worktree, queue, subs: new Set(), buffer: [], seq: 0, evictedThrough: 0, pending: new Map(), outstanding: 0, autoTurn: false,
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
      if (s.closed) throw new Error('session failed to start');
      // keep going: the process may still come up; surface the problem
      sub.send({ type: 'error', reqId: msg.reqId, sessionId: id, message: `Claude Code did not initialize: ${e instanceof Error ? e.message : e}` });
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
    for (const s of this.sessions.values()) s.subs.delete(sub);
  }

  close(s: LiveSession, reason: string) {
    if (s.closed) return;
    s.closed = true;
    this.cancelAllPending(s, 'Session closed');
    s.queue.end();
    try { s.query.close(); } catch { /* ignore */ }
    this.sessions.delete(s.id);
    this.broadcast(s, { type: 'state', sessionId: s.id, state: this.runtimeState(s) });
    this.broadcast(s, { type: 'session.ended', sessionId: s.id, reason });
    s.subs.clear();
  }

  closeAll() {
    for (const s of this.list()) this.close(s, 'server shutdown');
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
    s.outstanding++;
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
    const m = message as { type?: string; parent_tool_use_id?: string | null };
    // Finished messages supersede their partial stream_events: drop those to keep replay small.
    if (m.type === 'assistant') {
      const parent = m.parent_tool_use_id ?? null;
      s.buffer = s.buffer.filter((e) => { const b = e.message as typeof m; return !(b.type === 'stream_event' && (b.parent_tool_use_id ?? null) === parent); });
    } else if (m.type === 'result') {
      s.buffer = s.buffer.filter((e) => (e.message as typeof m).type !== 'stream_event');
    }
    s.buffer.push({ seq, message });
    while (s.buffer.length > BUFFER_SIZE) s.evictedThrough = s.buffer.shift()!.seq;
    this.broadcast(s, { type: 'sdk', sessionId: s.id, seq, message });
  }

  private async consume(s: LiveSession) {
    let reason = 'process exited';
    try {
      for await (const raw of s.query) {
        if (s.closed) break;
        const msg = raw as { type?: string; subtype?: string; model?: string; permissionMode?: PermissionMode };
        if (msg.type === 'system' && msg.subtype === 'init') {
          if (msg.model) s.model = msg.model;
          if (msg.permissionMode) s.permissionMode = msg.permissionMode;
          s.init = { ...(msg as object), synthetic: false };
          this.emitSdk(s, msg);
          this.emitState(s, true);
          continue;
        }
        if (msg.type === 'stream_event' || msg.type === 'assistant') {
          if (s.outstanding === 0 && !s.autoTurn) { s.autoTurn = true; this.emitState(s); }
        }
        this.emitSdk(s, msg);
        if (msg.type === 'result') {
          if (s.outstanding > 0) s.outstanding--;
          s.autoTurn = false;
          this.emitState(s);
        }
      }
    } catch (e) {
      reason = `error: ${e instanceof Error ? e.message : String(e)}`;
      if (!s.closed) this.broadcast(s, { type: 'error', sessionId: s.id, message: reason });
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
        hasSuggestions: !!o.suggestions?.length, agentID: o.agentID,
      };
      const p: Pending = { requestId, toolName, input, suggestions: o.suggestions, toolUseID: o.toolUseID, request, resolve };
      s.pending.set(requestId, p);
      const onAbort = () => this.cancelPending(s, requestId, 'Cancelled');
      if (o.signal.aborted) { onAbort(); return; }
      o.signal.addEventListener('abort', onAbort, { once: true });
      this.broadcast(s, request);
      this.emitState(s);
    });
  }

  respond(s: LiveSession, requestId: string, d: PermissionDecision) {
    const p = s.pending.get(requestId);
    if (!p) throw new Error(`no pending permission request ${requestId}`);
    if (!d || (d.behavior !== 'allow' && d.behavior !== 'deny')) throw new Error('invalid decision');
    s.pending.delete(requestId);
    if (d.behavior === 'allow') {
      const updatedInput = d.updatedInput && typeof d.updatedInput === 'object' ? d.updatedInput : p.input;
      p.resolve({
        behavior: 'allow', updatedInput, toolUseID: p.toolUseID,
        ...(d.remember && p.suggestions?.length ? { updatedPermissions: p.suggestions } : {}),
      });
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
