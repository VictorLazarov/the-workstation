// M3 (scrutiniser pass 1): concurrent session.start{resume} for the same id must yield ONE live CLI process that both
// clients are attached to; closing it leaves nothing running. Also: the live-session cap.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@workstation/protocol';
import { startServer } from '../src/app.js';
import { ConfigStore } from '../src/config.js';
import { createMockAdapter } from '../src/mock.js';
import type { QueryHandle, SdkAdapter } from '../src/sdk.js';
import { connect, startSession, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); delete process.env.WORKSTATION_MAX_SESSIONS; });

async function rig() {
  const inner = createMockAdapter();
  const handles: Array<{ id: string; closed: boolean }> = [];
  const adapter: SdkAdapter = {
    ...inner,
    mock: true,
    listSessions: inner.listSessions.bind(inner), getSessionMessages: inner.getSessionMessages.bind(inner),
    renameSession: inner.renameSession.bind(inner), deleteSession: inner.deleteSession.bind(inner),
    query(params) {
      const q = inner.query(params) as QueryHandle;
      const rec = { id: String(params.options.resume ?? params.options.sessionId), closed: false };
      handles.push(rec);
      const close = q.close.bind(q);
      q.close = () => { rec.closed = true; close(); };
      return q;
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-conc-'));
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const config = new ConfigStore(path.join(dir, 'home'));
  const s = await startServer({ host: '127.0.0.1', port: 0, config, adapter, cwd, webDist: null });
  const ts = Object.assign(s, { base: `http://127.0.0.1:${s.port}`, token: config.token, dir, cwd }) as TestServer;
  servers.push(ts);
  return { s: ts, handles };
}
const forReq = (reqId: string) => (m: ServerMessage) => ('reqId' in m && m.reqId === reqId) && (m.type === 'session.started' || m.type === 'ack' || m.type === 'error');

describe('concurrent resume (M3)', () => {
  it('two clients resuming the same closed session get one live process', async () => {
    const { s, handles } = await rig();
    const a = await connect(s);
    const id = await startSession(a, s.cwd);
    a.send({ type: 'session.close', sessionId: id });
    await new Promise((r) => setTimeout(r, 200));
    expect(s.sessions.list()).toHaveLength(0);

    const [b, c] = await Promise.all([connect(s), connect(s)]);
    b.send({ type: 'session.start', reqId: 'rb', cwd: s.cwd, resume: id });
    c.send({ type: 'session.start', reqId: 'rc', cwd: s.cwd, resume: id });
    const [rb, rc] = await Promise.all([b.waitFor(forReq('rb')), c.waitFor(forReq('rc'))]);
    expect(rb.type).not.toBe('error');
    expect(rc.type).not.toBe('error');
    expect(s.sessions.list().map((x) => x.id)).toEqual([id]);
    const live = handles.filter((h) => h.id === id && !h.closed);
    expect(live).toHaveLength(1); // the bug: 2 (one orphaned)
    expect(s.sessions.get(id)!.subs.size).toBe(2);

    // closing from one client ends the only process; nothing keeps running unreachable
    b.send({ type: 'session.close', sessionId: id });
    await new Promise((r) => setTimeout(r, 200));
    expect(s.sessions.list()).toHaveLength(0);
    expect(handles.filter((h) => !h.closed)).toHaveLength(0);
    for (const x of [a, b, c]) x.ws.close();
  });

  it('a failing start is reported to every waiting client', async () => {
    const { s } = await rig();
    const [b, c] = await Promise.all([connect(s), connect(s)]);
    b.send({ type: 'session.start', reqId: 'rb', cwd: path.join(s.cwd, 'missing'), resume: 'abc' });
    c.send({ type: 'session.start', reqId: 'rc', cwd: path.join(s.cwd, 'missing'), resume: 'abc' });
    const [rb, rc] = await Promise.all([b.waitFor(forReq('rb')), c.waitFor(forReq('rc'))]);
    expect(rb.type).toBe('error');
    expect(rc.type).toBe('error');
    expect(s.sessions.list()).toHaveLength(0);
    b.ws.close(); c.ws.close();
  });
});

describe('live session cap', () => {
  it('refuses new sessions beyond WORKSTATION_MAX_SESSIONS', async () => {
    process.env.WORKSTATION_MAX_SESSIONS = '2';
    const { s } = await rig();
    const a = await connect(s);
    await startSession(a, s.cwd);
    await startSession(a, s.cwd);
    a.send({ type: 'session.start', reqId: 'r3', cwd: s.cwd });
    const r = await a.waitFor(forReq('r3'));
    expect(r.type).toBe('error');
    expect((r as Extract<ServerMessage, { type: 'error' }>).message).toMatch(/too many live sessions/);
    expect((r as Extract<ServerMessage, { type: 'error' }>).code).toBe('session_limit'); // the UI offers "Close idle sessions" for this code
    expect(s.sessions.list()).toHaveLength(2);
    a.ws.close();
  });
});
