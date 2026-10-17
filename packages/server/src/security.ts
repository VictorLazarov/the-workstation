import { createHash, timingSafeEqual } from 'node:crypto';
import net from 'node:net';

export function tokenMatches(provided: string | null | undefined, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function extractBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const WILDCARD = ['0.0.0.0', '::', '[::]', ''];

export interface SecurityOptions {
  /** Configured bind host. */
  host: string;
  /** Extra comma-separated origins (WORKSTATION_ALLOWED_ORIGINS). */
  allowedOrigins?: string[];
  /** Extra hostnames (WORKSTATION_ALLOWED_HOSTS). */
  allowedHosts?: string[];
}

export function securityOptionsFromEnv(host: string, env = process.env): SecurityOptions {
  const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { host, allowedOrigins: list(env.WORKSTATION_ALLOWED_ORIGINS), allowedHosts: list(env.WORKSTATION_ALLOWED_HOSTS) };
}

function hostnameOf(hostHeader: string): string | null {
  if (!hostHeader || /[\s/\\@?#]/.test(hostHeader)) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function bareHost(h: string): string {
  return h.startsWith('[') ? h.slice(1, -1) : h;
}

function explicitHostnames(o: SecurityOptions): Set<string> {
  const set = new Set(LOOPBACK);
  const host = o.host.toLowerCase();
  if (!WILDCARD.includes(host)) set.add(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);
  for (const h of o.allowedHosts ?? []) set.add(h.toLowerCase());
  return set;
}

/** Host header must be a known name (defeats DNS rebinding) or, on wildcard binds, an IP literal. */
export function isHostAllowed(hostHeader: string | undefined | null, o: SecurityOptions): boolean {
  if (!hostHeader) return false;
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (explicitHostnames(o).has(name)) return true;
  if (WILDCARD.includes(o.host.toLowerCase()) && net.isIP(bareHost(name)) !== 0) return true;
  return false;
}

/**
 * Absent Origin (non-browser client) is allowed; browsers must present an allowed one: either exactly the origin the
 * request was addressed to (Origin host:port == validated Host header, i.e. same-origin, which also covers the Vite dev
 * proxy and Docker port mappings), or one listed in WORKSTATION_ALLOWED_ORIGINS. Another port on localhost (any local
 * dev server, including one the agent started) is a different origin and is refused.
 */
export function isOriginAllowed(origin: string | undefined | null, hostHeader: string | undefined | null, o: SecurityOptions): boolean {
  if (origin === undefined || origin === null || origin === '') return true;
  if (origin === 'null') return false;
  if ((o.allowedOrigins ?? []).map((x) => x.replace(/\/+$/, '').toLowerCase()).includes(origin.toLowerCase())) return true;
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!hostHeader || !isHostAllowed(hostHeader, o)) return false;
  let h: URL;
  try { h = new URL(`${u.protocol}//${hostHeader}`); } catch { return false; }
  return u.hostname.toLowerCase() === h.hostname.toLowerCase() && u.port === h.port;
}
