import { beforeEach, describe, expect, it } from 'vitest';

// Minimal browser globals for the node test environment.
class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}
const g = globalThis as unknown as Record<string, unknown>;
function setPage(href: string) {
  const u = new URL(href);
  g.location = { href: u.href, origin: u.origin, search: u.search };
  g.history = { replaceState: (_s: unknown, _t: string, url: string) => { const n = new URL(url, u.origin); (g.location as { href: string; search: string }).href = n.href; (g.location as { search: string }).search = n.search; } };
}
const local = () => g.localStorage as MemStorage;

const storage = await import('./storage');

describe('server/token binding (B1)', () => {
  beforeEach(() => { g.localStorage = new MemStorage(); g.sessionStorage = new MemStorage(); setPage('http://127.0.0.1:7777/'); });

  it('ignores ?server= and strips it from the URL', () => {
    setPage('http://127.0.0.1:7777/?server=https%3A%2F%2Fevil.example&token=T1');
    storage.bootstrapToken();
    expect(storage.getServerBase()).toBe('http://127.0.0.1:7777');
    expect(storage.getToken()).toBe('T1');
    expect(local().getItem('ws.serverUrl')).toBeNull();
    expect(local().getItem('ws.remoteServer')).toBeNull();
    expect((g.location as { href: string }).href).toBe('http://127.0.0.1:7777/');
  });

  it('drops a legacy ws.serverUrl written by the old ?server= handler', () => {
    local().setItem('ws.serverUrl', 'https://evil.example');
    storage.bootstrapToken();
    expect(local().getItem('ws.serverUrl')).toBeNull();
    expect(storage.getServerBase()).toBe('http://127.0.0.1:7777');
  });

  it('ignores an unconfirmed or malformed remote record', () => {
    local().setItem('ws.remoteServer', JSON.stringify({ origin: 'https://evil.example', token: 'x' }));
    expect(storage.getServerBase()).toBe('http://127.0.0.1:7777');
    local().setItem('ws.remoteServer', JSON.stringify({ origin: 'javascript:alert(1)', token: 'x', confirmed: true }));
    expect(storage.getServerBase()).toBe('http://127.0.0.1:7777');
  });

  it('a confirmed remote server gets only its own token, never the same-origin one', () => {
    setPage('http://127.0.0.1:7777/?token=LOCAL');
    storage.bootstrapToken();
    expect(storage.confirmRemoteServer('https://box.example:8443/some/path', 'REMOTE')).toBe(true);
    expect(storage.getServerBase()).toBe('https://box.example:8443');
    expect(storage.getToken()).toBe('REMOTE');
    expect(storage.confirmRemoteServer('https://box.example', '')).toBe(true);
    expect(storage.getToken()).toBeNull(); // no fallback to the same-origin token
  });

  it('a ?token= visit returns to this origin and forgets the remote server', () => {
    storage.confirmRemoteServer('https://box.example', 'REMOTE');
    setPage('http://127.0.0.1:7777/?token=LOCAL');
    storage.bootstrapToken();
    expect(storage.getServerBase()).toBe('http://127.0.0.1:7777');
    expect(storage.getToken()).toBe('LOCAL');
  });

  it('rejects non-http(s) and credential-bearing URLs', () => {
    expect(storage.normalizeServerOrigin('file:///etc/passwd')).toBeNull();
    expect(storage.normalizeServerOrigin('https://u:p@box.example')).toBeNull();
    expect(storage.confirmRemoteServer('not a url', 't')).toBe(false);
  });
});
