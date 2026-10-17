import { describe, expect, it } from 'vitest';
import type { ContextUsage } from '@workstation/protocol';
import { pctLabel, swatchFor, tone, usageView } from './usage';

const u = (over: Partial<ContextUsage> = {}): ContextUsage => ({
  source: 'sdk', detail: 'full', model: 'm', totalTokens: 44_000, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 22, isAutoCompactEnabled: true, apiUsage: null, at: 0,
  mcpTools: [{ name: 'mcp__a__b', serverName: 'a', tokens: 100 }],
  categories: [
    { name: 'Messages', tokens: 20_000, color: '', kind: 'used' }, { name: 'MCP tools', tokens: 100, color: '', kind: 'used' },
    { name: 'Skills', tokens: 0, color: '', kind: 'used' }, { name: 'System tools (deferred)', tokens: 5000, color: '', kind: 'deferred' },
    { name: 'Autocompact buffer', tokens: 33_000, color: '', kind: 'buffer' }, { name: 'Free space', tokens: 120_000, color: '', kind: 'free' },
  ], ...over,
});

describe('usageView', () => {
  it('orders used, buffer, free; splits deferred; computes window shares', () => {
    const v = usageView(u());
    expect(v.rows.map((r) => r.name)).toEqual(['Messages', 'MCP tools', 'Autocompact buffer', 'Free space']);
    expect(v.rows[0].pct).toBeCloseTo(10);
    expect(v.rows[1].expandable).toBe(true);
    expect(v.deferred.map((r) => r.name)).toEqual(['System tools (deferred)']);
    expect(v.bar.map((r) => r.swatch)).toEqual(['messages', 'mcp', 'buffer']);
    expect(v.since).toBeNull();
  });
  it('adds a "Since last update" row only when tokens grew', () => {
    expect(usageView(u(), 40_000).rows.some((r) => r.name === 'Since last update' && r.tokens === 4000)).toBe(true);
    expect(usageView(u(), 50_000).rows.some((r) => r.name === 'Since last update')).toBe(false);
  });
});
describe('helpers', () => {
  it('labels and tones', () => {
    expect(pctLabel(0.4, 100)).toBe('<1%'); expect(pctLabel(22.4, 5)).toBe('22%'); expect(pctLabel(0, 0)).toBe('0%');
    expect(tone(90)).toBe('hot'); expect(tone(70)).toBe('warm'); expect(tone(10)).toBe('');
    expect(swatchFor({ name: 'System prompt', kind: 'used' })).toBe('prompt');
  });
});
