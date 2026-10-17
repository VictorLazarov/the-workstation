import { MAIN_LANE, type Conversation } from '../../lib/types';

export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.6);

export interface Category { id: 'system' | 'user' | 'assistant' | 'calls' | 'results' | 'thinking'; label: string; tokens: number }
export interface ContextBreakdown {
  used: number;
  window: number;
  pct: number;
  free: number;
  categories: Category[];
  /** the per-category split is heuristic (chars/3.6), only `used` is measured */
  estimated: true;
}

/** Share of the used context attributed to system prompt + tool definitions when the transcript alone over-explains it. */
const SYSTEM_FLOOR = 0.15;

/**
 * Split the measured context size (`conv.contextTokens`) into categories. Transcript categories are estimated from text
 * length; "System prompt & tools" is the remainder (floor 15% of used, scaling the others down when they over-explain).
 */
export function deriveContext(conv: Conversation, window: number): ContextBreakdown {
  const used = conv.contextTokens ?? 0;
  const lane = conv.lanes[MAIN_LANE];
  const raw = { user: 0, assistant: 0, calls: 0, results: 0, thinking: 0 };
  for (const it of lane?.items ?? []) {
    if (it.kind === 'user') raw.user += estimateTokens(it.text);
    else if (it.kind === 'assistant') {
      for (const b of it.blocks) {
        if (b.type === 'text') raw.assistant += estimateTokens(b.text);
        else if (b.type === 'thinking') raw.thinking += estimateTokens(b.text);
        else {
          raw.calls += estimateTokens(b.name + JSON.stringify(b.input ?? {}));
          const r = conv.toolResults[b.id];
          if (r) raw.results += estimateTokens(r.content) + r.images.length * 1500;
        }
      }
    }
  }
  const sum = raw.user + raw.assistant + raw.calls + raw.results + raw.thinking;
  let scale = 1;
  let system = Math.max(0, used - sum);
  if (used > 0 && system < used * SYSTEM_FLOOR) { system = used * SYSTEM_FLOOR; scale = (used - system) / (sum || 1); }
  if (used === 0) { system = 0; scale = 0; }
  const r = (n: number) => Math.round(n * scale);
  const categories: Category[] = [
    { id: 'system', label: 'System prompt & tools', tokens: Math.round(system) },
    { id: 'user', label: 'Your messages', tokens: r(raw.user) },
    { id: 'assistant', label: 'Claude responses', tokens: r(raw.assistant) },
    { id: 'thinking', label: 'Thinking', tokens: r(raw.thinking) },
    { id: 'calls', label: 'Tool calls', tokens: r(raw.calls) },
    { id: 'results', label: 'Tool results', tokens: r(raw.results) },
  ].filter((c) => c.tokens > 0) as Category[];
  return { used, window, pct: window ? Math.min(100, (used / window) * 100) : 0, free: Math.max(0, window - used), categories, estimated: true };
}

/** Cost per finished turn (main lane `result` items), most recent last. */
export function turnCosts(conv: Conversation, limit = 16): number[] {
  const out: number[] = [];
  for (const it of conv.lanes[MAIN_LANE]?.items ?? []) if (it.kind === 'result') out.push(it.turnCostUsd);
  return out.slice(-limit);
}

export function groupTools(tools: string[]): { builtin: string[]; mcp: Record<string, string[]> } {
  const builtin: string[] = [];
  const mcp: Record<string, string[]> = {};
  for (const t of tools) {
    const m = /^mcp__(.+?)__(.+)$/.exec(t);
    if (m) (mcp[m[1]] ??= []).push(m[2]); else builtin.push(t);
  }
  return { builtin, mcp };
}

export const mcpEnabled = (status: string) => status !== 'disabled';
export function mcpTone(status: string): 'ok' | 'warn' | 'err' | 'off' {
  switch (status) {
    case 'connected': return 'ok';
    case 'pending': case 'needs-auth': return 'warn';
    case 'failed': return 'err';
    default: return 'off';
  }
}
