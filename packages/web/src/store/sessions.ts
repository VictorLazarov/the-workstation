import { create } from 'zustand';
import type {
  AppConfig, ClientMessage, ContextUsage, EffortLevel, ImageAttachment, ModelOption, PermissionDecision, PermissionMode,
  ServerMessage, SessionRuntimeState, SessionSummary, SlashCommandInfo,
} from '@workstation/protocol';
import { api } from '../lib/api';
import {
  addLocalUser, addNotice, applySdk, applyServer, emptyConversation, finishStreaming, foldMessages, lastItem, markInterruptRequested,
} from '../lib/reducer';
import type { Conversation, ImageRef, PermissionRequest } from '../lib/types';
import { createTransport, type ConnStatus, type Transport } from '../lib/transport';
import { basename, truncate, uid } from '../lib/utils';
import { clearFailed, failMessage, hasFailed, markAllFailed, nextSendable, type QueuedPrompt } from '../lib/queue';
import { getServerBase, getToken, isDemo, ls } from '../lib/storage';
import { probeAccess } from '../lib/access';
import { applyTheme, useUi } from './ui';
import { platform } from '../platform';

export type { QueuedPrompt };

/** Whether this browser may talk to the server: `missing`/`invalid` token are terminal states with their own screen. */
export type Access = 'checking' | 'ok' | 'missing' | 'invalid';

export interface SessionData {
  id: string;
  cwd: string;
  title: string;
  branch?: string;
  conv: Conversation;
  runtime: SessionRuntimeState;
  /** attached to a running server-side query */
  live: boolean;
  starting: boolean;
  loading: boolean;
  perms: PermissionRequest[];
  outcomes: Record<string, 'allowed' | 'denied'>;
  queue: QueuedPrompt[];
  unread: boolean;
  lastActivity: number;
  turnStartedAt?: number;
  failed?: boolean;
  isDraft?: boolean;
  worktree?: boolean;
}

export type SessionStatus = 'running' | 'needs-input' | 'error' | 'done' | 'idle' | 'starting';

export function sessionStatus(s: Pick<SessionData, 'perms' | 'runtime' | 'failed' | 'unread' | 'starting'>): SessionStatus {
  if (s.perms.length) return 'needs-input';
  if (s.starting || s.runtime.status === 'starting') return 'starting';
  if (s.runtime.status === 'running') return 'running';
  if (s.failed) return 'error';
  if (s.unread) return 'done';
  return 'idle';
}

interface Store {
  conn: ConnStatus;
  access: Access;
  ready: boolean;
  hello?: { version: string; serverCwd: string; mock: boolean };
  config: AppConfig | null;
  configError?: string;
  models: ModelOption[];
  commands: SlashCommandInfo[];
  sessions: Record<string, SessionData>;
  summaries: SessionSummary[];
  summariesLoading: boolean;
  activeId: string | null;
  projects: string[];

  init: () => Promise<void>;
  refreshSummaries: () => Promise<void>;
  loadConfig: () => Promise<void>;
  saveConfig: (patch: Partial<AppConfig>) => Promise<boolean>;
  addProject: (cwd: string) => void;
  newSession: (cwd: string, opts?: { worktree?: boolean }) => string;
  openSession: (idOrSummary: string | SessionSummary) => void;
  setActive: (id: string | null) => void;
  send: (id: string, text: string, images?: ImageAttachment[]) => void;
  cancelQueued: (id: string, qid: string) => void;
  /** Re-send queued messages that failed to reach the server (offline / session ended). */
  retryQueued: (id: string) => void;
  interrupt: (id: string) => void;
  /** Re-send the last prompt (the Retry action of an error banner). */
  retryLast: (id: string) => void;
  respondPermission: (id: string, requestId: string, decision: PermissionDecision) => void;
  setModel: (id: string, model?: string) => void;
  setMode: (id: string, mode: PermissionMode) => void;
  setEffort: (id: string, effort: EffortLevel) => void;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  forkSession: (id: string) => void;
  closeSession: (id: string) => void;
  rewind: (id: string, userMessageId: string, dryRun: boolean) => Promise<unknown>;
  /** Real context-window breakdown from the live SDK query (rejects when the session is not live). */
  contextUsage: (id: string, detail?: 'summary' | 'full') => Promise<ContextUsage>;
  stopTask: (id: string, taskId: string) => Promise<void>;
  mcpToggle: (id: string, server: string, enabled: boolean) => void;
  mcpReconnect: (id: string, server: string) => void;
  reconnectNow: () => void;
  /** Re-checks the access token against /api/health (Retry on the access screen). */
  recheckAccess: () => Promise<void>;
}

let transport: Transport | null = null;
let initStarted = false;
const pendingStarts = new Map<string, string>(); // reqId -> local session id
const waiters = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const lastSeq = new Map<string, number>(); // last sdk seq applied per session (for attach replay)
const histBuffer = new Map<string, unknown[]>(); // sdk events arriving while history loads

const freshRuntime = (cfg: AppConfig | null): SessionRuntimeState => ({
  status: 'idle', model: cfg?.defaultModel, effort: cfg?.defaultEffort, permissionMode: cfg?.defaultPermissionMode ?? 'default',
});

function makeSession(id: string, cwd: string, patch: Partial<SessionData> = {}): SessionData {
  return {
    id, cwd, title: 'New session', conv: emptyConversation(), runtime: { status: 'idle', permissionMode: 'default' }, live: false,
    starting: false, loading: false, perms: [], outcomes: {}, queue: [], unread: false, lastActivity: Date.now(), ...patch,
  };
}

function request(msg: ClientMessage & { reqId: string }, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(msg.reqId); reject(new Error('Request timed out')); }, timeoutMs);
    waiters.set(msg.reqId, { resolve, reject, timer });
    if (!transport?.send(msg)) { clearTimeout(timer); waiters.delete(msg.reqId); reject(new Error('Not connected to the server')); }
  });
}

function titleFrom(text: string) { return truncate(text.replace(/\s+/g, ' ').trim(), 60) || 'New session'; }

export const useSessions = create<Store>((set, get) => {
  const patch = (id: string, fn: (s: SessionData) => Partial<SessionData>) => {
    const s = get().sessions[id];
    if (!s) return;
    set({ sessions: { ...get().sessions, [id]: { ...s, ...fn(s) } } });
  };
  const toast = useUi.getState().toast;

  const notifyUser = (id: string, title: string, body: string, kind: 'attention' | 'success') => {
    const s = get().sessions[id];
    const isActive = get().activeId === id && !document.hidden;
    if (isActive) return;
    useUi.getState().toast({ kind, tag: id, title, body: `${s ? truncate(s.title, 40) + ': ' : ''}${body}`, action: { label: 'Open', run: () => get().setActive(id) }, });
    if (document.hidden) platform.notify({ title, body: s?.title ?? body, tag: id, onClick: () => get().setActive(id) });
  };

  const sendNow = (id: string, text: string, images: ImageAttachment[], qid = uid('c')) => {
    const s = get().sessions[id];
    if (!s) return;
    const refs: ImageRef[] = images.map((i) => ({ mediaType: i.mediaType, dataBase64: i.dataBase64, name: i.name }));
    const ok = transport?.send({ type: 'prompt', sessionId: id, text, images: images.length ? images : undefined, clientMsgId: qid }) ?? false;
    if (!ok) {
      // Not lost: it goes (back) to the queue marked as not sent; reconnecting re-sends it, and it has a Retry button.
      patch(id, (x) => ({ queue: failMessage(x.queue, { id: qid, text, images }) }));
      useUi.getState().toast({ kind: 'error', title: 'Not connected', body: 'Your message was not sent. It will be sent when the connection is back, or retry it from the queue.' });
      return;
    }
    const conv = addLocalUser(s.conv, qid, text, refs);
    patch(id, (x) => ({
      conv, runtime: { ...x.runtime, status: 'running' }, turnStartedAt: Date.now(), failed: false, lastActivity: Date.now(),
      title: x.title === 'New session' ? titleFrom(text) : x.title,
    }));
  };

  const flushQueue = (id: string) => {
    const s = get().sessions[id];
    if (!s || !s.live || s.runtime.status !== 'idle' || s.perms.length) return;
    const next = nextSendable(s.queue);
    if (!next) return;
    patch(id, () => ({ queue: s.queue.filter((q) => q.id !== next.id) }));
    sendNow(id, next.text, next.images, next.id);
  };

  const startServerSession = (localId: string, opts: { resume?: string; fork?: boolean } = {}) => {
    const s = get().sessions[localId];
    if (!s) return;
    const reqId = uid('req');
    pendingStarts.set(reqId, localId);
    const cfg = get().config;
    const ok = transport?.send({
      type: 'session.start', reqId, cwd: s.cwd, resume: opts.resume, fork: opts.fork,
      model: s.runtime.model ?? cfg?.defaultModel, effort: s.runtime.effort ?? cfg?.defaultEffort,
      permissionMode: s.runtime.permissionMode, worktree: s.worktree || undefined,
    });
    if (!ok) {
      pendingStarts.delete(reqId);
      patch(localId, (x) => ({ queue: markAllFailed(x.queue) }));
      toast({ kind: 'error', title: 'Not connected', body: 'Could not start the session. Your message is kept; it is sent when the connection is back.' });
      return;
    }
    patch(localId, () => ({ starting: true, runtime: { ...s.runtime, status: 'starting' } }));
  };

  const loadHistory = async (id: string, cwd: string, attach: boolean) => {
    histBuffer.set(id, []);
    patch(id, () => ({ loading: true }));
    try {
      const { messages } = await api.messages(id, cwd);
      const cur = get().sessions[id];
      if (!cur) return;
      let conv = foldMessages(messages ?? [], emptyConversation());
      const buffered = histBuffer.get(id) ?? [];
      for (const m of buffered) conv = applySdk(conv, m);
      if (cur.conv.init) conv = { ...conv, init: cur.conv.init };
      patch(id, () => ({ conv, loading: false }));
    } catch (e) {
      patch(id, () => ({ loading: false }));
      if (!attach) toast({ kind: 'error', title: 'Could not load session', body: (e as Error).message });
    } finally {
      histBuffer.delete(id);
    }
  };

  const onServer = (m: ServerMessage) => {
    switch (m.type) {
      case 'hello':
        set({ hello: { version: m.version, serverCwd: m.serverCwd, mock: m.mock } });
        void onOpen();
        return;
      case 'ack': {
        if (m.reqId.startsWith('mcp:')) {
          // server pushes the fresh MCP status list after mcp.toggle / mcp.reconnect
          const list = (m.data as { mcpServers?: { name: string; status: string; error?: string }[] } | undefined)?.mcpServers;
          const sid = m.reqId.slice(4);
          if (list) patch(sid, (s) => (s.conv.init ? { conv: { ...s.conv, init: { ...s.conv.init, mcpServers: list.map((x) => ({ name: x.name, status: x.status, error: x.error })) } } } : {}));
          return;
        }
        const w = waiters.get(m.reqId);
        if (w) { clearTimeout(w.timer); waiters.delete(m.reqId); w.resolve(m.data); }
        return;
      }
      case 'error': {
        const w = m.reqId ? waiters.get(m.reqId) : undefined;
        if (w) { clearTimeout(w.timer); waiters.delete(m.reqId!); w.reject(new Error(m.message)); }
        if (m.reqId && pendingStarts.has(m.reqId)) {
          const lid = pendingStarts.get(m.reqId)!;
          pendingStarts.delete(m.reqId);
          patch(lid, (s) => ({ starting: false, failed: true, runtime: { ...s.runtime, status: 'idle' }, queue: markAllFailed(s.queue), conv: addNotice(s.conv, 'error', m.message) }));
        } else if (m.sessionId && get().sessions[m.sessionId]) {
          // a turn failure: one actionable notice (Settings for provider/model problems, Retry otherwise); the result that follows is not shown again
          patch(m.sessionId, (s) => ({ conv: applyServer(s.conv, m), failed: true, runtime: { ...s.runtime, status: s.runtime.status === 'closed' ? 'closed' : 'idle' } }));
        }
        // a session error is already in the conversation (with its action); only errors with no session context need a toast
        if (!w && !(m.sessionId && get().sessions[m.sessionId])) toast({ kind: 'error', title: 'Server error', body: m.message });
        return;
      }
      case 'session.started': {
        const lid = pendingStarts.get(m.reqId) ?? (get().sessions[m.sessionId] ? m.sessionId : undefined);
        pendingStarts.delete(m.reqId);
        const w = waiters.get(m.reqId);
        if (w) { clearTimeout(w.timer); waiters.delete(m.reqId); w.resolve(m); }
        const sessions = { ...get().sessions };
        let base = lid ? sessions[lid] : undefined;
        if (lid && lid !== m.sessionId) { delete sessions[lid]; }
        if (!base) base = makeSession(m.sessionId, m.cwd);
        const conv = applySdk(base.conv, m.init);
        const draftKey = lid && lid !== m.sessionId ? lid : null;
        sessions[m.sessionId] = {
          ...base, id: m.sessionId, cwd: m.cwd || base.cwd, conv, live: true, starting: false, failed: false, isDraft: false,
          runtime: { ...base.runtime, status: base.runtime.status === 'starting' ? 'idle' : base.runtime.status, model: base.runtime.model ?? (m.init as { model?: string })?.model },
        };
        set({ sessions, activeId: get().activeId === lid ? m.sessionId : get().activeId });
        if (draftKey) { const d = ls.get('ws.draft.' + draftKey); if (d) { ls.set('ws.draft.' + m.sessionId, d); ls.del('ws.draft.' + draftKey); } }
        flushQueue(m.sessionId);
        void get().refreshSummaries();
        return;
      }
      case 'session.ended':
        patch(m.sessionId, (s) => ({
          live: false, starting: false, runtime: { ...s.runtime, status: 'idle' }, perms: [],
          // nothing will flush a queue on a dead session: mark it not sent (re-sent when the session can start again)
          queue: markAllFailed(s.queue),
          conv: addNotice(finishStreaming(s.conv), m.reason === 'closed' || m.reason === 'user' ? 'info' : 'warn', `Session ended${m.reason ? ` (${m.reason})` : ''}`),
        }));
        return;
      case 'sdk': {
        const s = get().sessions[m.sessionId];
        if (!s) return;
        lastSeq.set(m.sessionId, Math.max(lastSeq.get(m.sessionId) ?? 0, m.seq));
        if (histBuffer.has(m.sessionId)) { histBuffer.get(m.sessionId)!.push(m.message); return; }
        const msg = m.message as { type?: string; subtype?: string; is_error?: boolean; result?: string; errors?: string[] };
        const conv = applySdk(s.conv, m.message);
        if (msg?.type === 'result') {
          // The outcome comes from structural signals decided in the reducer (see resultOutcome), never from error text.
          const done = lastItem(conv);
          const outcome = done?.kind === 'result' ? done.outcome : 'error';
          const stopped = outcome === 'stopped';
          const isErr = outcome === 'error' || outcome === 'reported';
          const unread = get().activeId !== m.sessionId || document.hidden;
          patch(m.sessionId, () => ({ conv, failed: isErr, unread: unread && !stopped, lastActivity: Date.now() }));
          if (!stopped) {
            const why = done?.kind === 'result' ? (done.message ?? s.conv.turnError ?? 'Error') : 'Error';
            notifyUser(m.sessionId, isErr ? 'Session hit an error' : 'Session finished', isErr ? truncate(s.conv.turnError ?? why, 80) : 'Ready for your review', isErr ? 'attention' : 'success');
          }
          void get().refreshSummaries();
        } else if (conv !== s.conv) {
          patch(m.sessionId, () => ({ conv, lastActivity: Date.now() }));
        }
        return;
      }
      case 'permission.request': {
        const s = get().sessions[m.sessionId];
        if (!s) return;
        const req: PermissionRequest = {
          requestId: m.requestId, toolName: m.toolName, input: m.input, toolUseID: m.toolUseID, title: m.title, description: m.description,
          decisionReason: m.decisionReason, blockedPath: m.blockedPath, hasSuggestions: m.hasSuggestions, agentID: m.agentID, at: Date.now(),
        };
        patch(m.sessionId, (x) => ({ perms: [...x.perms.filter((p) => p.requestId !== req.requestId), req], runtime: { ...x.runtime, status: 'waiting_permission' } }));
        notifyUser(m.sessionId, m.toolName === 'AskUserQuestion' ? 'Claude has a question' : m.toolName === 'ExitPlanMode' ? 'Plan ready for review' : 'Approval needed', m.title || `${m.toolName} wants to run`, 'attention');
        return;
      }
      case 'permission.cancelled':
        // The server cancels pending prompts when the turn is interrupted (from this tab or another): the error result that follows is a stop.
        patch(m.sessionId, (s) => ({ perms: s.perms.filter((p) => p.requestId !== m.requestId), conv: applyServer(s.conv, m) }));
        return;
      case 'state': {
        const s = get().sessions[m.sessionId];
        if (!s) return;
        patch(m.sessionId, (x) => ({
          runtime: m.state,
          turnStartedAt: m.state.status === 'running' && x.runtime.status !== 'running' ? Date.now() : x.turnStartedAt,
          conv: m.state.status === 'idle' || m.state.status === 'closed' ? finishStreaming(x.conv) : x.conv,
        }));
        if (m.state.status === 'idle') flushQueue(m.sessionId);
        return;
      }
      case 'pong': return;
    }
  };

  async function onOpen() {
    await Promise.all([get().loadConfig(), api.models().then((models) => set({ models })).catch(() => {}), api.commands(get().hello?.serverCwd).then((commands) => set({ commands })).catch(() => {})]);
    await get().refreshSummaries();
    // Re-attach sessions we already know about; auto-attach live ones from other tabs/earlier visits.
    for (const s of Object.values(get().sessions)) {
      if (s.live && !s.isDraft) void reattach(s.id);
    }
    for (const sum of get().summaries) {
      if (sum.live && !get().sessions[sum.sessionId]) {
        set({ sessions: { ...get().sessions, [sum.sessionId]: makeSession(sum.sessionId, sum.cwd ?? '', { title: sum.title, branch: sum.gitBranch, lastActivity: sum.lastModified, live: true, runtime: { status: 'idle', permissionMode: 'default' } }) } });
        void reattach(sum.sessionId, true);
      }
    }
    set({ ready: true, access: 'ok' });
    // Reload / reopen: go back to the session that was open (only when nothing else was opened meanwhile).
    const last = ls.get('ws.activeId');
    if (last && !get().activeId && !isDemo()) {
      const sum = get().summaries.find((x) => x.sessionId === last);
      if (sum) get().openSession(sum);
    }
    // After an outage: what was queued while offline is sent now, and git status (which failed meanwhile) is re-read.
    for (const s of Object.values(get().sessions)) if (hasFailed(s.queue)) get().retryQueued(s.id);
    window.dispatchEvent(new Event('ws:reconnected'));
  }

  async function reattach(id: string, withHistory = false) {
    const s = get().sessions[id];
    if (!s) return;
    if (withHistory) void loadHistory(id, s.cwd, true); else histBuffer.delete(id);
    const reqId = uid('req');
    pendingStarts.set(reqId, id);
    if (!transport?.send({ type: 'session.attach', reqId, sessionId: id, ...(lastSeq.has(id) ? { fromSeq: lastSeq.get(id) } : {}) })) pendingStarts.delete(reqId);
  }

  return {
    conn: 'connecting', access: 'checking', ready: false, config: null, models: [], commands: [], sessions: {}, summaries: [], summariesLoading: false,
    activeId: null, projects: [],

    async init() {
      if (initStarted) return;
      initStarted = true;
      if (!isDemo() && !getToken()) {
        // No token: nothing is sent to the server at all; the UI shows the access screen.
        set({ access: 'missing', conn: 'closed' });
        return;
      }
      if (isDemo()) set({ access: 'ok' });
      transport = await createTransport();
      transport.onStatus((conn) => {
        const was = get().conn;
        set({ conn });
        if ((conn === 'closed' || conn === 'offline') && was === 'open') {
          // streaming state is stale until we re-attach
          for (const s of Object.values(get().sessions)) if (s.live) patch(s.id, (x) => ({ conv: finishStreaming(x.conv) }));
        }
        // A refused WebSocket upgrade looks like any network error: ask /api/health whether the token is the problem.
        if ((conn === 'closed' || conn === 'offline') && !isDemo()) void get().recheckAccess();
      });
      useSessions.subscribe((st, prev) => {
        if (st.activeId === prev.activeId) return;
        if (st.activeId && !st.activeId.startsWith('new_')) ls.set('ws.activeId', st.activeId); else if (!st.activeId) ls.del('ws.activeId');
      });
      transport.onMessage(onServer);
      transport.connect();
      if (!isDemo()) void get().recheckAccess();
      if (isDemo()) {
        // open the rich demo session so the first paint is meaningful
        const rich = 'demo-rich';
        setTimeout(() => get().openSession(rich), 450);
      }
      window.addEventListener('beforeunload', () => transport?.close());
    },

    async loadConfig() {
      try {
        const config = await api.getConfig();
        const projects = [...new Set([...(config.recentProjects ?? [])])];
        set({ config, projects, configError: undefined });
        if (config.theme && !ls.get('ws.theme')) { useUi.getState().setTheme(config.theme); }
        applyTheme(useUi.getState().theme);
      } catch (e) {
        set({ configError: (e as Error).message });
      }
    },

    async saveConfig(p) {
      try {
        const config = await api.putConfig(p);
        set({ config, projects: config.recentProjects ?? get().projects });
        return true;
      } catch (e) {
        toast({ kind: 'error', title: 'Could not save settings', body: (e as Error).message });
        return false;
      }
    },

    async refreshSummaries() {
      const cwds = new Set<string>([...get().projects]);
      const sv = get().hello?.serverCwd;
      if (sv) cwds.add(sv);
      for (const s of Object.values(get().sessions)) if (s.cwd) cwds.add(s.cwd);
      const lists = await Promise.all([...cwds].map((c) => api.sessions(c).catch(() => [] as SessionSummary[])));
      const seen = new Map<string, SessionSummary>();
      for (const l of lists) for (const s of Array.isArray(l) ? l : []) seen.set(s.sessionId, { ...s, cwd: s.cwd ?? [...cwds][lists.indexOf(l)] });
      set({ summaries: [...seen.values()] });
    },

    addProject(cwd) {
      const projects = [cwd, ...get().projects.filter((p) => p !== cwd)].slice(0, 20);
      set({ projects });
      void get().saveConfig({ recentProjects: projects });
      void get().refreshSummaries();
    },

    newSession(cwd, opts) {
      const id = uid('new_');
      get().addProject(cwd);
      const cfg = get().config;
      set({
        sessions: { ...get().sessions, [id]: makeSession(id, cwd, { isDraft: true, runtime: freshRuntime(cfg), worktree: opts?.worktree }) },
        activeId: id,
      });
      api.gitStatus(cwd).then((g) => g?.branch && patch(id, () => ({ branch: g.branch })), () => {});
      return id;
    },

    openSession(arg) {
      const sum = typeof arg === 'string' ? get().summaries.find((s) => s.sessionId === arg) ?? { sessionId: arg, title: 'Session', cwd: get().projects[0] ?? '', lastModified: Date.now(), live: false } : arg;
      const id = sum.sessionId;
      const existing = get().sessions[id];
      if (existing) { get().setActive(id); return; }
      const cfg = get().config;
      set({
        sessions: { ...get().sessions, [id]: makeSession(id, sum.cwd ?? '', { title: sum.title, branch: sum.gitBranch, lastActivity: sum.lastModified, live: false, runtime: freshRuntime(cfg) }) },
        activeId: id,
      });
      void loadHistory(id, sum.cwd ?? '', false);
      if (sum.live) {
        patch(id, () => ({ live: true }));
        void reattach(id);
      }
    },

    setActive(id) {
      set({ activeId: id });
      if (id) useUi.getState().dismissToastsByTag(id); // its "needs you" / "finished" toast is now moot
      if (id && get().sessions[id]?.unread) patch(id, () => ({ unread: false }));
    },

    send(id, text, images = []) {
      const s = get().sessions[id];
      if (!s || (!text.trim() && !images.length)) return;
      const q: QueuedPrompt = { id: uid('c'), text, images };
      if (s.live && s.runtime.status === 'idle' && !s.perms.length) { sendNow(id, text, images, q.id); return; }
      patch(id, (x) => ({ queue: [...x.queue, q] }));
      if (!s.live && !s.starting) {
        const resume = s.isDraft ? undefined : id;
        startServerSession(id, { resume });
      }
    },

    cancelQueued(id, qid) { patch(id, (s) => ({ queue: s.queue.filter((q) => q.id !== qid) })); },

    retryQueued(id) {
      const s = get().sessions[id];
      if (!s || !hasFailed(s.queue)) return;
      patch(id, (x) => ({ queue: clearFailed(x.queue) }));
      const cur = get().sessions[id]!;
      if (cur.live && cur.runtime.status === 'idle' && !cur.perms.length) flushQueue(id);
      else if (!cur.live && !cur.starting) startServerSession(id, { resume: cur.isDraft ? undefined : id });
    },

    interrupt(id) {
      transport?.send({ type: 'interrupt', sessionId: id });
      // remember that WE asked: the error result that follows is a stop (neutral marker, idle session), not a failure
      patch(id, (s) => ({ queue: [], conv: s.runtime.status === 'idle' ? finishStreaming(s.conv) : markInterruptRequested(s.conv) }));
    },

    retryLast(id) {
      const s = get().sessions[id];
      if (!s) return;
      const items = s.conv.lanes[''].items;
      for (let i = items.length - 1; i >= 0; i--) { const it = items[i]; if (it.kind === 'user' && it.text) { get().send(id, it.text); return; } }
    },

    respondPermission(id, requestId, decision) {
      const s = get().sessions[id];
      const req = s?.perms.find((p) => p.requestId === requestId);
      if (!s || !req) return;
      transport?.send({ type: 'permission.respond', sessionId: id, requestId, decision });
      const rest = s.perms.filter((p) => p.requestId !== requestId);
      patch(id, (x) => ({
        perms: rest, outcomes: { ...x.outcomes, [req.toolUseID]: decision.behavior === 'allow' ? 'allowed' : 'denied' },
        runtime: rest.length ? x.runtime : { ...x.runtime, status: 'running' },
      }));
    },

    setModel(id, model) {
      patch(id, (s) => ({ runtime: { ...s.runtime, model } }));
      if (get().sessions[id]?.live) transport?.send({ type: 'set.model', sessionId: id, model });
    },
    setMode(id, mode) {
      patch(id, (s) => ({ runtime: { ...s.runtime, permissionMode: mode } }));
      if (get().sessions[id]?.live) transport?.send({ type: 'set.permissionMode', sessionId: id, mode });
    },
    setEffort(id, effort) {
      patch(id, (s) => ({ runtime: { ...s.runtime, effort } }));
      if (get().sessions[id]?.live) transport?.send({ type: 'set.effort', sessionId: id, effort });
    },

    async renameSession(id, title) {
      const prev = get().sessions[id]?.title;
      patch(id, () => ({ title }));
      set({ summaries: get().summaries.map((s) => (s.sessionId === id ? { ...s, title } : s)) });
      if (get().sessions[id]?.isDraft) return;
      try { await api.renameSession(id, title); } catch (e) {
        if (prev) patch(id, () => ({ title: prev }));
        toast({ kind: 'error', title: 'Rename failed', body: (e as Error).message });
        void get().refreshSummaries();
      }
    },

    async deleteSession(id) {
      const s = get().sessions[id];
      if (s?.live) transport?.send({ type: 'session.close', sessionId: id });
      const { [id]: _drop, ...rest } = get().sessions;
      set({ sessions: rest, summaries: get().summaries.filter((x) => x.sessionId !== id), activeId: get().activeId === id ? null : get().activeId });
      if (s?.isDraft) return;
      try { await api.deleteSession(id); } catch (e) {
        toast({ kind: 'error', title: 'Delete failed', body: (e as Error).message });
        void get().refreshSummaries();
      }
    },

    forkSession(id) {
      const src = get().sessions[id] ?? get().summaries.find((s) => s.sessionId === id);
      if (!src) return;
      const cwd = src.cwd ?? '';
      const lid = uid('new_');
      const title = `${src.title} (fork)`;
      set({ sessions: { ...get().sessions, [lid]: makeSession(lid, cwd, { title, isDraft: true, conv: get().sessions[id]?.conv ?? emptyConversation(), runtime: freshRuntime(get().config) }) }, activeId: lid });
      startServerSession(lid, { resume: id, fork: true });
      if (!get().sessions[id]) void loadHistory(lid, cwd, false);
    },

    closeSession(id) {
      if (get().sessions[id]?.live) transport?.send({ type: 'session.close', sessionId: id });
      patch(id, () => ({ live: false }));
    },

    mcpToggle(id, server, enabled) {
      patch(id, (s) => (s.conv.init ? { conv: { ...s.conv, init: { ...s.conv.init, mcpServers: s.conv.init.mcpServers.map((x) => (x.name === server ? { ...x, status: enabled ? 'pending' : 'disabled' } : x)) } } } : {}));
      transport?.send({ type: 'mcp.toggle', sessionId: id, server, enabled });
    },
    mcpReconnect(id, server) {
      patch(id, (s) => (s.conv.init ? { conv: { ...s.conv, init: { ...s.conv.init, mcpServers: s.conv.init.mcpServers.map((x) => (x.name === server ? { ...x, status: 'pending', error: undefined } : x)) } } } : {}));
      transport?.send({ type: 'mcp.reconnect', sessionId: id, server });
    },
    async rewind(id, userMessageId, dryRun) {
      return request({ type: 'rewind', reqId: uid('req'), sessionId: id, userMessageId, dryRun });
    },

    async contextUsage(id, detail = 'full') {
      return (await request({ type: 'context.usage', reqId: uid('req'), sessionId: id, detail })) as ContextUsage;
    },
    async stopTask(id, taskId) {
      await request({ type: 'task.stop', reqId: uid('req'), sessionId: id, taskId });
    },

    reconnectNow() { void get().recheckAccess(); transport?.connect(); },

    async recheckAccess() {
      if (isDemo()) return;
      const r = await probeAccess();
      if (r === 'missing' || r === 'invalid') { transport?.close(); set({ access: r, conn: 'closed' }); }
      else if (r === 'ok' && get().access !== 'ok') { set({ access: 'ok' }); if (get().conn !== 'open') transport?.connect(); }
    },
  };
});

/* selectors / helpers */
export const useActiveSession = () => useSessions((s) => (s.activeId ? s.sessions[s.activeId] : undefined));
export const projectName = (cwd: string) => basename(cwd) || cwd;

declare global { interface Window { __ws?: { simulateDrop?: (ms?: number) => void } } }
