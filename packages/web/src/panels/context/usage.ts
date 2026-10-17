import type { ContextUsage, ContextUsageCategory } from '@workstation/protocol';

/** Swatch key per row; CSS maps each to a colour (`.cx-<key>`). The SDK's own `color` values are CLI theme names, so unused. */
export type SwatchKey = 'messages' | 'tools' | 'mcp' | 'prompt' | 'skills' | 'mcpi' | 'buffer' | 'free' | 'deferred' | 'other';

export function swatchFor(c: Pick<ContextUsageCategory, 'name' | 'kind'>): SwatchKey {
  if (c.kind === 'free') return 'free';
  if (c.kind === 'buffer') return 'buffer';
  if (c.kind === 'deferred') return 'deferred';
  const n = c.name.toLowerCase();
  if (n.startsWith('messages')) return 'messages';
  if (n.startsWith('system prompt')) return 'prompt';
  if (n.startsWith('system tools')) return 'tools';
  if (n.startsWith('mcp server instructions') || n.startsWith('mcp instructions')) return 'mcpi';
  if (n.startsWith('mcp tools')) return 'mcp';
  if (n.startsWith('skills')) return 'skills';
  return 'other';
}

export interface UsageRow { key: string; name: string; tokens: number; /** share of the full window, 0..100 */ pct: number; swatch: SwatchKey; kind: ContextUsageCategory['kind']; expandable?: boolean }
export interface UsageView {
  used: number; max: number; pct: number;
  /** rows that occupy the window (SDK order), then buffer, then free */
  rows: UsageRow[];
  /** out-of-window tool schemas (not counted in `used`) */
  deferred: UsageRow[];
  /** segments of the stacked bar (used + buffer; free is the bar's background) */
  bar: UsageRow[];
  /** tokens added since the previous snapshot, when there was one */
  since: number | null;
}

/** Shapes a `ContextUsage` snapshot into display rows. `prevTotal` is the previous snapshot's `totalTokens`. */
export function usageView(u: ContextUsage, prevTotal?: number): UsageView {
  const max = u.maxTokens || u.rawMaxTokens || 1;
  const toRow = (c: ContextUsageCategory, i: number): UsageRow => ({
    key: `${i}:${c.name}`, name: c.name, tokens: c.tokens, pct: (c.tokens / max) * 100, swatch: swatchFor(c), kind: c.kind,
    expandable: c.kind === 'used' && /^mcp tools/i.test(c.name) && u.mcpTools.length > 0,
  });
  const all = u.categories.map(toRow);
  const used = all.filter((r) => r.kind === 'used' && r.tokens > 0);
  const buffer = all.filter((r) => r.kind === 'buffer');
  const free = all.filter((r) => r.kind === 'free');
  const deferred = all.filter((r) => r.kind === 'deferred' && r.tokens > 0);
  const since = prevTotal !== undefined && u.totalTokens !== prevTotal ? u.totalTokens - prevTotal : null;
  return {
    used: u.totalTokens, max, pct: Math.min(100, Math.max(0, u.percentage ?? (u.totalTokens / max) * 100)),
    rows: [...used, ...(since !== null && since > 0 ? [{ key: 'since', name: 'Since last update', tokens: since, pct: (since / max) * 100, swatch: 'other' as SwatchKey, kind: 'used' as const }] : []), ...buffer, ...free],
    deferred, bar: [...used, ...buffer], since,
  };
}

/** "22% used", "<1% used" (never "0%" while tokens exist). */
export function pctLabel(pct: number, used: number): string {
  if (!used) return '0%';
  if (pct < 1) return '<1%';
  return `${pct < 10 ? pct.toFixed(1).replace(/\.0$/, '') : Math.round(pct)}%`;
}

export function tone(pct: number): '' | 'warm' | 'hot' { return pct >= 85 ? 'hot' : pct >= 65 ? 'warm' : ''; }
