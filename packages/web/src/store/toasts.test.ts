import { beforeEach, describe, expect, it } from 'vitest';
import { TOAST_TTL, useUi, visibleToasts } from './ui';

const toast = (p: Parameters<ReturnType<typeof useUi.getState>['toast']>[0]) => useUi.getState().toast(p);
const list = () => useUi.getState().toasts;
beforeEach(() => useUi.setState({ toasts: [] }));

describe('N3: toast pile', () => {
  it('coalesces repeats of the same kind for the same session into one toast with a count', () => {
    for (let i = 0; i < 5; i++) toast({ kind: 'success', tag: 's1', title: 'Session finished', body: 'bash please: Ready for your review' });
    expect(list()).toHaveLength(1);
    expect(list()[0].count).toBe(5);
    expect(list()[0].rev).toBe(4); // the timer restarts on every repeat
  });

  it('different sessions or kinds stay separate; untagged toasts coalesce on identical text only', () => {
    toast({ kind: 'success', tag: 's1', title: 'Session finished' });
    toast({ kind: 'success', tag: 's2', title: 'Session finished' });
    toast({ kind: 'attention', tag: 's1', title: 'Approval needed' });
    toast({ kind: 'error', title: 'Not connected', body: 'x' });
    toast({ kind: 'error', title: 'Not connected', body: 'x' });
    toast({ kind: 'error', title: 'Not connected', body: 'y' });
    expect(list().map((t) => [t.kind, t.tag ?? t.body, t.count])).toEqual([['success', 's1', 1], ['success', 's2', 1], ['attention', 's1', 1], ['error', 'x', 2], ['error', 'y', 1]]);
  });

  it('shows at most 2 toasts (1 on narrow screens) and queues the rest', () => {
    for (const s of ['a', 'b', 'c', 'd', 'e']) toast({ kind: 'success', tag: s, title: 'Session finished' });
    expect(list()).toHaveLength(5);
    expect(visibleToasts(list(), false)).toHaveLength(2);
    expect(visibleToasts(list(), true)).toHaveLength(1);
    useUi.getState().dismissToast(list()[0].id);
    expect(visibleToasts(list(), false).map((t) => t.tag)).toEqual(['b', 'c']); // queued ones move up
  });

  it('finished/info auto-dismiss after about 4 seconds; errors and prompts stay longer', () => {
    expect(TOAST_TTL.success).toBe(4000);
    expect(TOAST_TTL.info).toBe(4000);
    expect(TOAST_TTL.error).toBeGreaterThan(TOAST_TTL.success);
    toast({ kind: 'success', title: 'ok' });
    expect(list()[0].ttl).toBe(4000);
  });

  it('opening a session clears its toasts', () => {
    toast({ kind: 'success', tag: 's1', title: 'Session finished' });
    toast({ kind: 'success', tag: 's2', title: 'Session finished' });
    useUi.getState().dismissToastsByTag('s1');
    expect(list().map((t) => t.tag)).toEqual(['s2']);
  });
});
