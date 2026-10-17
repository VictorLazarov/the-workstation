import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContextUsage } from '@workstation/protocol';
import { normalizeContextUsage } from '../src/context-usage.js';
import { api, connect, makeServer, startSession, type TestServer } from './helpers.js';

describe('normalizeContextUsage', () => {
  it('keeps the rendered fields, drops gridRows, and survives missing optional data', () => {
    const raw = {
      categories: [
        { name: 'Messages', tokens: 1200, color: 'x', kind: 'used' },
        { name: 'Free space', tokens: 98000, color: 'y', kind: 'free' },
        { name: 'Autocompact buffer', tokens: 33000, color: 'z', kind: 'buffer' },
        { name: 'Some tool', tokens: 500, color: 'z', kind: 'deferred', isDeferred: true },
      ],
      totalTokens: 1200, maxTokens: 200000, rawMaxTokens: 200000, percentage: 0.6, model: 'claude-x',
      gridRows: [[{ color: 'x', isFilled: true, categoryName: 'Messages', tokens: 1, percentage: 1, squareFullness: 1 }]],
      memoryFiles: [], mcpTools: [{ name: 'mcp__gh__list', serverName: 'gh', tokens: 90, isLoaded: true }], agents: [], isAutoCompactEnabled: true, autoCompactThreshold: 167000,
      apiUsage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
    };
    const u = normalizeContextUsage(raw, 'full');
    expect(u).toMatchObject({ source: 'sdk', detail: 'full', totalTokens: 1200, maxTokens: 200000, percentage: 0.6, model: 'claude-x', isAutoCompactEnabled: true, autoCompactThreshold: 167000 });
    expect(u.categories.map((c) => c.kind)).toEqual(['used', 'free', 'buffer', 'deferred']);
    expect(u.mcpTools).toEqual([{ name: 'mcp__gh__list', serverName: 'gh', tokens: 90, isLoaded: true }]);
    expect(JSON.stringify(u)).not.toContain('gridRows');
    const bare = normalizeContextUsage({ totalTokens: 10, maxTokens: 100 }, 'summary');
    expect(bare).toMatchObject({ percentage: 10, categories: [], mcpTools: [], apiUsage: null, rawMaxTokens: 100 });
  });
  it('classifies rows by name when an older CLI omits `kind`', () => {
    const u = normalizeContextUsage({ categories: [{ name: 'Free space', tokens: 1, color: '' }, { name: 'Autocompact buffer', tokens: 1, color: '' }, { name: 'Messages', tokens: 1, color: '' }] }, 'full');
    expect(u.categories.map((c) => c.kind)).toEqual(['free', 'buffer', 'used']);
  });
});

describe('context usage over the wire (mock agent)', () => {
  let s: TestServer;
  beforeAll(async () => { s = await makeServer(); });
  afterAll(async () => { await s.close(); });
  const isResult = (m: any) => m.type === 'sdk' && m.message.type === 'result';

  it('WS context.usage acks the breakdown and grows after a turn', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    const ask = async (detail?: 'summary' | 'full') => {
      const reqId = Math.random().toString(36).slice(2);
      c.send({ type: 'context.usage', reqId, sessionId: sid, ...(detail ? { detail } : {}) });
      const ack = await c.waitFor<any>((m) => m.type === 'ack' && m.reqId === reqId);
      return ack.data as ContextUsage;
    };
    const before = await ask();
    expect(before).toMatchObject({ source: 'mock', detail: 'full', maxTokens: 200000 });
    expect(before.categories.find((x) => x.name === 'Messages')?.kind).toBe('used');
    expect(before.categories.some((x) => x.kind === 'free')).toBe(true);
    expect(before.categories.some((x) => x.kind === 'buffer')).toBe(true);
    expect(before.mcpTools.length).toBeGreaterThan(0);
    expect(JSON.stringify(before)).not.toContain('gridRows');
    c.send({ type: 'prompt', sessionId: sid, text: 'hello there', clientMsgId: 'ctx1' });
    await c.waitFor(isResult);
    const after = await ask('summary');
    expect(after.detail).toBe('summary');
    expect(after.totalTokens).toBeGreaterThan(before.totalTokens);
    c.close();
  });

  it('WS context.usage for an unknown session is an error tied to the request', async () => {
    const c = await connect(s);
    c.send({ type: 'context.usage', reqId: 'nope1', sessionId: 'does-not-exist' });
    const err = await c.waitFor<any>((m) => m.type === 'error' && m.reqId === 'nope1');
    expect(err.message).toMatch(/no live session/);
    c.close();
  });

  it('REST GET /api/sessions/:id/context mirrors it, validates detail, and 404s for sessions that are not live', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    const ok = await api(s, `/api/sessions/${sid}/context?detail=summary`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ source: 'mock', detail: 'summary', maxTokens: 200000 });
    expect((await api(s, `/api/sessions/${sid}/context?detail=banana`)).status).toBe(400);
    expect((await api(s, '/api/sessions/not-live/context')).status).toBe(404);
    expect((await api(s, `/api/sessions/${sid}/context`, {}, null)).status).toBe(401);
    c.close();
  });
});

describe('task.stop (mock agent)', () => {
  let s: TestServer;
  beforeAll(async () => { s = await makeServer(); });
  afterAll(async () => { await s.close(); });
  it('acks a stop request and rejects a missing task id or session', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    c.send({ type: 'task.stop', reqId: 't1', sessionId: sid, taskId: 'task_1' });
    expect((await c.waitFor<any>((m) => m.type === 'ack' && m.reqId === 't1')).data).toEqual({ stopped: true });
    c.send({ type: 'task.stop', reqId: 't2', sessionId: sid, taskId: '' });
    expect((await c.waitFor<any>((m) => m.type === 'error' && m.reqId === 't2')).message).toMatch(/taskId/);
    c.send({ type: 'task.stop', reqId: 't3', sessionId: 'ghost', taskId: 'x' });
    expect((await c.waitFor<any>((m) => m.type === 'error' && m.reqId === 't3')).message).toMatch(/no live session/);
    c.close();
  });
});
