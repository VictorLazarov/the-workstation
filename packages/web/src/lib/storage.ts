/** Safe wrappers: storage can throw (private mode, blocked site data). */
export const ls = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  getJson<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  setJson(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const TOKEN_KEY = 'ws.token';
export const isDemo = (): boolean => new URLSearchParams(location.search).get('demo') === '1' || sessionStorageGet('ws.demo') === '1';

function sessionStorageGet(k: string): string | null { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k: string, v: string) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }

/** Reads ?token= into sessionStorage and strips it (and demo flag) from the visible URL. */
export function bootstrapToken(): string | null {
  const url = new URL(location.href);
  const t = url.searchParams.get('token');
  if (t) {
    sessionStorageSet(TOKEN_KEY, t);
    url.searchParams.delete('token');
  }
  if (url.searchParams.get('demo') === '1') sessionStorageSet('ws.demo', '1');
  if (t) history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
  return getToken();
}
export function getToken(): string | null { return sessionStorageGet(TOKEN_KEY); }
