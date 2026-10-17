import { getServerBase, getToken } from './storage';

export type AccessProbe = 'ok' | 'missing' | 'invalid' | 'unreachable';

/** Classifies the answer of GET /api/health: 401/403 = token refused, other failures = server not reachable. */
export function classifyHealth(status: number | null): AccessProbe {
  if (status === null) return 'unreachable';
  if (status === 401 || status === 403) return 'invalid';
  return status >= 200 && status < 300 ? 'ok' : 'unreachable';
}

/**
 * Asks the server whether our token is accepted (`/api/health` needs the Bearer token). A refused WebSocket upgrade
 * is indistinguishable from a network error in the browser, so this fetch is how a wrong token is told apart from
 * a server that is merely down. No token at all never touches the network.
 */
export async function probeAccess(fetchImpl: typeof fetch = fetch, token: string | null = getToken(), base: string = getServerBase()): Promise<AccessProbe> {
  if (!token) return 'missing';
  try {
    const res = await fetchImpl(new URL('/api/health', base + '/'), { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    return classifyHealth(res.status);
  } catch { return classifyHealth(null); }
}
