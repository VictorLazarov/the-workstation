import { create } from 'zustand';
import type {
  AppConfig, ClientMessage, ContextUsage, EffortLevel, ImageAttachment, ModelOption, PermissionDecision, PermissionMode,
  ServerMessage, SessionRuntimeState, SessionSummary, SlashCommandInfo,
} from '@workstation/protocol';
import { api } from '../lib/api';
import {
  addLocalUser, addNotice, applySdk, emptyConversation, finishStreaming, foldMessages, markUserFailed,
} from '../lib/reducer';
import type { Conversation, ImageRef, PermissionRequest } from '../lib/types';
import { createTransport, type ConnStatus, type Transport } from '../lib/transport';
import { basename, truncate, uid } from '../lib/utils';
import { isDemo, ls } from '../lib/storage';
import { applyTheme, useUi } from './ui';
import { platform } from '../platform';

export interface QueuedPrompt { id: string; text: string; images: ImageAttachment[] }

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
  interrupt: (id: string) => void;
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
    useUi.getState().toast({ kind, title, body: `${s ? truncate(s.title, 40) + ': ' : ''}${body}`, action: { label: 'Open', run: () => get().setActive(id) }, ttl: kind === 'attention' ? 10_000 : 5000 });
    if (document.hidden) platform.notify({ title, body: s?.title ?? body, tag: id, onClick: () => get().setActive(id) });
  };

  const sendNow = (id: string, text: string, images: ImageAttachment[], qid = uid('c')) => {
    const s = get().sessions[id];
    if (!s) return;
    const refs: ImageRef[] = images.map((i) => ({ mediaType: i.mediaType, dataBase64: i.dataBase64, name: i.name }));
    const ok = transport?.send({ type: 'prompt', sessionId: id, text, images: images.length ? images : undefined, clientMsgId: qid }) ?? false;
    if (!ok) { useUi.getState().toast({ kind: 'error', title: 'Not connected', body: 'Your message was not sent. Reconnecting…' }); return; }
    const conv = addLocalUser(s.conv, qid, text, refs);
    patch(id, (x) => ({
      conv, runtime: { ...x.runtime, status: 'running' }, turnStartedAt: Date.now(), failed: false, lastActivity: Date.now(),
      title: x.title === 'New session' ? titleFrom(text) : x.title,
    }));
  };

  const flushQueue = (id: string) => {
    const s = get().sessions[id];
    if (!s || !s.live || s.runtime.status !== 'idle' || !s.queue.length || s.perms.length) return;
    const [next, ...rest] = s.queue;
    patch(id, () => ({ queue: rest }));
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
    if (!ok) { pendingStarts.delete(reqId); toast({ kind: 'error', title: 'Not connected', body: 'Could not start the session.' }); return; }
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
          patch(lid, (s) => ({ starting: false, failed: true, runtime: { ...s.runtime, status: 'idle' }, conv: addNotice(s.conv, 'error', m.message) }));
        } else if (m.sessionId && get().sessions[m.sessionId]) {
          patch(m.sessionId, (s) => ({ conv: addNotice(finishStreaming(s.conv), 'error', m.message), failed: true, runtime: { ...s.runtime, status: s.runtime.status === 'closed' ? 'closed' : 'idle' } }));
        }
        if (!w) toast({ kind: 'error', title: 'Server error', body: m.message });
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
          const isErr = msg.subtype !== 'success' || !!msg.is_error;
          const interrupted = isErr && (msg.errors ?? []).some((e) => /interrupt|abort/i.test(String(e)));
          const unread = get().activeId !== m.sessionId || document.hidden;
          patch(m.sessionId, () => ({ conv, failed: isErr && !interrupted, unread: unread && !interrupted, lastActivity: Date.now() }));
          if (!interrupted) notifyUser(m.sessionId, isErr ? 'Session hit an error' : 'Session finished', isErr ? truncate(msg.result || msg.errors?.[0] || 'Error', 80) : 'Ready for your review', isErr ? 'attention' : 'success');
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
        patch(m.sessionId, (s) => ({ perms: s.perms.filter((p) => p.requestId !== m.requestId) }));
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
    set({ ready: true });
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
    conn: 'connecting', ready: false, config: null, models: [], commands: [], sessions: {}, summaries: [], summariesLoading: false,
    activeId: null, projects: [],

    async init() {
      if (initStarted) return;
      initStarted = true;
      transport = await createTransport();
      transport.onStatus((conn) => {
        const was = get().conn;
        set({ conn });
        if (conn === 'closed' && was === 'open') {
          // streaming state is stale until we re-attach
          for (const s of Object.values(get().sessions)) if (s.live) patch(s.id, (x) => ({ conv: finishStreaming(x.conv) }));
        }
      });
      transport.onMessage(onServer);
      transport.connect();
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

    interrupt(id) {
      transport?.send({ type: 'interrupt', sessionId: id });
      patch(id, (s) => ({ queue: [], conv: finishStreaming(s.conv) }));
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

    reconnectNow() { transport?.connect(); },
  };
});

/* selectors / helpers */
export const useActiveSession = () => useSessions((s) => (s.activeId ? s.sessions[s.activeId] : undefined));
export const projectName = (cwd: string) => basename(cwd) || cwd;

declare global { interface Window { __ws?: { simulateDrop?: (ms?: number) => void } } }
