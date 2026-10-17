import { describe, expect, it } from 'vitest';
import { emptyConversation } from '../../lib/reducer';
import { deriveContext, groupTools, mcpTone, turnCosts } from './derive';

function conv(used?: number) {
  const c = emptyConversation();
  c.contextTokens = used;
  c.lanes[''] = { live: null, items: [
    { kind: 'user', id: 'u', text: 'x'.repeat(3600), images: [], ts: 1 },
    { kind: 'assistant', id: 'a', msgId: 'm', ts: 1, blocks: [{ type: 'text', text: 'y'.repeat(7200) }, { type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/a' }, final: true }] },
    { kind: 'result', id: 'r1', ok: true, outcome: 'ok', subtype: 'success', costUsd: 0.1, turnCostUsd: 0.1, durationMs: 1, turns: 1, ts: 1 },
    { kind: 'result', id: 'r2', ok: true, outcome: 'ok', subtype: 'success', costUsd: 0.3, turnCostUsd: 0.2, durationMs: 1, turns: 2, ts: 1 },
  ] };
  c.toolResults = { t: { content: 'z'.repeat(18000), isError: false, images: [] } };
  return c;
}

describe('deriveContext', () => {
  it('uses the remainder as system tokens and sums to used', () => {
    const d = deriveContext(conv(20000), 200000);
    expect(d.used).toBe(20000);
    expect(d.pct).toBeCloseTo(10);
    expect(d.free).toBe(180000);
    expect(d.categories.reduce((n, c) => n + c.tokens, 0)).toBeGreaterThanOrEqual(19990);
    expect(d.categories.reduce((n, c) => n + c.tokens, 0)).toBeLessThanOrEqual(20010);
    expect(d.categories.find((c) => c.id === 'results')!.tokens).toBe(5000);
    expect(d.categories[0].id).toBe('system');
  });
  it('scales down when the transcript over-explains the usage (e.g. after compaction)', () => {
    const d = deriveContext(conv(8000), 200000);
    const sys = d.categories.find((c) => c.id === 'system')!.tokens;
    expect(sys).toBe(1200);
    expect(d.categories.reduce((n, c) => n + c.tokens, 0)).toBeLessThanOrEqual(8005);
  });
  it('handles no usage yet', () => {
    const d = deriveContext(conv(undefined), 200000);
    expect(d).toMatchObject({ used: 0, pct: 0, categories: [] });
  });
});

describe('helpers', () => {
  it('turnCosts', () => { expect(turnCosts(conv(1))).toEqual([0.1, 0.2]); });
  it('groupTools', () => {
    expect(groupTools(['Read', 'mcp__gh__list_prs', 'mcp__gh__get', 'Bash'])).toEqual({ builtin: ['Read', 'Bash'], mcp: { gh: ['list_prs', 'get'] } });
  });
  it('mcpTone', () => { expect(mcpTone('connected')).toBe('ok'); expect(mcpTone('failed')).toBe('err'); expect(mcpTone('disabled')).toBe('off'); });
});
