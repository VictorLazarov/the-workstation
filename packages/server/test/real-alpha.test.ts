/**
 * Real-SDK checks for the alpha features (worktree UI contract, MCP status, subagent stop, rewind, remembered rules, model switch).
 * Skipped unless REAL_SDK=1:  REAL_SDK=1 npx vitest run test/real-alpha.test.ts   (haiku, a few cents; one short sonnet turn)
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@workstation/protocol';
import { isResult, makeRig, type Rig } from '../scripts/real-harness.js';
import { createRealAdapter } from '../src/sdk.js';
import { listPermissionRules, removeLocalPermissionRule, settingsProjectDir } from '../src/permission-rules.js';

const T = 240_000;
const rigs: Rig[] = [];
const rig = (...a: Parameters<typeof makeRig>) => { const r = makeRig(...a); rigs.push(r); return r; };
afterEach(() => { for (const r of rigs.splice(0)) r.cleanup(); });
const ask = (r: Rig, sid: string, text: string) => r.send({ type: 'prompt', sessionId: sid, text, clientMsgId: Math.random().toString(36).slice(2) });
const turn = async (r: Rig, sid: string, text: string, timeout = 120_000) => { const mark = r.sub.mark(); await ask(r, sid, text); return r.sub.waitFor<any>(isResult, timeout, mark); };
const sdk = (r: Rig) => r.sub.sdk();
const userUuids = (r: Rig) => r.sub.msgs.filter((m) => m.type === 'sdk' && (m.message as any).type === 'user' && (m.message as any).origin === 'workstation').map((m: any) => m.message.uuid as string);
const mcpAcks = (r: Rig) => r.sub.msgs.filter((m) => m.type === 'ack' && String((m as any).reqId).startsWith('mcp:')) as any[];

describe.skipIf(!process.env.REAL_SDK)('real SDK: alpha features', () => {
  it('MCP: failing servers report an honest error through mcp.status, without leaking launch config; the good one lists its tools', async () => {
    const r = rig();
    fs.writeFileSync(path.join(r.cwd, '.mcp.json'), JSON.stringify({ mcpServers: {
      mini: { command: 'node', args: [path.resolve(__dirname, '../scripts/mini-mcp.mjs'), '--secret-arg=TOPSECRET'] },
      broken: { command: 'node', args: ['-e', 'process.exit(3)'] },
      missing: { command: '/nonexistent/binary-xyz' },
    } }));
    fs.mkdirSync(path.join(r.cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(r.cwd, '.claude/settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
    const sid = await r.start();
    let list: any[] = [];
    for (let i = 0; i < 30; i++) {
      await r.send({ type: 'mcp.status', sessionId: sid });
      list = mcpAcks(r).at(-1)?.data.mcpServers ?? [];
      if (list.length === 3 && !list.some((x) => x.status === 'pending')) break;
      await new Promise((x) => setTimeout(x, 700));
    }
    const by = Object.fromEntries(list.map((x) => [x.name, x]));
    expect(by.mini).toMatchObject({ status: 'connected', tools: ['ping'] });
    expect(by.broken).toMatchObject({ status: 'failed', error: expect.stringMatching(/closed/i) });
    expect(by.missing).toMatchObject({ status: 'failed', error: expect.stringMatching(/ENOENT/) });
    expect(JSON.stringify(list)).not.toContain('TOPSECRET');
    expect(JSON.stringify(list)).not.toContain('"config"');
  }, T);

  it('subagent: task events carry ids, stopTask ends the agent and its background command with task_notification "stopped"', async () => {
    const r = rig();
    const sid = await r.start({ permissionMode: 'bypassPermissions' });
    await ask(r, sid, 'Use the Task tool (subagent_type general-purpose) to spawn a subagent whose only job is to run exactly this bash command: python3 -c "import time; time.sleep(60)" and then report slept. Wait for it.');
    await r.sub.waitFor((m) => m.type === 'sdk' && (m.message as any).subtype === 'task_started' && (m.message as any).task_type === 'local_bash', 90_000);
    const agent = sdk(r).find((x) => x.subtype === 'task_started' && x.task_type === 'local_agent')!;
    expect(agent).toMatchObject({ task_id: expect.any(String), tool_use_id: expect.any(String) });
    expect(sdk(r).some((x) => x.subtype === 'task_progress' && x.task_id === agent.task_id)).toBe(true);
    const mark = r.sub.mark();
    await r.send({ type: 'task.stop', reqId: 'ts1', sessionId: sid, taskId: agent.task_id });
    const stopped = await r.sub.waitFor<any>((m) => m.type === 'sdk' && (m.message as any).subtype === 'task_notification' && (m.message as any).task_id === agent.task_id, 30_000, mark);
    expect(stopped.message.status).toBe('stopped');
    expect(r.sub.msgs.find((m) => m.type === 'ack' && (m as any).reqId === 'ts1')).toMatchObject({ ok: true, data: { stopped: true } });
    await r.sub.waitFor(isResult, 90_000, mark); // the main agent continues and the turn ends normally
  }, T);

  it('rewind: files are restored (Bash edits are not); a conversation rewind forks before the chosen message', async () => {
    const r = rig();
    const sid = await r.start({ permissionMode: 'bypassPermissions' });
    await turn(r, sid, 'Create a file a.txt containing exactly v1 using the Write tool. Reply done.');
    await turn(r, sid, 'Change a.txt to contain exactly v2 using the Write or Edit tool, then run the bash command `echo bash > b.txt`. Reply done.');
    const [u1, u2] = userUuids(r);
    const read = (f: string) => (fs.existsSync(path.join(r.cwd, f)) ? fs.readFileSync(path.join(r.cwd, f), 'utf8').trim() : null);
    expect(read('a.txt')).toBe('v2');
    // dry run says which files; real run restores them
    const dryId = 'dry';
    await r.send({ type: 'rewind', reqId: dryId, sessionId: sid, userMessageId: u2!, dryRun: true });
    const dry = r.sub.msgs.find((m) => m.type === 'ack' && (m as any).reqId === dryId) as any;
    expect(dry.data).toMatchObject({ canRewind: true, filesChanged: [expect.stringMatching(/a\.txt$/)] });
    expect(read('a.txt')).toBe('v2');
    await r.send({ type: 'rewind', reqId: 'real', sessionId: sid, userMessageId: u2! });
    expect(read('a.txt')).toBe('v1');
    expect(read('b.txt')).toBe('bash'); // made through Bash: not covered, as the UI says
    // conversation: fork from before message 2 -> the model only knows turn 1
    await r.send({ type: 'session.start', reqId: 'fork', cwd: r.cwd, resume: sid, fork: true, rewindBefore: u2!, model: 'claude-haiku-5-5' });
    const started = await r.sub.waitFor<Extract<ServerMessage, { type: 'session.started' }>>((m) => m.type === 'session.started' && m.reqId === 'fork', 60_000);
    expect(started.sessionId).not.toBe(sid);
    const res = await turn(r, started.sessionId, 'Do not use tools. In one sentence: what file did I ask you to create before this message, and with what content?');
    expect(String(res.message.result)).toMatch(/v1/);
    const hist = JSON.stringify(await createRealAdapter().getSessionMessages(started.sessionId, { dir: r.cwd }));
    expect(hist).not.toContain('echo bash'); // message 2 is not in the fork's transcript
    expect(hist).not.toContain('"v2"');
  }, T);

  it('always allow for an MCP tool persists, applies to the next session, and forgetting the rule makes the live session ask again', async () => {
    const r = rig();
    fs.writeFileSync(path.join(r.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { mini: { command: 'node', args: [path.resolve(__dirname, '../scripts/mini-mcp.mjs')] } } }));
    fs.mkdirSync(path.join(r.cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(r.cwd, '.claude/settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
    const sid = await r.start();
    const prompt = 'Call the ping tool of the mini MCP server and tell me its output.';
    let mark = r.sub.mark();
    await ask(r, sid, prompt);
    const req = await r.sub.waitFor<Extract<ServerMessage, { type: 'permission.request' }>>((m) => m.type === 'permission.request', 90_000, mark);
    expect(req.toolName).toBe('mcp__mini__ping');
    await r.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'allow', remember: true } });
    await r.sub.waitFor(isResult, 90_000, mark);
    expect(listPermissionRules(r.cwd, { CLAUDE_CONFIG_DIR: '/nonexistent' }).filter((x) => x.source === 'local')).toEqual([{ source: 'local', behavior: 'allow', rule: 'mcp__mini__ping', removable: true }]);
    // same live session: no prompt now
    mark = r.sub.mark();
    await ask(r, sid, prompt);
    await r.sub.waitFor(isResult, 90_000, mark);
    expect(r.sub.msgs.slice(mark).some((m) => m.type === 'permission.request')).toBe(false);
    // forget the rule: the SAME live session asks again
    expect(removeLocalPermissionRule(r.cwd, 'allow', 'mcp__mini__ping')).toEqual({ removed: true });
    mark = r.sub.mark();
    await ask(r, sid, prompt);
    const again = await r.sub.waitFor<Extract<ServerMessage, { type: 'permission.request' }>>((m) => m.type === 'permission.request', 90_000, mark);
    expect(again.toolName).toBe('mcp__mini__ping');
    await r.send({ type: 'permission.respond', sessionId: sid, requestId: again.requestId, decision: { behavior: 'deny' } });
    await r.sub.waitFor(isResult, 90_000, mark);
  }, T);

  it('model switch mid-session: haiku turn, then sonnet (usage lists it), then back', async () => {
    const r = rig();
    const sid = await r.start();
    const a = await turn(r, sid, 'Reply with exactly: one');
    expect(Object.keys(a.message.modelUsage)).toEqual(['claude-haiku-5-5']);
    await r.send({ type: 'set.model', sessionId: sid, model: 'claude-sonnet-5-5' });
    expect(r.mgr.get(sid)!.model).toBe('claude-sonnet-5-5');
    const b = await turn(r, sid, 'Reply with exactly: two');
    expect(Object.keys(b.message.modelUsage)).toContain('claude-sonnet-5-5');
    await r.send({ type: 'set.model', sessionId: sid, model: 'claude-haiku-5-5' });
    const before = b.message.modelUsage['claude-sonnet-5-5'].outputTokens;
    const c = await turn(r, sid, 'Reply with exactly: three');
    expect(c.message.modelUsage['claude-sonnet-5-5'].outputTokens).toBe(before); // the sonnet total did not grow
  }, T);

  it('worktree session: remembered rules and edits live in the worktree; the main checkout stays untouched', async () => {
    const r = rig();
    const sh = (c: string, cwd = r.cwd) => execSync(c, { cwd, encoding: 'utf8' });
    sh('git init -q -b main && git -c user.email=a@b -c user.name=n commit -q --allow-empty -m init');
    const sid = await r.start({ worktree: true });
    const s = r.mgr.get(sid)!;
    const mark = r.sub.mark();
    await ask(r, sid, 'Run the bash command `touch wt1.txt` with the Bash tool. Nothing else.');
    const req = await r.sub.waitFor<Extract<ServerMessage, { type: 'permission.request' }>>((m) => m.type === 'permission.request', 90_000, mark);
    await r.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'allow', remember: true } });
    await r.sub.waitFor(isResult, 90_000, mark);
    expect(fs.existsSync(path.join(s.cwd, 'wt1.txt'))).toBe(true);
    expect(sh('git status --short')).toBe(''); // main checkout clean
    // the SDK keys local settings to the MAIN checkout: the rule outlives the worktree and the viewer finds it from the worktree path
    expect(await settingsProjectDir(s.cwd)).toBe(fs.realpathSync(r.cwd));
    expect(listPermissionRules(fs.realpathSync(r.cwd), { CLAUDE_CONFIG_DIR: '/nonexistent' })).toEqual([{ source: 'local', behavior: 'allow', rule: 'Bash(touch wt1.txt)', removable: true }]);
  }, T);
});
