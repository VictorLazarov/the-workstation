/**
 * Scrutiniser 4 regressions (docs/reviews/2026-10-scrutiniser-4.md): M1 untracked folder, M3 one error once, minors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addLocalUser, applyServer, emptyConversation } from './reducer';
import type { Conversation, NoticeItem, ResultItem } from './types';
import { mergeChanges, projectChanges } from '../panels/changes/derive';
import { visibleSessions } from './sidebar';
import { TOAST_TTL, useUi } from '../store/ui';
import { _resetReviewHydration, reviewKey, useReview } from '../store/review';

beforeEach(() => { vi.spyOn(console, 'debug').mockImplementation(() => {}); });

type Ev = { type: string; message?: unknown; sessionId?: string; code?: string };
const items = (c: Conversation) => c.lanes[''].items;
const replay = (events: Ev[]): Conversation => events.reduce((c, e) => applyServer(c, e), addLocalUser(emptyConversation(), 'c1', 'hello'));

/** The sequence the real SDK produces for a rejected key (review M3): retry, synthetic assistant message, error result. */
const synthetic: Ev = { type: 'sdk', message: { type: 'assistant', error: 'authentication_failed', parent_tool_use_id: null, uuid: 'u1', message: { id: 'm1', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Invalid API key · Fix external API key' }] } } };
const retry: Ev = { type: 'sdk', message: { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 401, error: 'authentication_failed' } };
const errEvent: Ev = { type: 'error', sessionId: 's', code: 'authentication_failed', message: 'The API key was rejected (401). Check the key and base URL in Settings.' };
const errResult: Ev = { type: 'sdk', message: { type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Fix external API key', errors: ['Invalid API key · Fix external API key'], duration_ms: 5, num_turns: 1, total_cost_usd: 0 } };

describe('M3: a rejected key is reported once, in plain words', () => {
  for (const [name, order] of [['error event first', [errEvent, retry, synthetic, errResult]], ['synthetic message first', [retry, synthetic, errEvent, errResult]], ['no error event (older server / replayed history)', [retry, synthetic, errResult]]] as const) {
    it(name, () => {
      const c = replay([...order]);
      const notices = items(c).filter((i): i is NoticeItem => i.kind === 'notice');
      expect(notices).toHaveLength(1);
      expect(notices[0].action).toBe('settings');
      expect(notices[0].text).toMatch(/Settings/);
      expect(JSON.stringify(items(c).filter((i) => i.kind !== 'result'))).not.toMatch(/external API key/i);
      expect(items(c).filter((i) => i.kind === 'assistant')).toHaveLength(0); // the CLI's synthetic message is not prose
      const res = items(c).filter((i): i is ResultItem => i.kind === 'result');
      expect(res).toHaveLength(1);
      expect(res[0].outcome).toBe('reported'); // no second banner
      expect(c.retry).toBeNull(); // no stale "API 401, retrying"
    });
  }
  it('a retry that arrives after the failure was reported does not leave a retrying card', () => {
    const c = replay([errEvent, retry]);
    expect(c.retry).toBeNull();
  });
  it('the joined errors[] of an error result is de-duplicated', () => {
    const c = replay([{ type: 'sdk', message: { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Mock error: x', errors: ['Mock error: x'], duration_ms: 1, num_turns: 1, total_cost_usd: 0 } }]);
    expect((items(c).find((i) => i.kind === 'result') as ResultItem).message).toBe('Mock error: x');
  });
});

describe('M1: untracked folders', () => {
  const root = '/p';
  it('a legacy `dir/` entry is marked as a folder (no diff, no revert), and the commit list equals the visible files', () => {
    const git = { isRepo: true, root, files: [{ path: 'src/', index: '?', worktree: '?' }, { path: 'a.ts', index: ' ', worktree: 'M' }], diffs: {} };
    const files = mergeChanges(root, git, []);
    expect(files.find((f) => f.path === '/p/src')?.isDir).toBe(true);
    expect(files.find((f) => f.path === '/p/a.ts')?.isDir).toBeUndefined();
  });
  it('per-file entries of a new folder are plain untracked files, counted once each and all committed', () => {
    const git = { isRepo: true, root, files: ['src/lib/util.ts', 'src/lib/more.ts'].map((path) => ({ path, index: '?', worktree: '?' })), diffs: {} };
    const v = projectChanges(emptyConversation(), root, git);
    expect(v.count).toBe(2);
    expect(v.commitFiles).toEqual(v.files.map((f) => f.path));
    expect(v.files.every((f) => !f.isDir && f.status === 'untracked')).toBe(true);
  });
});

describe('minor: sessions that need you are never hidden behind "Show N more"', () => {
  it('keeps the first N by recency plus every non-idle row and the open one', () => {
    const es = Array.from({ length: 10 }, (_, i) => ({ id: 's' + i, status: 'idle' as const }));
    es[8] = { id: 's8', status: 'needs-input' as never };
    es[9] = { id: 's9', status: 'running' as never };
    es[7] = { id: 's7', status: 'error' as never }; // an old failure stays foldable unless it is the open one
    expect(visibleSessions(es, 6, 's7').map((e) => e.id)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's7', 's8', 's9']);
    expect(visibleSessions(es, 6).map((e) => e.id)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's8', 's9']);
  });
});

describe('minor: toasts', () => {
  beforeEach(() => useUi.setState({ toasts: [] }));
  it('every kind has a finite ttl, repeats keep the original start time', () => {
    for (const k of ['info', 'success', 'error', 'attention'] as const) expect(TOAST_TTL[k]).toBeGreaterThan(0);
    const t = useUi.getState().toast;
    t({ kind: 'attention', tag: 'a', title: 'Approval needed' });
    const since = useUi.getState().toasts[0].since;
    t({ kind: 'attention', tag: 'a', title: 'Approval needed' });
    expect(useUi.getState().toasts[0].since).toBe(since);
    expect(useUi.getState().toasts[0].count).toBe(2);
  });
  it('an outage clears stale session toasts but keeps errors', () => {
    const t = useUi.getState().toast;
    t({ kind: 'attention', tag: 'a', title: 'Approval needed' });
    t({ kind: 'success', tag: 'b', title: 'Session finished' });
    t({ kind: 'error', title: 'Not connected' });
    useUi.getState().dismissStaleToasts();
    expect(useUi.getState().toasts.map((x) => x.title)).toEqual(['Not connected']);
  });
});

describe('minor: diff comments survive a reload', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear(); _resetReviewHydration(); useReview.setState({ by: {} });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  });
  it('persists per session and restores into a fresh store', () => {
    useReview.getState().add('s1', { path: '/p/a.ts', rel: 'a.ts', line: 3, side: 'new', code: 'x', text: 'why?' });
    expect(JSON.parse(store.get(reviewKey('s1'))!)).toHaveLength(1);
    expect(store.has(reviewKey('s2'))).toBe(false);
    _resetReviewHydration(); useReview.setState({ by: {} }); // "reload"
    useReview.getState().hydrate('s1');
    expect(useReview.getState().by.s1.map((c) => c.text)).toEqual(['why?']);
    useReview.getState().clear('s1');
    expect(store.has(reviewKey('s1'))).toBe(false);
  });
  it('ignores a corrupt saved value', () => {
    store.set(reviewKey('s1'), '{"nope":1}');
    useReview.getState().hydrate('s1');
    expect(useReview.getState().by.s1 ?? []).toEqual([]);
  });
});
