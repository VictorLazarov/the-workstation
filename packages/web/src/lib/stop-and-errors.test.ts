/**
 * N1 regression: a user Stop is neutral and a real API error is one actionable message. Fed with message streams CAPTURED FROM THE
 * REAL SDK (lib/fixtures/real-*.json; capture script: packages/server/scripts/capture-real.ts), not hand-written strings: the real
 * result for a Stop carries only "[ede_diagnostic] ..." in `errors`, which the old regex (/interrupt|abort/) never matched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import interruptStream from './fixtures/real-interrupt-stream.json';
import interruptPermission from './fixtures/real-interrupt-permission.json';
import auth401 from './fixtures/real-401.json';
import { applyServer, emptyConversation, markInterruptRequested, addLocalUser } from './reducer';
import type { Conversation, NoticeItem, ResultItem } from './types';

beforeEach(() => { vi.spyOn(console, 'debug').mockImplementation(() => {}); });

type Ev = { type: string; message?: unknown; sessionId?: string; code?: string };
const replay = (events: Ev[], opts: { userStop?: boolean } = {}): Conversation => {
  let c = addLocalUser(emptyConversation(), 'c1', 'prompt');
  for (const e of events) {
    if (opts.userStop && e.type === 'sdk' && (e.message as { type?: string }).type === 'result') c = markInterruptRequested(c);
    c = applyServer(c, e);
  }
  return c;
};
const items = (c: Conversation) => c.lanes[''].items;
const results = (c: Conversation) => items(c).filter((i): i is ResultItem => i.kind === 'result');
const notices = (c: Conversation) => items(c).filter((i): i is NoticeItem => i.kind === 'notice');
const text = (c: Conversation) => JSON.stringify(items(c));

describe('N1: Stop (real interrupt stream)', () => {
  it('real payload sanity: the result is error_during_execution with only an SDK diagnostic', () => {
    const r = (interruptStream as Ev[]).find((e) => e.type === 'sdk' && (e.message as { type?: string }).type === 'result')!.message as { subtype: string; errors: string[] };
    expect(r.subtype).toBe('error_during_execution');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^\[ede_diagnostic\]/);
  });

  it('is a neutral Stopped result: no error banner, no raw diagnostic, no "Interrupted by user" line, no failure', () => {
    const c = replay(interruptStream as Ev[], { userStop: true });
    const [res] = results(c);
    expect(res.outcome).toBe('stopped');
    expect(res.ok).toBe(false);
    expect(res.message).toBeUndefined();
    expect(text(c)).not.toContain('ede_diagnostic');
    expect(text(c)).not.toMatch(/Interrupted by user/);
    expect(notices(c).filter((n) => n.level !== 'info')).toHaveLength(0);
    expect(c.interruptRequested).toBe(false);
  });

  it('is also a Stop when only the SDK terminal_reason says so (stopped from another tab, or replayed history)', () => {
    const c = replay(interruptStream as Ev[]);
    expect(results(c)[0].outcome).toBe('stopped');
  });

  it('a Stop at a permission prompt: tool step is stopped (not an error), permission.cancelled is a stop signal', () => {
    const evs = interruptPermission as Ev[];
    expect(evs.some((e) => e.type === 'permission.cancelled')).toBe(true);
    const c = replay(evs);
    expect(results(c)[0].outcome).toBe('stopped');
    const tr = Object.values(c.toolResults);
    expect(tr).toHaveLength(1);
    expect(tr[0].isError).toBe(true);
    expect(tr[0].stopped).toBe(true); // rendered as a neutral stopped step, not a red error
    expect(text(c)).not.toContain('ede_diagnostic');
  });
});

describe('N1: real API error (401 from a bad base URL, real stream)', () => {
  it('shows the one real, actionable message with a Settings action, and nothing false', () => {
    const c = replay(auth401 as Ev[]);
    const errs = notices(c).filter((n) => n.level === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].text).toMatch(/API error 401: authentication_failed/);
    expect(errs[0].action).toBe('settings');
    // the server stopped the turn itself: that must not be reported as the user's Stop, and the result adds no second banner
    expect(results(c)[0].outcome).toBe('reported');
    expect(text(c)).not.toMatch(/Interrupted by user/);
    expect(text(c)).not.toContain('ede_diagnostic');
  });

  it('a failure with no error event keeps its real text, logs diagnostics to the console only, and offers Retry', () => {
    const debug = vi.mocked(console.debug); debug.mockClear();
    const c = replay([{ type: 'sdk', message: { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null', 'Request failed: socket hang up'], terminal_reason: 'model_error', duration_ms: 5, num_turns: 1, total_cost_usd: 0 } }]);
    const [res] = results(c);
    expect(res.outcome).toBe('error');
    expect(res.message).toBe('Request failed: socket hang up');
    expect(res.action).toBe('retry');
    expect(JSON.stringify(res)).not.toContain('ede_diagnostic');
    expect(debug).toHaveBeenCalled();
  });

  it('a result with only a diagnostic and no stop signal is an error with a generic message, never the raw diagnostic', () => {
    const debug = vi.mocked(console.debug); debug.mockClear();
    const c = replay([{ type: 'sdk', message: { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user'], duration_ms: 5, num_turns: 1, total_cost_usd: 0 } }]);
    expect(results(c)[0].outcome).toBe('error');
    expect(results(c)[0].message).toBe('The turn ended with an error');
  });

  it('error codes map to the right action', async () => {
    const { errorAction } = await import('./reducer');
    expect(errorAction('authentication_failed')).toBe('settings');
    expect(errorAction('model_not_found')).toBe('settings');
    expect(errorAction('process_exited')).toBe('retry');
    expect(errorAction(undefined)).toBe('retry');
  });
});

describe('session cap error', () => {
  it('is plain words with a Close-idle action, not the server jargon', async () => {
    const { friendlyError, errorAction } = await import('./reducer');
    const raw = 'too many live sessions (max 20); close one first or raise WORKSTATION_MAX_SESSIONS';
    const msg = friendlyError(raw, 'session_limit', 20);
    expect(msg).not.toMatch(/WORKSTATION_MAX_SESSIONS|live sessions/);
    expect(msg).toMatch(/Close the idle ones/);
    expect(errorAction('session_limit')).toBe('close-idle');
    expect(friendlyError('boom', 'other')).toBe('boom');
  });
});
