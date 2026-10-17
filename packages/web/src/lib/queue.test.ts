import { describe, expect, it } from 'vitest';
import { clearFailed, failMessage, hasFailed, markAllFailed, nextSendable, type QueuedPrompt } from './queue';

const q = (id: string, failed?: boolean): QueuedPrompt => ({ id, text: id, images: [], failed });

describe('queued messages (M8: never stuck as "queued" forever)', () => {
  it('a message that could not be sent is kept and marked failed (added if it was not queued)', () => {
    const out = failMessage([], { id: 'a', text: 'hello', images: [] });
    expect(out).toEqual([{ id: 'a', text: 'hello', images: [], failed: true }]);
    expect(failMessage([q('a'), q('b')], { id: 'b', text: 'b', images: [] }).map((x) => !!x.failed)).toEqual([false, true]);
  });
  it('failed items are skipped by the automatic flush but picked up after retry', () => {
    expect(nextSendable([q('a', true), q('b')])?.id).toBe('b');
    expect(nextSendable([q('a', true)])).toBeUndefined();
    expect(nextSendable(clearFailed([q('a', true)]))?.id).toBe('a');
  });
  it('markAllFailed / hasFailed', () => {
    expect(hasFailed([q('a'), q('b')])).toBe(false);
    expect(hasFailed(markAllFailed([q('a'), q('b')]))).toBe(true);
    expect(markAllFailed([q('a')])[0].failed).toBe(true);
  });
});
