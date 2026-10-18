/**
 * Talking to a custom Anthropic-compatible endpoint ("gateway": LiteLLM, OpenRouter-style proxies, company gateways)
 * outside of a session: model discovery (GET <base>/v1/models) and a "Test connection" request.
 *
 * Credentials are used exactly as a session would use them (cli-env.ts): API key as `x-api-key`, auth token as
 * `Authorization: Bearer`, and, with neither, the NON-SECRET sentinel. Nothing inherited from the server's own environment is ever
 * sent. Requests have a short timeout, redirects are followed only within the same origin, secrets are never logged, and
 * every error text is scrubbed of the configured secrets before it leaves this module.
 */
import { createHash } from 'node:crypto';
import type { GatewayTestResult } from '@workstation/protocol';
import { NO_CREDENTIAL_SENTINEL } from './cli-env.js';

export interface GatewayTarget { baseUrl: string; apiKey?: string; authToken?: string }

const ANTHROPIC_VERSION = '2023-06-01';
const MAX_MODELS = 500;
const MAX_BODY = 256 * 1024;

/** Stable, non-reversible fingerprint of a target (cache key); never the secret itself. */
export function targetKey(t: GatewayTarget): string {
  return createHash('sha256').update(JSON.stringify([t.baseUrl, t.apiKey ?? '', t.authToken ?? ''])).digest('hex').slice(0, 24);
}

/** `<base>/v1/...` the way the SDK builds it (trailing slashes dropped, no other normalisation). */
export function gatewayUrl(baseUrl: string, p: string): URL {
  return new URL(baseUrl.replace(/\/+$/, '') + p);
}

function headersFor(t: GatewayTarget, bearerFromKey = false): Record<string, string> {
  const h: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION, accept: 'application/json' };
  if (t.apiKey) h['x-api-key'] = t.apiKey;
  if (t.authToken) h.authorization = `Bearer ${t.authToken}`;
  else if (bearerFromKey && t.apiKey) h.authorization = `Bearer ${t.apiKey}`;
  if (!t.apiKey && !t.authToken) h['x-api-key'] = NO_CREDENTIAL_SENTINEL;
  return h;
}

export function redact(text: string, t: GatewayTarget): string {
  let out = text;
  for (const s of [t.apiKey, t.authToken]) if (s && s.length >= 6) out = out.split(s).join('***');
  return out;
}

/** fetch with a hard timeout; a redirect is followed only when it stays on the same origin (credentials never travel to another host). */
async function gwFetch(url: URL, init: { method: string; headers: Record<string, string>; body?: string }, timeoutMs: number): Promise<Response> {
  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(cur, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location')!, cur);
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (next.origin !== url.origin) throw new Error(`The endpoint redirected to another host (${next.host}); not followed`);
      cur = next;
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

async function readText(res: Response): Promise<string> {
  try {
    const buf = await res.arrayBuffer();
    return new TextDecoder().decode(buf.byteLength > MAX_BODY ? buf.slice(0, MAX_BODY) : buf);
  } catch { return ''; }
}

/** Model ids from an Anthropic `{data:[{id}]}` or OpenAI-style `{data:[{id}]}` / `{models:[{id|name}]}` / bare array listing. */
export function parseModelIds(body: unknown): string[] {
  const list = Array.isArray(body) ? body
    : body && typeof body === 'object' ? ((body as { data?: unknown; models?: unknown }).data ?? (body as { models?: unknown }).models) : undefined;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const e of list) {
    const id = typeof e === 'string' ? e : e && typeof e === 'object' ? ((e as { id?: unknown }).id ?? (e as { name?: unknown }).name) : undefined;
    if (typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\s\0]/.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/** GET <base>/v1/models. Never throws: any failure (network, 4xx, bad JSON) is "no list", and the caller falls back. */
export async function fetchGatewayModels(t: GatewayTarget, timeoutMs = 4000): Promise<string[]> {
  try {
    const url = gatewayUrl(t.baseUrl, '/v1/models');
    url.searchParams.set('limit', '1000');
    let res = await gwFetch(url, { method: 'GET', headers: headersFor(t) }, timeoutMs);
    // OpenAI-style gateways (LiteLLM, OpenRouter...) want the key as a Bearer token; the key only goes to the host it is configured for
    if ((res.status === 401 || res.status === 403) && t.apiKey && !t.authToken) {
      await res.body?.cancel().catch(() => {});
      res = await gwFetch(url, { method: 'GET', headers: headersFor(t, true) }, timeoutMs);
    }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return []; }
    return parseModelIds(JSON.parse(await readText(res)));
  } catch {
    return [];
  }
}

/** The provider's own words from an error body (Anthropic `{error:{message}}`, OpenAI/LiteLLM `{error:{message}}` / `{detail}` / `{message}`). */
export function errorTextFromBody(text: string): string {
  const t = text.trim();
  if (!t) return '';
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    const e = j.error;
    const pick = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      const msg = pick(o.message) ?? pick(o.detail);
      const type = pick(o.type);
      if (msg) return type && !msg.includes(type) ? `${type}: ${msg}` : msg;
    }
    return pick(e) ?? pick(j.message) ?? pick(j.detail) ?? t;
  } catch {
    return t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

/**
 * One message with max_tokens 1: the cheapest request that proves base URL + credential + model together. The result is the
 * provider's own answer: OK, or its actual error text.
 */
export async function testGateway(t: GatewayTarget, model: string, timeoutMs = 15_000): Promise<GatewayTestResult> {
  const started = Date.now();
  const models = await fetchGatewayModels(t, Math.min(timeoutMs, 4000));
  try {
    const res = await gwFetch(gatewayUrl(t.baseUrl, '/v1/messages'), {
      method: 'POST',
      headers: { ...headersFor(t), 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    }, timeoutMs);
    const text = await readText(res);
    const ms = Date.now() - started;
    if (res.ok) return { ok: true, model, status: res.status, ms, models, message: `OK. ${new URL(t.baseUrl).host} answered for "${model}" in ${ms} ms.` };
    const why = redact(errorTextFromBody(text), t).slice(0, 400);
    return { ok: false, model, status: res.status, ms, models, message: `${res.status}${res.statusText ? ` ${res.statusText}` : ''}${why ? `: ${why}` : ''}` };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const name = err.name === 'TimeoutError' || err.name === 'AbortError' ? `No answer within ${Math.round(timeoutMs / 1000)} s` : redact(err.cause?.code ? `Could not reach the endpoint (${err.cause.code})` : err.message || 'Request failed', t);
    return { ok: false, model, ms: Date.now() - started, models, message: name };
  }
}

/** Alias -> id through the env mapping the agent gets (ANTHROPIC_DEFAULT_*_MODEL ...). Returns undefined when `model` is an unmapped alias. */
export function resolveModelAlias(model: string, env: Record<string, string>): string | undefined {
  const m = model.trim();
  const key = ({ sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL', opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL', haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' } as Record<string, string>)[m.toLowerCase()];
  if (key) return env[key]?.trim() || undefined;
  if (m === '' || m === 'default') return env.ANTHROPIC_MODEL?.trim() || undefined;
  return m;
}

/** The gateway the agent is configured for (ConfigStore.providerEnv()), or undefined without a custom base URL. */
export function gatewayTarget(providerEnv: Record<string, string>): GatewayTarget | undefined {
  const baseUrl = providerEnv.ANTHROPIC_BASE_URL?.trim();
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return undefined;
  return { baseUrl, ...(providerEnv.ANTHROPIC_API_KEY ? { apiKey: providerEnv.ANTHROPIC_API_KEY } : {}), ...(providerEnv.ANTHROPIC_AUTH_TOKEN ? { authToken: providerEnv.ANTHROPIC_AUTH_TOKEN } : {}) };
}
