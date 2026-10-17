/**
 * Pure fold of raw SDK messages into a renderable Conversation.
 * Handles: partial stream deltas -> final assistant message, tool_use/tool_result pairing,
 * subagent lanes (parent_tool_use_id), thinking, result/cost, API retries, tasks.
 */
import type {
  AssistantItem, Block, Conversation, ImageRef, Item, Lane, NoticeItem, ToolResult, ToolUseBlock, Todo, UserItem,
} from './types';
import { MAIN_LANE } from './types';

const emptyLane = (): Lane => ({ items: [], live: null });

export function emptyConversation(): Conversation {
  return {
    lanes: { [MAIN_LANE]: emptyLane() },
    toolResults: {}, toolProgress: {}, tasks: {}, retry: null, statusText: null,
    usage: { costUsd: 0, turns: 0, durationMs: 0 }, todos: null, plan: null, seq: 0,
  };
}

type AnyMsg = Record<string, any>;

function nid(c: Conversation, p: string): string {
  c.seq += 1;
  return `${p}${c.seq}`;
}
function laneOf(c: Conversation, key: string): Lane {
  return c.lanes[key] ?? emptyLane();
}
function setLane(c: Conversation, key: string, lane: Lane) {
  c.lanes = { ...c.lanes, [key]: lane };
}
function pushItem(c: Conversation, key: string, item: Item, live?: Lane['live']) {
  const lane = laneOf(c, key);
  setLane(c, key, { items: [...lane.items, item], live: live === undefined ? lane.live : live });
}
function replaceItem(c: Conversation, key: string, idx: number, item: Item, live?: Lane['live']) {
  const lane = laneOf(c, key);
  const items = lane.items.slice();
  items[idx] = item;
  setLane(c, key, { items, live: live === undefined ? lane.live : live });
}
function findAssistantIdx(lane: Lane, msgId: string | undefined, liveId?: string): number {
  for (let i = lane.items.length - 1; i >= 0; i--) {
    const it = lane.items[i];
    if (it.kind !== 'assistant') continue;
    if ((liveId && it.id === liveId) || (msgId && it.msgId === msgId)) return i;
  }
  return -1;
}

function observeTool(c: Conversation, b: ToolUseBlock, key: string) {
  if (b.name === 'TodoWrite' && key === MAIN_LANE && Array.isArray(b.input.todos)) {
    c.todos = (b.input.todos as any[]).map((t): Todo => ({
      content: String(t.content ?? ''), status: t.status ?? 'pending', activeForm: t.activeForm,
    }));
  }
  if (b.name === 'ExitPlanMode' && typeof b.input.plan === 'string') c.plan = b.input.plan as string;
}

function setContext(c: Conversation, usage: AnyMsg | undefined, key: string) {
  if (!usage || key !== MAIN_LANE) return;
  const n = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  if (n > 0) c.contextTokens = n;
}

function toBlock(b: AnyMsg): Block | null {
  switch (b?.type) {
    case 'text': return { type: 'text', text: String(b.text ?? ''), final: true };
    case 'thinking': return { type: 'thinking', text: String(b.thinking ?? ''), final: true };
    case 'redacted_thinking': return { type: 'thinking', text: '', redacted: true, final: true };
    case 'tool_use': case 'server_tool_use': case 'mcp_tool_use':
      return { type: 'tool_use', id: String(b.id), name: String(b.name ?? 'tool'), input: (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>, final: true };
    default: return null;
  }
}

/* ───────────── stream events ───────────── */
function onStream(c: Conversation, msg: AnyMsg) {
  const key: string = msg.parent_tool_use_id ?? MAIN_LANE;
  const ev = msg.event;
  if (!ev) return;
  c.retry = null;
  const lane = laneOf(c, key);

  const ensureLive = (): { idx: number; item: AssistantItem } => {
    const cur = lane.live ? findAssistantIdx(lane, undefined, lane.live.id) : -1;
    if (cur >= 0) return { idx: cur, item: lane.items[cur] as AssistantItem };
    const item: AssistantItem = { kind: 'assistant', id: nid(c, 'a'), msgId: '', blocks: [], ts: Date.now() };
    pushItem(c, key, item, { id: item.id, map: {} });
    const l2 = laneOf(c, key);
    return { idx: l2.items.length - 1, item };
  };

  switch (ev.type) {
    case 'message_start': {
      const m = ev.message ?? {};
      const item: AssistantItem = { kind: 'assistant', id: nid(c, 'a'), msgId: String(m.id ?? ''), blocks: [], ts: Date.now() };
      pushItem(c, key, item, { id: item.id, map: {} });
      setContext(c, m.usage, key);
      return;
    }
    case 'content_block_start': {
      const { idx, item } = ensureLive();
      const l = laneOf(c, key);
      const cb = ev.content_block ?? {};
      let blk: Block | null = null;
      if (cb.type === 'text') blk = { type: 'text', text: cb.text ?? '' };
      else if (cb.type === 'thinking') blk = { type: 'thinking', text: cb.thinking ?? '' };
      else if (cb.type === 'redacted_thinking') blk = { type: 'thinking', text: '', redacted: true };
      else if (cb.type === 'tool_use' || cb.type === 'server_tool_use' || cb.type === 'mcp_tool_use')
        blk = { type: 'tool_use', id: String(cb.id), name: String(cb.name ?? 'tool'), input: {}, partialJson: '' };
      const map = { ...(l.live?.map ?? {}) };
      let blocks = item.blocks;
      if (blk) { map[ev.index] = blocks.length; blocks = [...blocks, blk]; }
      replaceItem(c, key, idx, { ...item, blocks }, { id: item.id, map });
      return;
    }
    case 'content_block_delta': {
      if (!lane.live) return;
      const idx = findAssistantIdx(lane, undefined, lane.live.id);
      if (idx < 0) return;
      const item = lane.items[idx] as AssistantItem;
      const bi = lane.live.map[ev.index];
      const b = item.blocks[bi];
      if (!b) return;
      const d = ev.delta ?? {};
      let nb: Block = b;
      if (d.type === 'text_delta' && b.type === 'text') nb = { ...b, text: b.text + (d.text ?? '') };
      else if (d.type === 'thinking_delta' && b.type === 'thinking') nb = { ...b, text: b.text + (d.thinking ?? '') };
      else if (d.type === 'input_json_delta' && b.type === 'tool_use') nb = { ...b, partialJson: (b.partialJson ?? '') + (d.partial_json ?? '') };
      else return;
      const blocks = item.blocks.slice();
      blocks[bi] = nb;
      replaceItem(c, key, idx, { ...item, blocks });
      return;
    }
    case 'content_block_stop': {
      if (!lane.live) return;
      const idx = findAssistantIdx(lane, undefined, lane.live.id);
      if (idx < 0) return;
      const item = lane.items[idx] as AssistantItem;
      const bi = lane.live.map[ev.index];
      const b = item.blocks[bi];
      if (!b || b.type !== 'tool_use' || !b.partialJson) return;
      try {
        const input = JSON.parse(b.partialJson);
        const nb: ToolUseBlock = { ...b, input, partialJson: undefined };
        const blocks = item.blocks.slice();
        blocks[bi] = nb;
        replaceItem(c, key, idx, { ...item, blocks });
        observeTool(c, nb, key);
      } catch { /* wait for the final assistant message */ }
      return;
    }
    case 'message_delta':
      setContext(c, ev.usage && { ...ev.usage, input_tokens: ev.usage.input_tokens }, key);
      return;
    case 'message_stop':
      setLane(c, key, { ...laneOf(c, key), live: null });
      return;
  }
}

/* ───────────── final assistant message ───────────── */
function onAssistant(c: Conversation, msg: AnyMsg) {
  const key: string = msg.parent_tool_use_id ?? MAIN_LANE;
  const m = msg.message ?? {};
  c.retry = null;
  setContext(c, m.usage, key);
  const incoming = (Array.isArray(m.content) ? m.content : []).map(toBlock).filter(Boolean) as Block[];
  const lane = laneOf(c, key);
  const idx = findAssistantIdx(lane, m.id);
  const errText = msg.error ? String(msg.error) : undefined;

  if (idx < 0) {
    if (incoming.length === 0 && !errText) return;
    const item: AssistantItem = { kind: 'assistant', id: nid(c, 'a'), msgId: String(m.id ?? msg.uuid ?? nid(c, 'm')), blocks: incoming, error: errText, ts: Date.now() };
    pushItem(c, key, item);
    incoming.forEach((b) => b.type === 'tool_use' && observeTool(c, b, key));
    return;
  }
  const item = lane.items[idx] as AssistantItem;
  const blocks = item.blocks.slice();
  for (const b of incoming) {
    if (b.type === 'tool_use') {
      const at = blocks.findIndex((x) => x.type === 'tool_use' && x.id === b.id);
      if (at >= 0) blocks[at] = b; else blocks.push(b);
      observeTool(c, b, key);
    } else {
      const at = blocks.findIndex((x) => x.type === b.type && !x.final);
      if (at >= 0) blocks[at] = b;
      else if (!blocks.some((x) => x.type === b.type && x.final && 'text' in x && x.text === b.text)) blocks.push(b);
    }
  }
  replaceItem(c, key, idx, { ...item, blocks, error: errText ?? item.error });
}

/* ───────────── user message (history replay, echo, tool results) ───────────── */
function resultText(content: unknown): { text: string; images: ImageRef[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  const images: ImageRef[] = [];
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const p of content) {
      if (p?.type === 'text') parts.push(String(p.text ?? ''));
      else if (p?.type === 'image' && p.source?.data) images.push({ mediaType: p.source.media_type ?? 'image/png', dataBase64: p.source.data });
    }
  }
  return { text: parts.join('\n'), images };
}

const SYS_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function onUser(c: Conversation, msg: AnyMsg) {
  const key: string = msg.parent_tool_use_id ?? MAIN_LANE;
  const content = msg.message?.content;
  const blocks: AnyMsg[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const toolResults = blocks.filter((b) => b?.type === 'tool_result');
  if (toolResults.length) {
    const next = { ...c.toolResults };
    for (const tr of toolResults) {
      const { text, images } = resultText(tr.content);
      const r: ToolResult = { content: text, isError: !!tr.is_error, images, raw: toolResults.length === 1 ? msg.tool_use_result : undefined };
      next[String(tr.tool_use_id)] = r;
    }
    c.toolResults = next;
  }
  if (key !== MAIN_LANE || msg.isSynthetic) return;
  const texts = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? ''));
  const images: ImageRef[] = blocks
    .filter((b) => b?.type === 'image' && b.source?.data)
    .map((b) => ({ mediaType: b.source.media_type ?? 'image/png', dataBase64: b.source.data }));
  let text = texts.join('\n').replace(SYS_REMINDER, '').trim();
  if (!text && !images.length) return;

  const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
  if (out) { pushItem(c, MAIN_LANE, { kind: 'notice', id: nid(c, 'n'), level: 'info', text: out[1].trim(), ts: Date.now() }); return; }
  if (/<local-command-caveat>/.test(text)) return;
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
    text = `${cmd[1].trim()} ${args}`.trim();
  }
  if (/^\[Request interrupted by user/.test(text)) {
    pushItem(c, MAIN_LANE, { kind: 'notice', id: nid(c, 'n'), level: 'info', text: 'Interrupted by user', ts: Date.now() });
    return;
  }
  const lane = laneOf(c, MAIN_LANE);
  const uuid: string | undefined = msg.uuid;
  if (uuid && lane.items.some((i) => i.kind === 'user' && i.uuid === uuid)) return;
  const cid: string | undefined = msg.clientMsgId;
  for (let i = lane.items.length - 1; i >= 0 && i >= lane.items.length - 6; i--) {
    const it = lane.items[i];
    if (it.kind === 'user' && it.pending && ((cid && it.id === cid) || it.text === text)) {
      replaceItem(c, MAIN_LANE, i, { ...it, pending: false, uuid });
      return;
    }
  }
  pushItem(c, MAIN_LANE, { kind: 'user', id: nid(c, 'u'), text, images, uuid, ts: Date.now() });
}

function onResult(c: Conversation, msg: AnyMsg) {
  const lane = laneOf(c, MAIN_LANE);
  const total = Number(msg.total_cost_usd ?? 0);
  const turnCost = Math.max(0, total - c.usage.costUsd);
  const ok = msg.subtype === 'success' && !msg.is_error;
  const item = {
    kind: 'result' as const, id: nid(c, 'r'), ok, subtype: String(msg.subtype ?? ''),
    text: typeof msg.result === 'string' ? msg.result : undefined,
    errors: Array.isArray(msg.errors) ? msg.errors.map(String) : undefined,
    costUsd: total, turnCostUsd: turnCost, durationMs: Number(msg.duration_ms ?? 0), turns: Number(msg.num_turns ?? 0), ts: Date.now(),
  };
  c.usage = { costUsd: total || c.usage.costUsd, turns: c.usage.turns + 1, durationMs: c.usage.durationMs + item.durationMs };
  c.retry = null;
  c.statusText = null;
  for (const k of Object.keys(c.lanes)) if (c.lanes[k].live) setLane(c, k, { ...c.lanes[k], live: null });
  pushItem(c, MAIN_LANE, item, null);
  void lane;
}

function onSystem(c: Conversation, msg: AnyMsg) {
  switch (msg.subtype) {
    case 'init':
      c.init = {
        model: msg.model, cwd: msg.cwd, tools: msg.tools ?? [], slashCommands: msg.slash_commands ?? [],
        skills: msg.skills ?? [], agents: msg.agents ?? [], mcpServers: (msg.mcp_servers ?? []).map((s: AnyMsg) => ({ name: s.name, status: s.status })),
        permissionMode: msg.permissionMode, version: msg.claude_code_version,
      };
      return;
    case 'api_retry':
      c.retry = {
        attempt: msg.attempt, max: msg.max_retries, delayMs: msg.retry_delay_ms, status: msg.error_status ?? null,
        message: String(msg.error ?? 'API error'), at: Date.now(),
      };
      return;
    case 'compact_boundary':
      pushItem(c, MAIN_LANE, { kind: 'notice', id: nid(c, 'n'), level: 'info', text: 'Conversation compacted to free up context', ts: Date.now() });
      c.statusText = null;
      return;
    case 'status':
      c.statusText = msg.status ? String(msg.status) : null;
      return;
    case 'local_command_output':
      if (msg.content) pushItem(c, MAIN_LANE, { kind: 'notice', id: nid(c, 'n'), level: 'info', text: String(msg.content), ts: Date.now() });
      return;
    case 'task_started': {
      const id = String(msg.tool_use_id ?? msg.task_id);
      c.tasks = { ...c.tasks, [id]: { taskId: msg.task_id, toolUseId: msg.tool_use_id, description: msg.description ?? '', subagentType: msg.subagent_type, status: 'running' } };
      return;
    }
    case 'task_progress': {
      const id = String(msg.tool_use_id ?? msg.task_id);
      const prev = c.tasks[id];
      c.tasks = { ...c.tasks, [id]: {
        ...(prev ?? { taskId: msg.task_id, description: '', status: 'running' as const }),
        description: msg.description ?? prev?.description ?? '', lastToolName: msg.last_tool_name, summary: msg.summary ?? prev?.summary,
        totalTokens: msg.usage?.total_tokens, toolUses: msg.usage?.tool_uses, durationMs: msg.usage?.duration_ms,
      } };
      return;
    }
    case 'task_notification': {
      const id = String(msg.tool_use_id ?? msg.task_id);
      const prev = c.tasks[id];
      c.tasks = { ...c.tasks, [id]: {
        ...(prev ?? { taskId: msg.task_id, description: '' }), status: msg.status, summary: msg.summary,
        totalTokens: msg.usage?.total_tokens ?? prev?.totalTokens, toolUses: msg.usage?.tool_uses ?? prev?.toolUses,
        durationMs: msg.usage?.duration_ms ?? prev?.durationMs,
      } as any };
      return;
    }
  }
}

export function applySdk(prev: Conversation, msg: unknown): Conversation {
  if (!msg || typeof msg !== 'object') return prev;
  const m = msg as AnyMsg;
  const c: Conversation = { ...prev };
  switch (m.type) {
    case 'stream_event': onStream(c, m); break;
    case 'assistant': onAssistant(c, m); break;
    case 'user': onUser(c, m); break;
    case 'result': onResult(c, m); break;
    case 'system': onSystem(c, m); break;
    case 'tool_progress':
      c.toolProgress = { ...c.toolProgress, [String(m.tool_use_id)]: Number(m.elapsed_time_seconds ?? 0) };
      break;
    default: return prev;
  }
  return c;
}

export function foldMessages(msgs: unknown[], from: Conversation = emptyConversation()): Conversation {
  return msgs.reduce<Conversation>((c, m) => applySdk(c, m), from);
}

/** Optimistic local user message (confirmed when the SDK echoes it back). */
export function addLocalUser(prev: Conversation, id: string, text: string, images: ImageRef[] = []): Conversation {
  const c = { ...prev };
  const item: UserItem = { kind: 'user', id, text, images, pending: true, ts: Date.now() };
  pushItem(c, MAIN_LANE, item);
  return c;
}

export function addNotice(prev: Conversation, level: NoticeItem['level'], text: string): Conversation {
  const c = { ...prev };
  pushItem(c, MAIN_LANE, { kind: 'notice', id: nid(c, 'n'), level, text, ts: Date.now() });
  return c;
}

/** Stop any in-flight streaming state (interrupt / session end / disconnect). */
export function finishStreaming(prev: Conversation): Conversation {
  const c = { ...prev, retry: null, statusText: null };
  for (const k of Object.keys(c.lanes)) if (c.lanes[k].live) setLane(c, k, { ...c.lanes[k], live: null });
  return c;
}

/** Remove the trailing pending user item (e.g. send failed). */
export function markUserFailed(prev: Conversation, id: string): Conversation {
  const c = { ...prev };
  const lane = laneOf(c, MAIN_LANE);
  const i = lane.items.findIndex((x) => x.id === id);
  if (i >= 0 && lane.items[i].kind === 'user') replaceItem(c, MAIN_LANE, i, { ...(lane.items[i] as UserItem), pending: false, failed: true });
  return c;
}

/* ───────────── derived helpers ───────────── */
export interface FileEdit { toolUseId: string; tool: string; path: string; added: number; removed: number }

export function hasToolUse(c: Conversation, toolUseId: string): boolean {
  for (const lane of Object.values(c.lanes))
    for (const it of lane.items)
      if (it.kind === 'assistant' && it.blocks.some((b) => b.type === 'tool_use' && b.id === toolUseId)) return true;
  return false;
}

export function allToolUses(c: Conversation): ToolUseBlock[] {
  const out: ToolUseBlock[] = [];
  for (const lane of Object.values(c.lanes))
    for (const it of lane.items) if (it.kind === 'assistant') for (const b of it.blocks) if (b.type === 'tool_use') out.push(b);
  return out;
}

export function lastItem(c: Conversation): Item | undefined {
  const items = c.lanes[MAIN_LANE]?.items;
  return items?.[items.length - 1];
}
