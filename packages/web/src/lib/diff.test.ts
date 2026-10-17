import { describe, expect, it } from 'vitest';
import { collapseContext, diffLines, diffStats, fromStructuredPatch, parseUnified } from './diff';
import { formatCost, formatDuration, formatTokens, fuzzy, modelLabel, relativeTime, relPath, truncate } from './utils';

describe('diff', () => {
  it('computes line diff and stats', () => {
    const d = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
    expect(d.map((l) => l.t).join('')).toBe(' -+ +');
  });
  it('handles empty old (write) and empty new', () => {
    expect(diffStats(diffLines('', 'x\ny'))).toEqual({ added: 2, removed: 0 });
    expect(diffStats(diffLines('x\ny', ''))).toEqual({ added: 0, removed: 2 });
  });
  it('collapses long unchanged runs', () => {
    const old = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    const nw = old.replace('l15', 'CHANGED');
    const c = collapseContext(diffLines(old, nw), 2);
    expect(c.some((l) => l.t === '@')).toBe(true);
    expect(c.length).toBeLessThan(12);
  });
  it('reads structuredPatch and unified diffs', () => {
    const p = fromStructuredPatch([{ oldStart: 3, newStart: 3, lines: [' ctx', '-old', '+new'] }]);
    expect(p).toEqual([
      { t: ' ', text: 'ctx', oldNo: 3, newNo: 3 },
      { t: '-', text: 'old', oldNo: 4 },
      { t: '+', text: 'new', newNo: 4 },
    ]);
    const u = parseUnified('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c');
    expect(diffStats(u)).toEqual({ added: 1, removed: 1 });
  });
});

describe('utils', () => {
  it('relativeTime', () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe('now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m');
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3h');
    expect(relativeTime(now - 2 * 86400_000, now)).toBe('2d');
  });
  it('formatters', () => {
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(150000)).toBe('150k');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1.5)).toBe('$1.5');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
  it('paths and models', () => {
    expect(relPath('/w/p/src/a.ts', '/w/p')).toBe('src/a.ts');
    expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(modelLabel('claude-opus-4-1')).toBe('Opus 4.1');
  });
  it('fuzzy', () => {
    expect(fuzzy('abc', 'a_b_c')).toBeGreaterThan(0);
    expect(fuzzy('xyz', 'abc')).toBe(-1);
    expect(fuzzy('ses', 'new session')).toBeGreaterThan(fuzzy('ses', 'toggle sidebar element'));
  });
});
