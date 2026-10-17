/** Safe wrappers: storage can throw (private mode, blocked site data). */
export const ls = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  getJson<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  setJson(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

/**
 * Server + token handling (security-critical, see docs/reviews/2026-10-scrutiniser-1.md B1).
 *
 * - By default the client talks ONLY to its own origin, with the token from `?token=` (kept in sessionStorage).
 * - A different server can only be set from Settings after an explicit confirm (`confirmRemoteServer`). It is stored
 *   as ONE record {origin, token, confirmed} so the server URL and the token it may receive can never drift apart:
 *   the same-origin token is never sent to the remote server and the remote token is never sent anywhere else.
 * - Nothing in the URL can choose the server: `?server=` is ignored and stripped, and the legacy `ws.serverUrl`
 *   key (which the old `?server=` handler wrote) is deleted on load.
 */
const TOKEN_KEY = 'ws.token';
const LEGACY_SERVER_KEY = 'ws.serverUrl';
const REMOTE_KEY = 'ws.remoteServer';

export interface RemoteServer { origin: string; token: string; confirmed: true }

/** Normalizes user input to an http(s) origin, or null if it is not a valid http(s) URL. */
export function normalizeServerOrigin(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch { return null; }
}

/** The confirmed non-same-origin server, if any. Anything malformed or unconfirmed is discarded. */
export function getRemoteServer(): RemoteServer | null {
  const r = ls.getJson<Partial<RemoteServer> | null>(REMOTE_KEY, null);
  if (!r || r.confirmed !== true || typeof r.origin !== 'string' || typeof r.token !== 'string') return null;
  const origin = normalizeServerOrigin(r.origin);
  if (!origin || origin !== r.origin || origin === location.origin) return null;
  return { origin, token: r.token, confirmed: true };
}

/** Base URL of the Workstation server: this page's origin unless a remote server was confirmed in Settings. */
export function getServerBase(): string {
  return getRemoteServer()?.origin ?? location.origin.replace(/\/+$/, '');
}
/** True when the client is talking to a server other than the page's own origin. */
export const isRemoteServer = (): boolean => getRemoteServer() !== null;

/**
 * Persists a remote server. Call ONLY after the user explicitly confirmed (Settings shows a confirm dialog naming the
 * host and stating that the token and API keys will be sent there). Returns false for an invalid URL.
 */
export function confirmRemoteServer(url: string, token: string): boolean {
  const origin = normalizeServerOrigin(url);
  if (!origin || origin === location.origin) return false;
  ls.setJson(REMOTE_KEY, { origin, token: token.trim(), confirmed: true } satisfies RemoteServer);
  return true;
}
/** Back to the page's own origin. */
export function clearRemoteServer() { ls.del(REMOTE_KEY); ls.del(LEGACY_SERVER_KEY); }

export const isDemo = (): boolean => new URLSearchParams(location.search).get('demo') === '1' || sessionStorageGet('ws.demo') === '1';

function sessionStorageGet(k: string): string | null { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k: string, v: string) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }

/**
 * Reads ?token= into sessionStorage and strips it (and demo flag) from the visible URL. `?server=` is NOT honoured:
 * it is stripped and ignored. A `?token=` was printed by the server at THIS origin, so it also drops any remote server
 * (the user explicitly came back to this server).
 */
export function bootstrapToken(): string | null {
  ls.del(LEGACY_SERVER_KEY); // written by the old ?server= handler: never trusted
  const url = new URL(location.href);
  const t = url.searchParams.get('token');
  if (t) {
    sessionStorageSet(TOKEN_KEY, t);
    url.searchParams.delete('token');
    clearRemoteServer();
  }
  const server = url.searchParams.has('server');
  if (server) url.searchParams.delete('server');
  if (url.searchParams.get('demo') === '1') sessionStorageSet('ws.demo', '1');
  if (t || server) history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
  return getToken();
}
/** The token for `getServerBase()`: the confirmed remote's own token, or the same-origin session token. Never mixed. */
export function getToken(): string | null {
  const remote = getRemoteServer();
  if (remote) return remote.token || null;
  return sessionStorageGet(TOKEN_KEY);
}
