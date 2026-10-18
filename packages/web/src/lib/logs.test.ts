import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@workstation/protocol';
import {
  CLIENT_CAP, DEFAULT_FILTERS, absoluteTime, ago, badgeLabel, countByLevel, entriesText, entryText, filterEntries, findFocusSeq, followAfterScroll, matches, mergeEntries,
  resolveScope, serverQuery, timeTitle, unseenErrors,
} from './logs';

let n = 0;
const e = (o: Partial<LogEntry> = {}): LogEntry => ({ seq: ++n, ts: 1_700_000_000_000 + n * 1000, level: 'info', source: 'server', message: `m${n}`, ...o });
const mk = () => [
  e({ level: 'error', source: 'sdk', sessionId: 'A', message: 'API error: authentication_failed', detail: { status: 401 } }),
  e({ level: 'warn', source: 'git', sessionId: 'B', message: 'commit failed' }),
  e({ level: 'info', source: 'session', sessionId: 'A', message: 'Session started' }),
  e({ level: 'debug', source: 'permission', sessionId: 'A', message: 'asked Bash' }),
  e({ level: 'info', source: 'http', message: 'WebSocket connected' }),
];

describe('filter logic', () => {
  it('level chips, source, session and text combine (AND)', () => {
    const l = mk();
    expect(filterEntries(l, { levels: ['error', 'warn'] }).map((x) => x.message)).toEqual(['API error: authentication_failed', 'commit failed']);
    expect(filterEntries(l, { levels: ['error', 'warn', 'info'], sessionId: 'A' }).map((x) => x.message)).toEqual(['API error: authentication_failed', 'Session started']);
    expect(filterEntries(l, { source: 'git' }).map((x) => x.message)).toEqual(['commit failed']);
    expect(filterEntries(l, { source: 'all' })).toHaveLength(5);
    expect(filterEntries(l, { q: 'WEBSOCKET' }).map((x) => x.message)).toEqual(['WebSocket connected']);
    expect(filterEntries(l, { q: '  401 ' }).map((x) => x.message)).toEqual(['API error: authentication_failed']); // detail is searched, input trimmed
    expect(filterEntries(l, { levels: [] })).toEqual([]); // no chip on = nothing shown
    expect(filterEntries(l, {})).toHaveLength(5);
  });

  it('matches() with no constraints keeps everything', () => { expect(matches(mk()[0]!, {})).toBe(true); });

  it('counts per level ignore the level filter but respect the others', () => {
    const l = mk();
    expect(countByLevel(l, {})).toEqual({ error: 1, warn: 1, info: 2, debug: 1 });
    expect(countByLevel(l, { sessionId: 'A' })).toEqual({ error: 1, warn: 0, info: 1, debug: 1 });
    expect(countByLevel(l, { q: 'nothing like this' })).toEqual({ error: 0, warn: 0, info: 0, debug: 0 });
  });

  it('scope resolves: all, the open session (auto) or an explicit id', () => {
    expect(resolveScope('all', 'A')).toBeUndefined();
    expect(resolveScope('auto', 'A')).toBe('A');
    expect(resolveScope('auto', undefined)).toBeUndefined();
    expect(resolveScope('B', 'A')).toBe('B');
    expect(DEFAULT_FILTERS.scope).toBe('auto');
    expect(DEFAULT_FILTERS.levels).toEqual(['error', 'warn', 'info']); // debug is opt-in
  });
});

describe('mergeEntries', () => {
  it('appends newer entries and ignores duplicates streamed during the initial fetch', () => {
    const a = [e(), e(), e()];
    const merged = mergeEntries(a, [a[2]!, e(), e()]);
    expect(merged.map((x) => x.seq)).toEqual([...a.map((x) => x.seq), a[2]!.seq + 1, a[2]!.seq + 2]);
  });
  it('orders out-of-order batches by seq', () => {
    const x = e(), y = e(), z = e();
    expect(mergeEntries([z], [x, y]).map((q) => q.seq)).toEqual([x.seq, y.seq, z.seq]);
  });
  it('caps to the newest entries', () => {
    const big = Array.from({ length: 50 }, () => e());
    const out = mergeEntries([], big, 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toBe(big[40]);
    expect(CLIENT_CAP).toBeGreaterThanOrEqual(1000);
  });
  it('returns the same array for nothing new', () => { const a = [e()]; expect(mergeEntries(a, [])).toBe(a); });
});

describe('error badge', () => {
  it('counts only errors after the last seen seq', () => {
    const l = mk();
    expect(unseenErrors(l, 0)).toBe(1);
    expect(unseenErrors(l, l[0]!.seq)).toBe(0);
    expect(unseenErrors([...l, e({ level: 'error' }), e({ level: 'warn' })], l[0]!.seq)).toBe(1);
  });
  it('label: nothing at 0, the number, then 99+', () => {
    expect(badgeLabel(0)).toBeUndefined();
    expect(badgeLabel(3)).toBe('3');
    expect(badgeLabel(99)).toBe('99');
    expect(badgeLabel(100)).toBe('99+');
  });
});

describe('follow the tail', () => {
  const base = { scrollHeight: 1000, clientHeight: 300 };
  it('stays following while at the bottom', () => {
    expect(followAfterScroll({ ...base, following: true, scrollTop: 700, lastTop: 690 })).toEqual({ following: true, showJump: false });
  });
  it('stops following when the reader scrolls up, and shows the jump strip', () => {
    expect(followAfterScroll({ ...base, following: true, scrollTop: 400, lastTop: 700 })).toEqual({ following: false, showJump: true });
  });
  it('content growing under a reader who scrolled away does not resume following', () => {
    expect(followAfterScroll({ ...base, following: false, scrollTop: 400, lastTop: 400 })).toEqual({ following: false, showJump: true });
  });
  it('scrolling back near the bottom resumes following and hides the strip', () => {
    expect(followAfterScroll({ ...base, following: false, scrollTop: 660, lastTop: 500 })).toEqual({ following: true, showJump: false });
  });
  it('a jump of exactly the threshold counts as away', () => {
    expect(followAfterScroll({ ...base, following: false, scrollTop: 640, lastTop: 640, threshold: 60 }).showJump).toBe(true);
    expect(followAfterScroll({ ...base, following: false, scrollTop: 641, lastTop: 641, threshold: 60 }).showJump).toBe(false);
  });
});

describe('findFocusSeq: the entry an error banner points at', () => {
  it('prefers the error closest in time within the session', () => {
    const t = 5_000_000;
    const l = [
      e({ ts: t - 40_000, level: 'error', sessionId: 'A' }), e({ ts: t - 3_000, level: 'info', sessionId: 'A' }), e({ ts: t + 500, level: 'error', sessionId: 'A', message: 'target' }),
      e({ ts: t, level: 'error', sessionId: 'B' }),
    ];
    expect(l.find((x) => x.seq === findFocusSeq(l, { sessionId: 'A', ts: t }))!.message).toBe('target');
  });
  it('an error beats a nearer info line', () => {
    const t = 9_000_000;
    const l = [e({ ts: t, level: 'info', sessionId: 'A' }), e({ ts: t + 4000, level: 'error', sessionId: 'A' })];
    expect(findFocusSeq(l, { sessionId: 'A', ts: t })).toBe(l[1]!.seq);
  });
  it('the entry that says exactly what the banner said wins over a nearer one', () => {
    const t = 7_000_000;
    const l = [e({ ts: t + 3000, level: 'error', sessionId: 'A', message: 'The API key was rejected (401).' }), e({ ts: t, level: 'error', sessionId: 'A', message: 'API error: authentication_failed' })];
    expect(findFocusSeq(l, { sessionId: 'A', ts: t })).toBe(l[1]!.seq);
    expect(findFocusSeq(l, { sessionId: 'A', ts: t, text: 'The API key was rejected (401).' })).toBe(l[0]!.seq);
  });
  it('nothing within the window -> undefined; without ts the latest error of the session', () => {
    const l = [e({ ts: 1000, level: 'error', sessionId: 'A' }), e({ ts: 2000, level: 'error', sessionId: 'A' }), e({ ts: 3000, level: 'info', sessionId: 'A' })];
    expect(findFocusSeq(l, { sessionId: 'A', ts: 10_000_000 })).toBeUndefined();
    expect(findFocusSeq(l, { sessionId: 'A' })).toBe(l[1]!.seq);
    expect(findFocusSeq(l, { sessionId: 'Z' })).toBeUndefined();
  });
});

describe('time labels and text', () => {
  it('absolute time is local with milliseconds; relative is human', () => {
    const ts = new Date(2026, 9, 18, 12, 4, 5, 7).getTime();
    expect(absoluteTime(ts)).toBe('2026-10-18 12:04:05.007');
    expect(ago(ts, ts + 2000)).toBe('just now');
    expect(ago(ts, ts + 30_000)).toBe('30 seconds ago');
    expect(ago(ts, ts + 180_000)).toBe('3 minutes ago');
    expect(ago(ts, ts + 60_000)).toBe('1 minute ago');
    expect(ago(ts, ts + 5 * 3600_000)).toBe('5 hours ago');
    expect(ago(ts, ts + 4 * 86400_000)).toBe('4 days ago');
    expect(timeTitle(ts, ts + 180_000)).toBe('3 minutes ago · 2026-10-18 12:04:05.007');
  });
  it('entryText is the single-line file format', () => {
    const line = entryText({ seq: 1, ts: Date.UTC(2026, 0, 2, 3, 4, 5, 6), level: 'warn', source: 'git', sessionId: '12345678-abcd', message: 'a\nb', detail: { n: 1 } });
    expect(line).toBe('2026-01-02T03:04:05.006Z WARN  git        [12345678] a\\nb {"n":1}');
    expect(entriesText([])).toBe('');
    expect(entriesText(mk()).split('\n')).toHaveLength(5);
  });
  it('serverQuery maps the filters to the REST query (all levels / all sources are omitted)', () => {
    expect(serverQuery({ levels: ['error', 'warn'], source: 'sdk', sessionId: 'A', q: ' boom ' })).toEqual({ since: undefined, level: 'error,warn', source: 'sdk', sessionId: 'A', q: 'boom', limit: undefined });
    expect(serverQuery({ levels: ['error', 'warn', 'info', 'debug'], source: 'all' })).toMatchObject({ level: undefined, source: undefined, q: undefined });
    expect(serverQuery({ since: 5, limit: 100 })).toMatchObject({ since: '5', limit: '100' });
  });
});
