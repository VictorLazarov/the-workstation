import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { startServer, type RunningServer } from '../src/app.js';
import { ConfigStore } from '../src/config.js';
import { createMockAdapter } from '../src/mock.js';
import type { SdkAdapter } from '../src/sdk.js';
import { errorTextFromBody, fetchGatewayModels, parseModelIds, resolveModelAlias, testGateway } from '../src/gateway.js';
import { startFakeGateway, type FakeGateway } from '../../e2e/support/fake-gateway.ts';
import { Client, connect, startSession } from './helpers.js';

process.env.WORKSTATION_MOCK_SPEED = '0';

describe('gateway parsing', () => {
  it('reads Anthropic, OpenAI and bare shapes', () => {
    expect(parseModelIds({ data: [{ type: 'model', id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 5 }, { id: 'has space' }] })).toEqual(['a', 'b']);
    expect(parseModelIds({ object: 'list', data: [{ id: 'gpt-x', object: 'model' }] })).toEqual(['gpt-x']);
    expect(parseModelIds({ models: [{ name: 'm1' }, 'm2'] })).toEqual(['m1', 'm2']);
    expect(parseModelIds(['x'])).toEqual(['x']);
    expect(parseModelIds('nope')).toEqual([]);
    expect(parseModelIds({ data: 'nope' })).toEqual([]);
  });
  it('extracts the provider text from error bodies', () => {
    expect(errorTextFromBody('{"type":"error","error":{"type":"not_found_error","message":"model: x"}}')).toBe('not_found_error: model: x');
    expect(errorTextFromBody('{"error":{"message":"Invalid model name passed in model=x"}}')).toBe('Invalid model name passed in model=x');
    expect(errorTextFromBody('{"detail":"Not authenticated"}')).toBe('Not authenticated');
    expect(errorTextFromBody('<html><body>Bad gateway</body></html>')).toBe('Bad gateway');
  });
  it('maps aliases through the env mapping and never invents one', () => {
    const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'gw-smart' };
    expect(resolveModelAlias('sonnet', env)).toBe('gw-smart');
    expect(resolveModelAlias('opus', env)).toBeUndefined();
    expect(resolveModelAlias('default', env)).toBeUndefined();
    expect(resolveModelAlias('gw-fast', env)).toBe('gw-fast');
  });
});

describe('gateway client', () => {
  let gw: FakeGateway;
  afterEach(async () => { await gw?.stop(); });

  it('lists models with the credential exactly as a session sends it', async () => {
    gw = await startFakeGateway({ key: 'sk-test-123456' });
    expect(await fetchGatewayModels({ baseUrl: gw.url, apiKey: 'sk-test-123456' })).toEqual(['gw-fast', 'gw-smart']);
    expect(gw.requests[0]!.headers['x-api-key']).toBe('sk-test-123456');
    expect(await fetchGatewayModels({ baseUrl: gw.url + '/', authToken: 'sk-test-123456' })).toEqual(['gw-fast', 'gw-smart']);
    expect(gw.requests.at(-1)!.headers.authorization).toBe('Bearer sk-test-123456');
  });
  it('sends only the non-secret sentinel when nothing is configured', async () => {
    gw = await startFakeGateway();
    await fetchGatewayModels({ baseUrl: gw.url });
    expect(gw.requests[0]!.headers['x-api-key']).toBe('workstation-no-credential');
    expect(gw.requests[0]!.headers.authorization).toBeUndefined();
  });
  it('falls back silently: wrong key, no listing, dead port, redirect to another host', async () => {
    gw = await startFakeGateway({ key: 'right-key-123' });
    expect(await fetchGatewayModels({ baseUrl: gw.url, apiKey: 'wrong-key-123' })).toEqual([]);
    const nolist = await startFakeGateway({ noList: true });
    expect(await fetchGatewayModels({ baseUrl: nolist.url })).toEqual([]);
    await nolist.stop();
    const target = await startFakeGateway();
    const redirecting = await startFakeGateway({ redirectTo: target.url + '/v1/models' });
    expect(await fetchGatewayModels({ baseUrl: redirecting.url, apiKey: 'secret-key-123' })).toEqual([]);
    expect(target.requests).toHaveLength(0); // the redirect to a different origin (other port) was not followed, so no key went there
    await redirecting.stop(); await target.stop();
    expect(await fetchGatewayModels({ baseUrl: 'http://127.0.0.1:1' })).toEqual([]);
  });
  it('reads the OpenAI-style listing', async () => {
    gw = await startFakeGateway({ openaiShape: true, models: ['m-a', 'm-b'] });
    expect(await fetchGatewayModels({ baseUrl: gw.url })).toEqual(['m-a', 'm-b']);
  });
  it('tests with one max_tokens-1 message: OK for a served model, the provider text for another', async () => {
    gw = await startFakeGateway({ key: 'k-123456' });
    const ok = await testGateway({ baseUrl: gw.url, apiKey: 'k-123456' }, 'gw-smart');
    expect(ok).toMatchObject({ ok: true, model: 'gw-smart', models: ['gw-fast', 'gw-smart'] });
    const post = gw.requests.filter((r) => r.method === 'POST').at(-1)!;
    expect(post.body).toMatchObject({ model: 'gw-smart', max_tokens: 1 });
    const bad = await testGateway({ baseUrl: gw.url, apiKey: 'k-123456' }, 'claude-sonnet-4-5');
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(404);
    expect(bad.message).toContain('model: claude-sonnet-4-5');
    const noauth = await testGateway({ baseUrl: gw.url, apiKey: 'nope-123456' }, 'gw-smart');
    expect(noauth).toMatchObject({ ok: false, status: 401 });
    expect(noauth.message).toContain('invalid x-api-key');
    expect(JSON.stringify([ok, bad, noauth])).not.toContain('k-123456');
  });
  it('reports a dead endpoint without throwing', async () => {
    const r = await testGateway({ baseUrl: 'http://127.0.0.1:1' }, 'x', 3000);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/reach|No answer|fetch/i);
  });
});

describe('gateway through the server', () => {
  let gw: FakeGateway;
  let srv: RunningServer & { base: string; token: string; dir: string; cwd: string };
  let seen: Options[];
  let client: Client | undefined;
  const call = (p: string, init: RequestInit = {}) => fetch(srv.base + p, { ...init, headers: { authorization: `Bearer ${srv.token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  const put = (body: unknown) => call('/api/config', { method: 'PUT', body: JSON.stringify(body) });

  beforeEach(async () => {
    process.env.WORKSTATION_MOCK_GATEWAY = '1';
    gw = await startFakeGateway({ key: 'sk-gw-secret-1' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-gw-'));
    const cwd = path.join(dir, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    const config = new ConfigStore(path.join(dir, 'home'));
    const inner = createMockAdapter();
    seen = [];
    const adapter: SdkAdapter = { ...inner, query: (p) => { seen.push(p.options); return inner.query(p); } };
    const s = await startServer({ host: '127.0.0.1', port: 0, config, adapter, cwd, webDist: null });
    srv = Object.assign(s, { base: `http://127.0.0.1:${s.port}`, token: config.token, dir, cwd });
  });
  afterEach(async () => { client?.close(); client = undefined; await srv.close(); await gw.stop(); delete process.env.WORKSTATION_MOCK_GATEWAY; });

  it('lists discovered models first, marked from gateway, and drops them when the base URL is cleared', async () => {
    await put({ anthropicBaseUrl: gw.url, apiKey: 'sk-gw-secret-1', customModels: ['my-custom'] });
    const list = await (await call('/api/models')).json() as Array<{ id: string; source?: string; description?: string }>;
    expect(list.slice(0, 2).map((m) => [m.id, m.source])).toEqual([['gw-fast', 'gateway'], ['gw-smart', 'gateway']]);
    expect(list.find((m) => m.id === 'gw-fast')!.description).toBe('From gateway');
    expect(list.some((m) => m.id === 'my-custom')).toBe(true);
    expect(list.some((m) => m.id === 'sonnet')).toBe(true);
    await put({ anthropicBaseUrl: '' });
    const after = await (await call('/api/models')).json() as Array<{ id: string }>;
    expect(after.some((m) => m.id === 'gw-fast')).toBe(false);
  });

  it('Test connection: OK, the provider error, unsaved values, and no saved key for another origin', async () => {
    await put({ anthropicBaseUrl: gw.url, apiKey: 'sk-gw-secret-1' });
    const test = async (body: unknown) => (await call('/api/gateway/test', { method: 'POST', body: JSON.stringify(body) })).json() as Promise<{ ok: boolean; message: string; models: string[]; model?: string }>;
    expect(await test({ model: 'gw-smart' })).toMatchObject({ ok: true, model: 'gw-smart', models: ['gw-fast', 'gw-smart'] });
    const bad = await test({ model: 'claude-sonnet-4-5' });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('model: claude-sonnet-4-5');
    // an alias goes through the (unsaved) mapping; an unmapped one is refused with an honest reason instead of guessing an id
    expect(await test({ model: 'sonnet', aliasEnv: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'gw-fast' } })).toMatchObject({ ok: true, model: 'gw-fast' });
    const unmapped = await test({ model: 'opus' });
    expect(unmapped.ok).toBe(false);
    expect(unmapped.message).toContain('alias');
    expect(unmapped.models).toEqual(['gw-fast', 'gw-smart']);
    const none = await test({ model: '' });
    expect(none.message).toContain('No model is chosen');
    // the saved key is never sent to a different origin
    const other = await startFakeGateway({ key: 'sk-gw-secret-1' });
    const r = await test({ baseUrl: other.url, model: 'gw-smart' });
    expect(r.ok).toBe(false);
    expect(other.requests.every((q) => q.headers['x-api-key'] === 'workstation-no-credential')).toBe(true);
    expect(await test({ baseUrl: other.url, apiKey: 'sk-gw-secret-1', model: 'gw-smart' })).toMatchObject({ ok: true });
    await other.stop();
    expect((await call('/api/gateway/test', { method: 'POST', body: JSON.stringify({ baseUrl: 'ftp://x' }) })).status).toBe(400);
    expect(JSON.stringify(bad)).not.toContain('sk-gw-secret-1');
  });

  it('a session uses the configured model verbatim and never falls back to an alias', async () => {
    await put({ anthropicBaseUrl: gw.url, apiKey: 'sk-gw-secret-1', defaultModel: 'gw-smart' });
    client = await connect(srv);
    const sid = await startSession(client, srv.cwd);
    expect(seen.at(-1)!.model).toBe('gw-smart');
    expect(seen.at(-1)!.env!.ANTHROPIC_BASE_URL).toBe(gw.url);
    client.send({ type: 'prompt', sessionId: sid, text: 'hello', clientMsgId: 'c1' } as never);
    await client.waitFor((m) => m.type === 'sdk' && (m.message as { type?: string }).type === 'result');
    expect(gw.modelsAsked().at(-1)).toBe('gw-smart');
    // an explicit model from the client wins; with none chosen nothing is sent (the CLI default), not "default"
    await put({ defaultModel: '' });
    const sid2 = await startSession(client, srv.cwd);
    expect(sid2).not.toBe(sid);
    expect(seen.at(-1)!.model).toBeUndefined();
    const sid3 = await startSession(client, srv.cwd, { model: 'gw-fast' });
    expect(sid3).toBeTruthy();
    expect(seen.at(-1)!.model).toBe('gw-fast');
  });

  it('model_not_found names the rejected id (once), and switching the model fixes the next turn', async () => {
    await put({ anthropicBaseUrl: gw.url, apiKey: 'sk-gw-secret-1' });
    client = await connect(srv);
    const sid = await startSession(client, srv.cwd);
    client.send({ type: 'prompt', sessionId: sid, text: 'hello', clientMsgId: 'c1' } as never);
    const err = await client.waitFor<Extract<import('@workstation/protocol').ServerMessage, { type: 'error' }>>((m) => m.type === 'error' && m.sessionId === sid);
    expect(err.code).toBe('model_not_found');
    expect(err.model).toBe('claude-sonnet-4-5');
    expect(err.message).toContain('"claude-sonnet-4-5"');
    await new Promise((r) => setTimeout(r, 200));
    expect(client.msgs.filter((m) => m.type === 'error' && m.sessionId === sid)).toHaveLength(1);
    const from = client.msgs.length;
    client.send({ type: 'set.model', sessionId: sid, model: 'gw-smart' } as never);
    client.send({ type: 'prompt', sessionId: sid, text: 'again', clientMsgId: 'c2' } as never);
    await client.waitFor((m) => m.type === 'sdk' && (m.message as { type?: string; subtype?: string }).type === 'result' && (m.message as { subtype?: string }).subtype === 'success', 8000, from);
    expect(gw.modelsAsked().at(-1)).toBe('gw-smart');
  });

  it('alias mapping is persisted in the env handed to the agent and is what the alias resolves to', async () => {
    await put({ anthropicBaseUrl: gw.url, apiKey: 'sk-gw-secret-1', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'gw-smart', ANTHROPIC_SMALL_FAST_MODEL: 'gw-fast', CLAUDE_CODE_SUBAGENT_MODEL: 'gw-fast' } });
    const cfg = await (await call('/api/config')).json() as { env?: Record<string, string> };
    expect(cfg.env).toMatchObject({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'gw-smart', ANTHROPIC_SMALL_FAST_MODEL: 'gw-fast', CLAUDE_CODE_SUBAGENT_MODEL: 'gw-fast' });
    client = await connect(srv);
    const sid = await startSession(client, srv.cwd, { model: 'sonnet' });
    expect(seen.at(-1)!.env).toMatchObject({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'gw-smart', ANTHROPIC_SMALL_FAST_MODEL: 'gw-fast', CLAUDE_CODE_SUBAGENT_MODEL: 'gw-fast' });
    client.send({ type: 'prompt', sessionId: sid, text: 'hello', clientMsgId: 'c1' } as never);
    await client.waitFor((m) => m.type === 'sdk' && (m.message as { type?: string }).type === 'result');
    expect(gw.modelsAsked().at(-1)).toBe('gw-smart');
  });
});
