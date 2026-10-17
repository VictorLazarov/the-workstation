import { describe, expect, it } from 'vitest';
import { MAX_RETRIES, reconnectDelay } from './ws';

describe('reconnect backoff (M2: no endless retrying)', () => {
  it('grows exponentially and is capped at 30s', () => {
    expect([0, 1, 2, 3].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000]);
    expect(reconnectDelay(20)).toBe(30_000);
  });
  it('gives up after a bounded total wait (about two minutes)', () => {
    let total = 0;
    for (let i = 0; i < MAX_RETRIES; i++) total += reconnectDelay(i);
    expect(MAX_RETRIES).toBeLessThanOrEqual(12);
    expect(total).toBeLessThan(5 * 60_000);
  });
});
