import type { ContextUsage, ContextUsageCategory } from '@workstation/protocol';

type Raw = Record<string, unknown>;
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const KINDS = new Set(['used', 'free', 'buffer', 'deferred']);

/**
 * Reduce the SDK's `SDKControlGetContextUsageResponse` to the wire `ContextUsage`: drops `gridRows` (hundreds of
 * per-square objects only the CLI's own /context grid needs) and anything we do not render, and tolerates fields that
 * older/newer CLI versions omit.
 */
export function normalizeContextUsage(raw: unknown, detail: 'summary' | 'full', source: 'sdk' | 'mock' = 'sdk'): ContextUsage {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  const categories: ContextUsageCategory[] = (Array.isArray(r.categories) ? (r.categories as Raw[]) : []).map((c) => {
    const name = String(c.name ?? '');
    const kind = KINDS.has(String(c.kind)) ? (c.kind as ContextUsageCategory['kind'])
      : /free space/i.test(name) ? 'free' : /buffer/i.test(name) ? 'buffer' : c.isDeferred ? 'deferred' : 'used';
    return { name, tokens: num(c.tokens), color: String(c.color ?? ''), kind, ...(c.isDeferred ? { isDeferred: true } : {}) };
  });
  const mb = r.messageBreakdown as Raw | undefined;
  const au = r.apiUsage as Raw | null | undefined;
  const max = num(r.maxTokens);
  const total = num(r.totalTokens);
  return {
    source, detail,
    model: String(r.model ?? ''),
    categories,
    totalTokens: total,
    maxTokens: max,
    rawMaxTokens: num(r.rawMaxTokens, max),
    percentage: num(r.percentage, max ? (total / max) * 100 : 0),
    mcpTools: (Array.isArray(r.mcpTools) ? (r.mcpTools as Raw[]) : []).map((t) => ({
      name: String(t.name ?? ''), serverName: String(t.serverName ?? ''), tokens: num(t.tokens), ...(t.isLoaded !== undefined ? { isLoaded: !!t.isLoaded } : {}),
    })),
    isAutoCompactEnabled: !!r.isAutoCompactEnabled,
    ...(r.autoCompactThreshold !== undefined ? { autoCompactThreshold: num(r.autoCompactThreshold) } : {}),
    ...(mb ? { messageBreakdown: {
      toolCallTokens: num(mb.toolCallTokens), toolResultTokens: num(mb.toolResultTokens), attachmentTokens: num(mb.attachmentTokens),
      assistantMessageTokens: num(mb.assistantMessageTokens), userMessageTokens: num(mb.userMessageTokens),
      redirectedContextTokens: num(mb.redirectedContextTokens), unattributedTokens: num(mb.unattributedTokens),
    } } : {}),
    apiUsage: au ? {
      input_tokens: num(au.input_tokens), output_tokens: num(au.output_tokens),
      cache_creation_input_tokens: num(au.cache_creation_input_tokens), cache_read_input_tokens: num(au.cache_read_input_tokens),
    } : null,
    at: Date.now(),
  };
}
