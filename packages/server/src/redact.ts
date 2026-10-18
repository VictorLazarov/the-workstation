/**
 * Redaction for everything that reaches the diagnostics log (log.ts) or a debug-info paste.
 *
 * Rule: a log line must be safe to paste into a public bug report. So API keys, auth tokens, the server's access token,
 * Authorization / cookie headers, secret-looking env values and `?token=` query values never survive, whether they
 * appear as a field name (`apiKey: …`), as free text (a CLI error that echoes the key back) or inside a URL.
 *
 * Two layers: (1) exact values the server knows are secret (registered at runtime: config keys, the access token,
 * secret-named env values) are replaced wherever they occur; (2) patterns catch the shapes of well-known credentials
 * and "name = value" pairs with a secret-looking name, for keys the server was never told about.
 */

export const REDACTED = '[redacted]';

/** Field / variable names whose value is a secret. Works on camelCase, snake_case, kebab-case and UPPER_CASE. */
export function isSecretName(name: string): boolean {
  const n = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.\s]+/g, '_').toLowerCase();
  return /(^|_)(api_?key|apikey|key|token|secret|password|passwd|pwd|credentials?|authorization|cookie|set_cookie|auth|oauth|bearer|signature|private_key|passphrase)$/.test(n)
    || /(^|_)(api_?key|secret|password|passwd|credentials?|authorization|private_key|passphrase)(_|$)/.test(n)
    || /(^|_)(access|refresh|id|auth|session|bearer|api)_?token(_|$)/.test(n);
}

/** Fields whose value is user content (a prompt, file text, a diff, base64 data): never logged, even if someone passes it by mistake. */
const CONTENT_NAMES = new Set(['prompt', 'content', 'text', 'filecontent', 'file_content', 'newstring', 'oldstring', 'new_string', 'old_string', 'diff', 'database64', 'data_base64', 'body', 'input', 'stdin', 'output']);

const ESC = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Well-known credential shapes. Each is replaced entirely.
const TOKEN_SHAPES: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{6,}/g,                    // Anthropic keys and OAuth tokens
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/g,            // OpenAI-style keys
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,    // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,                    // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                // Slack
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,                 // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g,                      // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

// `Authorization: Bearer abc`, `x-api-key: abc`, `Proxy-Authorization: Basic …` (header lines, also JSON-ish "authorization":"…")
const HEADER_RE = /\b((?:proxy-)?authorization|x-api-key|api-key|x-auth-token|x-access-token)(["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:(?:Bearer|Basic|Token|Digest)\s+)?[^\s,;"']+)/gi;
// cookies hold spaces and semicolons: the whole rest of the line goes
const COOKIE_RE = /\b(cookie|set-cookie)(["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n"']*)/gi;
const BEARER_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;

// `?token=abc&x=1`, `&api_key=abc`, `access_token=…` inside URLs and query strings
const QUERY_RE = /([?&;]|\\u0026)((?:[A-Za-z0-9_.-]*?)(?:token|key|secret|password|passwd|auth|authorization|signature|sig|credential)[A-Za-z0-9_.-]*)=([^&#\s"'<>)\]]*)/gi;
// `https://user:pass@host`
const USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:"']+):([^\s/@"']+)@/gi;

// NAME=value / NAME: value / "name": "value" where NAME looks secret (env dumps in stderr, JSON in error bodies).
// Matched in two steps (name + separator, then the value) so that "env: API_KEY=abc" finds API_KEY inside the value of "env".
const NAME_RE = /(["']?)\b([A-Za-z][A-Za-z0-9_.-]{0,60})\1(\s*[:=]\s*)/g;
const VALUE_RE = /"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^\s,;&}\])"']+/y;

function redactAssignments(input: string): string {
  let out = '';
  let last = 0;
  NAME_RE.lastIndex = 0;
  for (let m = NAME_RE.exec(input); m; m = NAME_RE.exec(input)) {
    const [whole, q, name, sep] = m as unknown as [string, string, string, string];
    if (!isSecretName(name)) { NAME_RE.lastIndex = m.index + whole.length; continue; }
    VALUE_RE.lastIndex = m.index + whole.length;
    const v = VALUE_RE.exec(input);
    if (!v || /^["']?\[redacted/.test(v[0])) { NAME_RE.lastIndex = m.index + whole.length; continue; }
    const quote = v[0][0] === '"' || v[0][0] === "'" ? v[0][0] : '';
    out += input.slice(last, m.index) + `${q}${name}${q}${sep}${quote}${REDACTED}${quote}`;
    last = m.index + whole.length + v[0].length;
    NAME_RE.lastIndex = last;
  }
  return out + input.slice(last);
}

const cache = new Map<string, RegExp>();

/** Exact secret values replaced wherever they appear. Values shorter than 6 characters are ignored (they would mask ordinary words). */
export function secretRegex(values: Iterable<string>): RegExp | null {
  const list = [...new Set([...values].filter((v) => typeof v === 'string' && v.length >= 6))].sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  const key = list.join('\0');
  let re = cache.get(key);
  if (!re) {
    re = new RegExp(list.map((v) => {
      // a secret may also show up URL-encoded or JSON-escaped
      const forms = new Set([v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1)]);
      return [...forms].map(ESC).join('|');
    }).join('|'), 'g');
    if (cache.size > 20) cache.clear();
    cache.set(key, re);
  }
  return re;
}

export interface RedactOptions {
  /** exact secret values to remove (see `secretRegex`) */
  secrets?: Iterable<string>;
  /** longest string kept (the rest is cut with a marker); default 4000 */
  maxString?: number;
}

/** Remove credentials from free text. Idempotent. */
export function redactString(input: string, opts: RedactOptions = {}): string {
  let s = input;
  const exact = opts.secrets ? secretRegex(opts.secrets) : null;
  if (exact) s = s.replace(exact, REDACTED);
  s = s.replace(HEADER_RE, (m, name: string, sep: string) => (m.slice(name.length + sep.length).startsWith('[redacted') ? m : `${name}${sep}${REDACTED}`));
  s = s.replace(COOKIE_RE, (m, name: string, sep: string) => (m.slice(name.length + sep.length).startsWith('[redacted') ? m : `${name}${sep}${REDACTED}`));
  s = s.replace(BEARER_RE, (_m, kind: string) => `${kind} ${REDACTED}`);
  for (const re of TOKEN_SHAPES) s = s.replace(re, REDACTED);
  s = s.replace(USERINFO_RE, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`);
  s = s.replace(QUERY_RE, (m, sep: string, name: string, value: string) => (value.startsWith('[redacted') ? m : `${sep}${name}=${REDACTED}`));
  s = redactAssignments(s);
  const max = opts.maxString ?? 4000;
  if (s.length > max) s = `${s.slice(0, max)}… [${s.length - max} more characters cut]`;
  return s;
}

/** A URL reduced to scheme + host (+port): no credentials, path or query. Unparseable input yields undefined. */
export function hostOnly(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).host || undefined; } catch { return undefined; }
}

/**
 * Deep-copies `value` for logging: strings are redacted, values under secret-looking keys and under content-looking keys
 * (prompt, file text, diffs, base64) are replaced, errors become `{name, message, stack}`, and size/depth are bounded.
 */
export function redactValue(value: unknown, opts: RedactOptions = {}, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value ?? undefined;
  switch (typeof value) {
    case 'string': return redactString(value, opts);
    case 'number': return Number.isFinite(value) ? value : String(value);
    case 'boolean': return value;
    case 'bigint': return value.toString();
    case 'function': case 'symbol': return undefined;
    default: break;
  }
  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  if (depth >= 5) return '[…]';
  seen.add(obj);
  try {
    if (obj instanceof Error) {
      const e = obj as Error & { code?: unknown; status?: unknown; cause?: unknown };
      return {
        name: e.name,
        message: redactString(e.message ?? '', opts),
        ...(e.code !== undefined ? { code: redactValue(e.code, opts, depth + 1, seen) } : {}),
        ...(e.status !== undefined ? { status: redactValue(e.status, opts, depth + 1, seen) } : {}),
        ...(e.stack ? { stack: redactString(e.stack.split('\n').slice(0, 8).join('\n'), opts) } : {}),
      };
    }
    if (Array.isArray(obj)) {
      const out = obj.slice(0, 50).map((v) => redactValue(v, opts, depth + 1, seen));
      if (obj.length > 50) out.push(`[${obj.length - 50} more]`);
      return out;
    }
    if (obj instanceof Date) return obj.toISOString();
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === undefined || typeof v === 'function') continue;
      if (++n > 60) { out['…'] = 'more fields cut'; break; }
      if (isSecretName(k) && (typeof v === 'string' || (v && typeof v === 'object'))) { out[k] = REDACTED; continue; }
      if (CONTENT_NAMES.has(k.toLowerCase()) && typeof v === 'string') { out[k] = `[${v.length} characters omitted]`; continue; }
      out[k] = redactValue(v, opts, depth + 1, seen);
    }
    return out;
  } finally { seen.delete(obj); }
}

/** Environment reduced to what is safe to show: names always, values only for non-secret names (and cut short). */
export function redactEnv(env: Record<string, string | undefined>, opts: RedactOptions = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    out[k] = isSecretName(k) ? REDACTED : redactString(v, { ...opts, maxString: 200 });
  }
  return out;
}
