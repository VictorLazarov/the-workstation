/**
 * Integration tests against the REAL Claude Agent SDK / CLI. Skipped unless REAL_SDK=1 (they make real, tiny API calls
 * with claude-haiku-5-5):   REAL_SDK=1 npx vitest run test/real-sdk.test.ts
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@workstation/protocol';
import { isResult, makeRig, MODEL, Collector, type Rig } from '../scripts/real-harness.js';
import { createRealAdapter } from '../src/sdk.js';
import { SessionManager } from '../src/session-manager.js';
import { Catalog } from '../src/catalog.js';

const T = 150_000;
const rigs: Rig[] = [];
const rig = (...a: Parameters<typeof makeRig>) => { const r = makeRig(...a); rigs.push(r); return r; };
afterEach(() => { for (const r of rigs.splice(0)) r.cleanup(); });

const permReq = (from = 0) => (m: ServerMessage, i?: number) => m.type === 'permission.request';
const errors = (r: Rig) => r.sub.msgs.filter((m) => m.type === 'error') as Array<Extract<ServerMessage, { type: 'error' }>>;
const ask = (r: Rig, sid: string, text: string) => r.send({ type: 'prompt', sessionId: sid, text, clientMsgId: Math.random().toString(36).slice(2) });

function pngRed(): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let x = 0xffffffff; for (const v of b) x = table[(x ^ v) & 255]! ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(type), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 8 }, () => [255, 0, 0]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: 8 }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

describe.skipIf(!process.env.REAL_SDK)('real SDK', () => {
  it('context.usage: returns the SDK breakdown (categories, window, free space) and grows after a turn', async () => {
    const r = rig();
    const sid = await r.start();
    const get = async (detail: 'summary' | 'full') => {
      const reqId = Math.random().toString(36).slice(2);
      const mark = r.sub.mark();
      await r.send({ type: 'context.usage', reqId, sessionId: sid, detail });
      const ack = await r.sub.waitFor<Extract<ServerMessage, { type: 'ack' }>>((m) => m.type === 'ack' && m.reqId === reqId, 60_000, mark);
      return ack.data as import('@workstation/protocol').ContextUsage;
    };
    const before = await get('full');
    expect(before.source).toBe('sdk');
    expect(before.maxTokens).toBeGreaterThan(10_000);
    expect(before.categories.some((c) => c.kind === 'used' && c.tokens > 0)).toBe(true);
    expect(before.categories.some((c) => c.kind === 'free')).toBe(true);
    expect(JSON.stringify(before)).not.toContain('gridRows');
    await ask(r, sid, 'Reply with exactly the word: pong');
    await r.sub.waitFor(isResult);
    const after = await get('summary');
    expect(after.totalTokens).toBeGreaterThan(0);
    expect(after.percentage).toBeGreaterThan(0);
  }, T);

  it('AskUserQuestion: answers go in updatedInput.answers keyed by question text', async () => {
    const r = rig();
    const sid = await r.start();
    await ask(r, sid, 'Use the AskUserQuestion tool now to ask "Which color?" (header "Color", options Red and Blue, single select). Then reply with only the color I chose.');
    const req = await r.sub.waitFor<Extract<ServerMessage, { type: 'permission.request' }>>(permReq());
    expect(req.toolName).toBe('AskUserQuestion');
    const q = (req.input.questions as Array<{ question: string }>)[0]!;
    await r.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'allow', updatedInput: { ...req.input, answers: { [q.question]: 'Blue' } } } });
    const res = await r.sub.waitFor(isResult);
    expect(JSON.stringify(r.sub.sdk())).toContain(`\\"${q.question}\\"=\\"Blue\\"`);
    expect(String((res as any).message.result)).toMatch(/blue/i);
  }, T);

  it('ExitPlanMode: deny keeps planning; allow+setMode leaves plan mode without a further prompt', async () => {
    const r = rig();
    const sid = await r.start({ permissionMode: 'plan' });
    await ask(r, sid, 'Plan mode. Immediately call ExitPlanMode with a 2-line plan to create hello.txt containing "hi" (no exploration). After approval create it.');
    const req = await r.sub.waitFor<Extract<ServerMessage, { type: 'permission.request' }>>(permReq());
    expect(req.toolName).toBe('ExitPlanMode');
    expect(typeof req.input.plan).toBe('string');
    // keep planning: deny with feedback -> still plan mode, model re-proposes
    await r.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'deny', message: 'Also mention bye.txt in the plan' } });
    const req2 = await r.sub.waitFor<Extract<ServerMessage, { type: 'permission.request' }>>((m) => m.type === 'permission.request' && m.requestId !== req.requestId);
    expect(req2.toolName).toBe('ExitPlanMode');
    expect(r.mgr.get(sid)!.permissionMode).toBe('plan');
    // approve + auto-accept edits
    await r.send({ type: 'permission.respond', sessionId: sid, requestId: req2.requestId, decision: { behavior: 'allow', setMode: 'acceptEdits' } });
    await r.sub.waitFor(isResult);
    expect(r.mgr.get(sid)!.permissionMode).toBe('acceptEdits');
    expect(r.sub.msgs.filter((m) => m.type === 'permission.request')).toHaveLength(2); // the Write was not prompted
    expect(fs.existsSync(path.join(r.cwd, 'hello.txt'))).toBe(true);
  }, T);

  it('plain approve (no setMode) returns to the previous mode and the manager follows it', async () => {
    const r = rig();
    const sid = await r.start({ permissionMode: 'plan' });
    await ask(r, sid, 'Plan mode. Immediately call ExitPlanMode with a one-line plan to create a.txt. After approval, create it.');
    const req = await r.sub.waitFor<Extract<ServerMessage, { type: 'permission.request' }>>(permReq());
    await r.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'allow' } });
    const write = await r.sub.waitFor<Extract<ServerMessage, { type: 'permission.request' }>>((m) => m.type === 'permission.request' && m.requestId !== req.requestId);
    expect(r.mgr.get(sid)!.permissionMode).toBe('default');
    expect(r.sub.msgs.filter((m) => m.type === 'state').map((m: any) => m.state.permissionMode)).toContain('default');
    await r.send({ type: 'permission.respond', sessionId: sid, requestId: write.requestId, decision: { behavior: 'deny' } });
    await r.sub.waitFor(isResult);
  }, T);

  it('remember persists a rule (listed in state), skips the setMode suggestion, and stops prompting', async () => {
    const r = rig();
    const sid = await r.start();
    await ask(r, sid, 'Run the bash command `touch f1.txt` with the Bash tool. Nothing else.');
    const req = await r.sub.waitFor<Extract<ServerMessage, { type: 'permission.request' }>>(permReq());
    expect(req.hasSuggestions).toBe(true);
    expect(Array.isArray(req.suggestions)).toBe(true);
    await r.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'allow', remember: true } });
    await r.sub.waitFor(isResult);
    const st = r.mgr.runtimeState(r.mgr.get(sid)!);
    expect(st.permissionMode).toBe('default'); // not switched to acceptEdits
    expect(st.rules).toEqual([{ toolName: 'Bash', ruleContent: 'touch f1.txt', behavior: 'allow', destination: 'localSettings' }]);
    expect(fs.readFileSync(path.join(r.cwd, '.claude', 'settings.local.json'), 'utf8')).toContain('Bash(touch f1.txt)');
    const mark = r.sub.mark();
    await ask(r, sid, 'Run the bash command `touch f1.txt` again with the Bash tool. Nothing else.');
    await r.sub.waitFor(isResult, 90_000, mark);
    expect(r.sub.msgs.slice(mark).some((m) => m.type === 'permission.request')).toBe(false);
  }, T);

  it('remember:"session" keeps the rule in memory only', async () => {
    const r = rig();
    const sid = await r.start();
    await ask(r, sid, 'Run the bash command `touch s1.txt` with the Bash tool. Nothing else.');
    const req = await r.sub.waitFor<Extract<ServerMessage, { type: 'permission.request' }>>(permReq());
    await r.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'allow', remember: 'session' } });
    await r.sub.waitFor(isResult);
    expect(r.mgr.runtimeState(r.mgr.get(sid)!).rules?.[0]).toMatchObject({ toolName: 'Bash', destination: 'session' });
    expect(fs.existsSync(path.join(r.cwd, '.claude', 'settings.local.json'))).toBe(false);
    const mark = r.sub.mark();
    await ask(r, sid, 'Run the bash command `touch s1.txt` again with the Bash tool. Nothing else.');
    await r.sub.waitFor(isResult, 90_000, mark);
    expect(r.sub.msgs.slice(mark).some((m) => m.type === 'permission.request')).toBe(false);
  }, T);

  it('interrupt mid-turn and mid-permission; session stays usable; set.model / permissionMode(bypass) / effort', async () => {
    const r = rig();
    const sid = await r.start();
    let mark = r.sub.mark();
    await ask(r, sid, 'Write a 600 word story about a cat.');
    await r.sub.waitFor((m) => m.type === 'sdk' && (m.message as any).type === 'stream_event', 60_000, mark);
    await r.send({ type: 'interrupt', sessionId: sid });
    await r.sub.waitFor(isResult, 30_000, mark);
    expect(r.mgr.runtimeState(r.mgr.get(sid)!).status).toBe('idle');

    mark = r.sub.mark();
    await ask(r, sid, 'Run the bash command `touch b.txt` with the Bash tool. Nothing else.');
    await r.sub.waitFor(permReq(), 60_000, mark);
    await r.send({ type: 'interrupt', sessionId: sid });
    await r.sub.waitFor(isResult, 30_000, mark);
    expect(r.sub.msgs.slice(mark).some((m) => m.type === 'permission.cancelled')).toBe(true);
    expect(r.mgr.runtimeState(r.mgr.get(sid)!).status).toBe('idle');
    expect(fs.existsSync(path.join(r.cwd, 'b.txt'))).toBe(false);

    await r.send({ type: 'set.model', sessionId: sid, model: 'claude-sonnet-5-5' });
    await r.send({ type: 'set.permissionMode', sessionId: sid, mode: 'bypassPermissions' });
    await r.send({ type: 'set.effort', sessionId: sid, effort: 'low' });
    expect(errors(r)).toHaveLength(0);
    expect(r.mgr.runtimeState(r.mgr.get(sid)!)).toMatchObject({ model: 'claude-sonnet-5-5', permissionMode: 'bypassPermissions', effort: 'low' });
    mark = r.sub.mark();
    await ask(r, sid, 'Run the bash command `touch d.txt` with the Bash tool, then reply done.');
    const res: any = await r.sub.waitFor((m) => isResult(m) || m.type === 'permission.request', 90_000, mark);
    expect(res.type).toBe('sdk');
    expect(Object.keys(res.message.modelUsage ?? {})).toContain('claude-sonnet-5-5');
    expect(fs.existsSync(path.join(r.cwd, 'd.txt'))).toBe(true);
  }, 280_000);

  it('image prompts reach the model; stdio MCP server toggle / reconnect / tool call', async () => {
    const r = rig();
    fs.mkdirSync(path.join(r.cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(r.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { mini: { command: 'node', args: [path.resolve(__dirname, '../scripts/mini-mcp.mjs')] } } }));
    fs.writeFileSync(path.join(r.cwd, '.claude/settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
    const sid = await r.start();
    const status = async () => ((await r.mgr.get(sid)!.query.mcpServerStatus()) as Array<{ name: string; status: string }>).find((x) => x.name === 'mini')?.status;
    for (let i = 0; i < 20 && (await status()) !== 'connected'; i++) await new Promise((x) => setTimeout(x, 500));
    expect(await status()).toBe('connected');
    const acks = () => r.sub.msgs.filter((m) => m.type === 'ack' && String((m as any).reqId).startsWith('mcp:')) as any[];
    await r.send({ type: 'mcp.toggle', sessionId: sid, server: 'mini', enabled: false });
    expect(acks().at(-1).data.mcpServers.find((x: any) => x.name === 'mini').status).toBe('disabled');
    await r.send({ type: 'mcp.toggle', sessionId: sid, server: 'mini', enabled: true });
    expect(acks().at(-1).data.mcpServers.find((x: any) => x.name === 'mini').status).toBe('connected');
    await r.send({ type: 'mcp.reconnect', sessionId: sid, server: 'mini' });
    expect(acks().at(-1).data.mcpServers.find((x: any) => x.name === 'mini').status).toBe('connected');

    let mark = r.sub.mark();
    await r.send({ type: 'prompt', sessionId: sid, text: 'What single color is this image? One word.', images: [{ mediaType: 'image/png', dataBase64: pngRed().toString('base64'), name: 'red.png' }], clientMsgId: 'img' });
    const img: any = await r.sub.waitFor(isResult, 60_000, mark);
    expect(String(img.message.result)).toMatch(/red/i);

    mark = r.sub.mark();
    await ask(r, sid, 'Call the ping tool of the mini MCP server and tell me its output.');
    const p: any = await r.sub.waitFor(permReq(), 60_000, mark);
    expect(p.toolName).toBe('mcp__mini__ping');
    await r.send({ type: 'permission.respond', sessionId: sid, requestId: p.requestId, decision: { behavior: 'allow' } });
    const done: any = await r.sub.waitFor(isResult, 60_000, mark);
    expect(String(done.message.result)).toContain('pong-42');
  }, 280_000);

  it('lifecycle: close, resume after "server restart", fork', async () => {
    const r = rig();
    const sid = await r.start();
    await ask(r, sid, 'Remember the secret word: banana. Reply "noted".');
    await r.sub.waitFor(isResult);
    r.mgr.closeAll();
    expect(r.mgr.isLive(sid)).toBe(false);
    expect(r.sub.msgs.some((m) => m.type === 'session.ended')).toBe(true);
    const ad = createRealAdapter();
    expect((await ad.listSessions({ dir: r.cwd })).map((s) => s.sessionId)).toContain(sid);
    expect((await ad.getSessionMessages(sid, { dir: r.cwd })).length).toBeGreaterThanOrEqual(2);

    const mgr2 = new SessionManager(ad, r.config, r.cwd);
    const sub2 = new Collector();
    try {
      await mgr2.handle(sub2, { type: 'session.start', reqId: 'r1', cwd: r.cwd, resume: sid, model: MODEL });
      await sub2.waitFor((m) => m.type === 'session.started' && m.sessionId === sid);
      await mgr2.handle(sub2, { type: 'prompt', sessionId: sid, text: 'What was the secret word? One word.', clientMsgId: 'b' });
      expect(String(((await sub2.waitFor(isResult)) as any).message.result)).toMatch(/banana/i);

      await mgr2.handle(sub2, { type: 'session.start', reqId: 'f1', cwd: r.cwd, resume: sid, fork: true, model: MODEL });
      const fk: any = await sub2.waitFor((m) => m.type === 'session.started' && m.reqId === 'f1');
      expect(fk.sessionId).not.toBe(sid);
      const mark = sub2.mark();
      await mgr2.handle(sub2, { type: 'prompt', sessionId: fk.sessionId, text: 'What was the secret word? One word.', clientMsgId: 'c' });
      const r2: any = await sub2.waitFor((m) => isResult(m) && (m as any).sessionId === fk.sessionId, 90_000, mark);
      expect(String(r2.message.result)).toMatch(/banana/i);
      expect((await ad.listSessions({ dir: r.cwd })).map((s) => s.sessionId)).toEqual(expect.arrayContaining([sid, fk.sessionId]));
    } finally { mgr2.closeAll(); }
  }, 280_000);

  it('resuming an unknown session fails cleanly (no zombie session)', async () => {
    const r = rig();
    await expect(r.start({ resume: '11111111-2222-3333-4444-555555555555' })).rejects.toThrow(/No conversation found/);
    expect(r.mgr.list()).toHaveLength(0);
  }, T);

  it('worktree sessions: created, registered, cleanup refuses dirty and force removes', async () => {
    const r = rig();
    const sh = (c: string) => execSync(c, { cwd: r.cwd, encoding: 'utf8' });
    sh('git init -q -b main && git -c user.email=a@b -c user.name=n commit -q --allow-empty -m init');
    const sid = await r.start({ worktree: true, permissionMode: 'bypassPermissions' });
    const s = r.mgr.get(sid)!;
    expect(s.cwd).toContain(path.join('.claude', 'worktrees'));
    expect(r.mgr.worktrees.get(sid)).toMatchObject({ branch: s.worktree!.branch });
    await ask(r, sid, 'Create a file wt.txt containing "w" in the cwd. Reply done.');
    await r.sub.waitFor(isResult);
    expect(fs.existsSync(path.join(s.cwd, 'wt.txt'))).toBe(true);
    expect(fs.existsSync(path.join(r.cwd, 'wt.txt'))).toBe(false);
    const dirty = await r.mgr.removeSessionWorktree(sid, false);
    expect(dirty).toMatchObject({ removed: false, reason: expect.stringMatching(/uncommitted/) });
    expect(fs.existsSync(s.cwd)).toBe(true);
    const forced = await r.mgr.removeSessionWorktree(sid, true);
    expect(forced).toMatchObject({ removed: true, branchDeleted: true });
    expect(sh('git worktree list').trim().split('\n')).toHaveLength(1);
  }, T);

  it('provider env reaches the CLI: base URL path + x-api-key; 401 surfaces authentication_failed and stops retrying', async () => {
    const seen: Array<{ url?: string; key?: string | string[]; auth?: string }> = [];
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push({ url: req.url, key: req.headers['x-api-key'], auth: req.headers.authorization });
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      });
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
    try {
      const r = rig({ config: { anthropicBaseUrl: `http://127.0.0.1:${(srv.address() as any).port}`, apiKey: 'sk-fake-123' } });
      const sid = await r.start();
      await ask(r, sid, 'hi');
      await r.sub.waitFor(isResult, 60_000);
      const apiCalls = seen.filter((x) => x.url?.startsWith('/v1/messages'));
      expect(apiCalls.length).toBeGreaterThanOrEqual(1);
      expect(apiCalls.length).toBeLessThan(4); // not the CLI's 10-retry loop
      expect(apiCalls[0]).toMatchObject({ url: '/v1/messages?beta=true', key: 'sk-fake-123' });
      expect(seen.every((x) => !x.auth)).toBe(true); // no inherited OAuth/session credential leaked to the third party
      expect(errors(r)[0]).toMatchObject({ code: 'authentication_failed', sessionId: sid });
      expect(r.mgr.runtimeState(r.mgr.get(sid)!).status).toBe('idle');
    } finally { srv.close(); }
  }, T);

  it('unknown model -> model_not_found error event; queued prompts do not leave the session stuck "running"', async () => {
    const r = rig();
    const bad = await r.start({ model: 'claude-nope-9' });
    await ask(r, bad, 'hi');
    await r.sub.waitFor(isResult, 60_000);
    expect(errors(r).some((e) => e.code === 'model_not_found')).toBe(true);
    expect(r.mgr.runtimeState(r.mgr.get(bad)!).status).toBe('idle');

    const sid = await r.start();
    for (const w of ['one', 'two', 'three']) await ask(r, sid, `Reply with exactly: ${w}`);
    for (let i = 0; i < 80 && !(r.mgr.get(sid)!.inflight.size === 0 && r.sub.sdk(sid).some((m) => m.type === 'result')); i++) await new Promise((x) => setTimeout(x, 1000));
    await new Promise((x) => setTimeout(x, 500));
    expect(r.mgr.get(sid)!.inflight.size).toBe(0);
    expect(r.mgr.runtimeState(r.mgr.get(sid)!).status).toBe('idle');
  }, 280_000);

  it('CLI process crash ends the session with an error event', async () => {
    const r = rig();
    const sid = await r.start();
    await ask(r, sid, 'Write a 400 word story about a cat.');
    await r.sub.waitFor((m) => m.type === 'sdk' && (m.message as any).type === 'stream_event', 60_000);
    // kill the CLI child process(es) of this test process
    const kids = execSync(`pgrep -P ${process.pid} || true`, { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(kids.length).toBeGreaterThan(0);
    for (const k of kids) { try { process.kill(Number(k), 'SIGKILL'); } catch { /* gone */ } }
    await r.sub.waitFor((m) => m.type === 'session.ended', 30_000);
    expect(errors(r).some((e) => e.code === 'process_exited')).toBe(true);
    expect(r.mgr.isLive(sid)).toBe(false);
  }, T);

  it('catalog lists models and commands from a real probe', async () => {
    const r = rig();
    const cat = new Catalog((r.mgr as any).adapter, r.config, r.mgr, r.cwd);
    const models = await cat.getModels();
    expect(models.map((m) => m.id)).toEqual(expect.arrayContaining(['default']));
    expect((await cat.getCommands(r.cwd)).length).toBeGreaterThan(5);
  }, T);
});
