import { describe, expect, it, vi } from 'vitest';
import { classifyHealth, probeAccess } from './access';

describe('access token probe (M2)', () => {
  it('classifies the /api/health status', () => {
    expect(classifyHealth(200)).toBe('ok');
    expect(classifyHealth(401)).toBe('invalid');
    expect(classifyHealth(403)).toBe('invalid');
    expect(classifyHealth(502)).toBe('unreachable');
    expect(classifyHealth(null)).toBe('unreachable');
  });
  it('sends the token as a Bearer header and reports a rejected token', async () => {
    const f = vi.fn(async () => ({ status: 401 }) as Response);
    expect(await probeAccess(f as unknown as typeof fetch, 'tok', 'http://127.0.0.1:7777')).toBe('invalid');
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:7777/api/health');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
  it('a missing token never touches the network', async () => {
    const f = vi.fn();
    expect(await probeAccess(f as unknown as typeof fetch, null, 'http://x')).toBe('missing');
    expect(f).not.toHaveBeenCalled();
  });
  it('a network error means the server is down, not that the token is wrong', async () => {
    expect(await probeAccess((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch, 'tok', 'http://x')).toBe('unreachable');
    expect(await probeAccess((async () => ({ status: 200 }) as Response) as unknown as typeof fetch, 'tok', 'http://x')).toBe('ok');
  });
});
