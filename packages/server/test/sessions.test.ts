import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, makeServer, sdkMsgs, startSession, type TestServer } from './helpers.js';

let s: TestServer;
beforeAll(async () => { s = await makeServer(); });
afterAll(async () => { await s.close(); });

const isResult = (m: any) => m.type === 'sdk' && m.message.type === 'result';

describe('session lifecycle with mock', () => {
  it('streams a plain reply with state transitions', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    c.send({ type: 'prompt', sessionId: sid, text: 'hi', clientMsgId: 'm1' });
    await c.waitFor(isResult);
    const types = sdkMsgs(c, sid).map((m) => m.type);
    expect(types).toContain('stream_event');
    expect(types).toContain('assistant');
    expect(sdkMsgs(c, sid)[0]).toMatchObject({ type: 'user', clientMsgId: 'm1' });
    const states = c.msgs.filter((m) => m.type === 'state').map((m: any) => m.state.status);
    expect(states).toEqual(expect.arrayContaining(['idle', 'running']));
    expect(states.at(-1)).toBe('idle');
    const seqs = c.msgs.filter((m) => m.type === 'sdk').map((m: any) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    c.close();
  });

  it('permission round trip: allow with remember, deny, and AskUserQuestion/ExitPlanMode', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    // allow + remember
    c.send({ type: 'prompt', sessionId: sid, text: 'run bash', clientMsgId: 'a' });
    const req: any = await c.waitFor((m) => m.type === 'permission.request');
    expect(req).toMatchObject({ toolName: 'Bash', hasSuggestions: true });
    expect(c.msgs.filter((m) => m.type === 'state').at(-1)).toMatchObject({ state: { status: 'waiting_permission' } });
    c.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'allow', remember: true } });
    await c.waitFor(isResult);
    expect(sdkMsgs(c, sid).some((m) => m.type === 'user' && JSON.stringify(m.message).includes('Tests  20 passed'))).toBe(true);

    // deny with message
    const from = c.msgs.length;
    c.send({ type: 'prompt', sessionId: sid, text: 'edit it', clientMsgId: 'b' });
    const req2: any = await c.waitFor((m) => m.type === 'permission.request', 8000, from);
    expect(req2.toolName).toBe('Edit');
    c.send({ type: 'permission.respond', sessionId: sid, requestId: req2.requestId, decision: { behavior: 'deny', message: 'nope' } });
    await c.waitFor((m) => isResult(m) && c.msgs.indexOf(m) > from, 8000, from);
    const denied = sdkMsgs(c, sid).find((m) => m.type === 'user' && JSON.stringify(m.message).includes('"is_error":true') && JSON.stringify(m.message).includes('nope'));
    expect(denied).toBeTruthy();

    // AskUserQuestion with answers via updatedInput
    const from3 = c.msgs.length;
    c.send({ type: 'prompt', sessionId: sid, text: 'ask me', clientMsgId: 'c' });
    const req3: any = await c.waitFor((m) => m.type === 'permission.request', 8000, from3);
    expect(req3.toolName).toBe('AskUserQuestion');
    c.send({ type: 'permission.respond', sessionId: sid, requestId: req3.requestId, decision: { behavior: 'allow', updatedInput: { ...req3.input, answers: { 'Which test runner should I use?': 'vitest' } } } });
    await c.waitFor((m) => isResult(m) && c.msgs.indexOf(m) > from3, 8000, from3);
    expect(JSON.stringify(sdkMsgs(c, sid))).toContain('vitest');

    // ExitPlanMode
    const from4 = c.msgs.length;
    c.send({ type: 'prompt', sessionId: sid, text: 'make a plan', clientMsgId: 'd' });
    const req4: any = await c.waitFor((m) => m.type === 'permission.request', 8000, from4);
    expect(req4.toolName).toBe('ExitPlanMode');
    c.send({ type: 'permission.respond', sessionId: sid, requestId: req4.requestId, decision: { behavior: 'allow' } });
    await c.waitFor((m) => isResult(m) && c.msgs.indexOf(m) > from4, 8000, from4);
    c.send({ type: 'permission.respond', sessionId: sid, requestId: 'nonexistent', decision: { behavior: 'allow' } });
    await c.waitFor((m) => m.type === 'error' && /no pending/.test(m.message));
    c.close();
  });

  it('interrupt cancels pending permission and stops the turn', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    c.send({ type: 'prompt', sessionId: sid, text: 'bash please', clientMsgId: 'x' });
    const req: any = await c.waitFor((m) => m.type === 'permission.request');
    c.send({ type: 'interrupt', sessionId: sid });
    await c.waitFor((m) => m.type === 'permission.cancelled' && m.requestId === req.requestId);
    await c.waitFor((m) => m.type === 'state' && m.state.status === 'idle');
    c.close();
  });

  it('interrupts a slow streaming turn', async () => {
    process.env.WORKSTATION_MOCK_SPEED = '1';
    try {
      const c = await connect(s);
      const sid = await startSession(c, s.cwd);
      c.send({ type: 'prompt', sessionId: sid, text: 'slow', clientMsgId: 'y' });
      await c.waitFor((m) => m.type === 'sdk' && (m.message as any).type === 'stream_event');
      c.send({ type: 'interrupt', sessionId: sid });
      const r: any = await c.waitFor(isResult);
      expect(r.message.subtype).toBe('error_during_execution');
      c.close();
    } finally { process.env.WORKSTATION_MOCK_SPEED = '0'; }
  });

  it('survives disconnect; attach replays from seq; pending permission re-sent', async () => {
    const c1 = await connect(s);
    const sid = await startSession(c1, s.cwd);
    c1.send({ type: 'prompt', sessionId: sid, text: 'bash now', clientMsgId: 'r' });
    const req: any = await c1.waitFor((m) => m.type === 'permission.request');
    const lastSeq = Math.max(...c1.msgs.filter((m) => m.type === 'sdk').map((m: any) => m.seq));
    c1.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.sessions.isLive(sid)).toBe(true);

    const c2 = await connect(s);
    c2.send({ type: 'session.attach', reqId: 'att', sessionId: sid, fromSeq: lastSeq });
    const ack: any = await c2.waitFor((m) => m.type === 'ack' && m.reqId === 'att');
    expect(ack.data).toMatchObject({ sessionId: sid, replayed: 0, truncated: false });
    expect(ack.data.state.status).toBe('waiting_permission');
    const again: any = await c2.waitFor((m) => m.type === 'permission.request');
    expect(again.requestId).toBe(req.requestId);
    c2.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'allow' } });
    await c2.waitFor(isResult);
    const live = sdkMsgs(c2, sid);
    expect(live.length).toBeGreaterThan(0);

    // full replay for a third client
    const c3 = await connect(s);
    c3.send({ type: 'session.attach', reqId: 'full', sessionId: sid });
    const ack3: any = await c3.waitFor((m) => m.type === 'ack' && m.reqId === 'full');
    expect(ack3.data.replayed).toBeGreaterThan(3);
    await c3.waitFor((m) => isResult(m));
    expect(sdkMsgs(c3, sid).some((m) => m.type === 'stream_event')).toBe(false); // compacted away after completion
    c2.close(); c3.close();

    const c4 = await connect(s);
    c4.send({ type: 'session.attach', reqId: 'bad', sessionId: 'does-not-exist' });
    await c4.waitFor((m) => m.type === 'error' && m.reqId === 'bad');
    c4.close();
  });

  it('set.* messages, rewind, mcp, images, close', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd, { model: 'sonnet', permissionMode: 'acceptEdits', effort: 'low' });
    expect(c.msgs.find((m) => m.type === 'session.started')).toBeTruthy();
    c.send({ type: 'set.model', sessionId: sid, model: 'opus' });
    await c.waitFor((m) => m.type === 'state' && m.state.model === 'opus');
    c.send({ type: 'set.permissionMode', sessionId: sid, mode: 'plan' });
    await c.waitFor((m) => m.type === 'state' && m.state.permissionMode === 'plan');
    c.send({ type: 'set.effort', sessionId: sid, effort: 'high' });
    await c.waitFor((m) => m.type === 'state' && m.state.effort === 'high');
    c.send({ type: 'set.permissionMode', sessionId: sid, mode: 'bogus' as any });
    await c.waitFor((m) => m.type === 'error' && /invalid permission mode/.test(m.message));

    c.send({ type: 'prompt', sessionId: sid, text: 'look at this', clientMsgId: 'img', images: [{ mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', name: 'a.png' }] });
    await c.waitFor(isResult);
    expect(JSON.stringify(sdkMsgs(c, sid))).toContain('I can see 1 attached image');
    const userEcho = sdkMsgs(c, sid).find((m) => m.type === 'user' && m.clientMsgId === 'img')!;
    c.send({ type: 'prompt', sessionId: sid, text: 'x', clientMsgId: 'bad', images: [{ mediaType: 'text/html', dataBase64: 'AAAA' }] });
    await c.waitFor((m) => m.type === 'error' && /unsupported image/.test(m.message));

    c.send({ type: 'rewind', sessionId: sid, reqId: 'rw', userMessageId: userEcho.uuid, dryRun: true });
    const rw: any = await c.waitFor((m) => m.type === 'ack' && m.reqId === 'rw');
    expect(rw.data.canRewind).toBe(true);
    c.send({ type: 'mcp.toggle', sessionId: sid, server: 'docs', enabled: false });
    const mcp: any = await c.waitFor((m) => m.type === 'ack' && String(m.reqId).startsWith('mcp:'));
    expect(mcp.data.mcpServers.find((x: any) => x.name === 'docs').status).toBe('disabled');
    c.send({ type: 'mcp.reconnect', sessionId: sid, server: 'nope' });
    await c.waitFor((m) => m.type === 'error' && /Unknown MCP/.test(m.message));

    c.send({ type: 'session.close', sessionId: sid });
    await c.waitFor((m) => m.type === 'session.ended');
    expect(s.sessions.isLive(sid)).toBe(false);
    c.send({ type: 'prompt', sessionId: sid, text: 'x', clientMsgId: 'z' });
    await c.waitFor((m) => m.type === 'error' && /no live session/.test(m.message));
    c.send({ type: 'ping' });
    await c.waitFor((m) => m.type === 'pong');
    c.close();
  });

  it('runs the full demo tour and runs sessions concurrently', async () => {
    const c = await connect(s);
    const [a, b] = [await startSession(c, s.cwd), await startSession(c, s.cwd)];
    expect(a).not.toBe(b);
    c.send({ type: 'prompt', sessionId: a, text: 'demo', clientMsgId: 'da' });
    c.send({ type: 'prompt', sessionId: b, text: 'hello', clientMsgId: 'db' });
    const seenTools = new Set<string>();
    const answered = new Set<string>();
    const deadline = Date.now() + 15000;
    let results = 0;
    while (results < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      for (const m of c.msgs as any[]) {
        if (m.type === 'permission.request' && !answered.has(m.requestId)) {
          answered.add(m.requestId); seenTools.add(m.toolName);
          c.send({ type: 'permission.respond', sessionId: m.sessionId, requestId: m.requestId, decision: { behavior: 'allow' } });
        }
      }
      results = c.msgs.filter(isResult).length;
    }
    expect(results).toBe(2);
    expect([...seenTools].sort()).toEqual(['Bash', 'Edit', 'Write', 'WebFetch'].sort());
    const blocks = JSON.stringify(sdkMsgs(c, a));
    for (const t of ['TodoWrite', 'Read', 'Grep', 'Glob', 'Task', 'WebSearch', 'thinking', 'task_started']) expect(blocks).toContain(t);
    expect(sdkMsgs(c, a).some((m) => m.parent_tool_use_id)).toBe(true);
    c.close();
  });

  it('bypassPermissions skips prompts', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd, { permissionMode: 'bypassPermissions' });
    c.send({ type: 'prompt', sessionId: sid, text: 'bash', clientMsgId: 'q' });
    await c.waitFor(isResult);
    expect(c.msgs.some((m) => m.type === 'permission.request')).toBe(false);
    c.close();
  });

  it('resume of a live session attaches; invalid cwd errors', async () => {
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    c.send({ type: 'session.start', reqId: 'res', cwd: s.cwd, resume: sid });
    await c.waitFor((m) => m.type === 'ack' && m.reqId === 'res');
    c.send({ type: 'session.start', reqId: 'bad', cwd: '/definitely/not/here' });
    await c.waitFor((m) => m.type === 'error' && m.reqId === 'bad');
    c.close();
  });
});
