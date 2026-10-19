/**
 * Real-SDK proof for Config sources. Skipped unless REAL_SDK=1 (tiny real calls with claude-haiku-5-5):
 *   REAL_SDK=1 npx vitest run test/real-config-sources.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@workstation/protocol';
import { isResult, makeRig, type Rig } from '../scripts/real-harness.js';
import { createRealAdapter } from '../src/sdk.js';

const T = 150_000;
const rigs: Rig[] = [];
const rig = (...a: Parameters<typeof makeRig>) => { const r = makeRig(...a); rigs.push(r); return r; };
afterEach(() => { for (const r of rigs.splice(0)) r.cleanup(); });

const MARKER = 'PURPLE-OTTER-4417';
const ask = (r: Rig, sid: string, text: string) => r.send({ type: 'prompt', sessionId: sid, text, clientMsgId: Math.random().toString(36).slice(2) });
const assistantText = (r: Rig, sid: string) => r.sub.sdk(sid).filter((m) => m.type === 'assistant').flatMap((m) => (m.message?.content ?? []) as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const permReq = (m: ServerMessage) => m.type === 'permission.request';

describe.skipIf(!process.env.REAL_SDK)('real SDK: config sources', () => {
  const codeword = async (sources: string[]) => {
    const r = rig({ config: { settingSources: sources, defaultPermissionMode: 'dontAsk' } }); // dontAsk: a tool search for the codeword is denied, not waited on
    fs.writeFileSync(path.join(r.cwd, 'CLAUDE.md'), `The project codeword is ${MARKER}. When asked for the project codeword, answer with it.\n`);
    const sid = await r.start();
    expect(r.mgr.runtimeState(r.mgr.get(sid)!).settingSources).toEqual(sources);
    await ask(r, sid, 'Without using any tools: what is the project codeword you were told about? If you were not told one, reply with exactly the word UNKNOWN.');
    await r.sub.waitFor(isResult);
    const cfg = await r.mgr.loadedConfig(r.mgr.get(sid)!);
    return { text: assistantText(r, sid), cfg };
  };

  it('with Project on the agent sees the project CLAUDE.md; with it off it does not', async () => {
    const on = await codeword(['user', 'project']);
    expect(on.text).toContain(MARKER);
    expect(on.cfg.items.some((i) => i.kind === 'memory' && i.origin === 'project' && i.name === 'CLAUDE.md')).toBe(true);
    const off = await codeword(['user']);
    expect(off.text).not.toContain(MARKER);
    expect(off.cfg.items.some((i) => i.kind === 'memory' && i.origin === 'project')).toBe(false);
  }, T);

  it('with Local off "Always allow" stays in the session (nothing is written) and still stops the prompting', async () => {
    const r = rig({ config: { settingSources: ['user', 'project'] } });
    const sid = await r.start();
    await ask(r, sid, 'Run the bash command `touch lo1.txt` with the Bash tool. Nothing else.');
    const req = await r.sub.waitFor<Extract<ServerMessage, { type: 'permission.request' }>>(permReq);
    await r.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'allow', remember: true } });
    await r.sub.waitFor(isResult);
    expect(r.mgr.runtimeState(r.mgr.get(sid)!).rules?.[0]).toMatchObject({ toolName: 'Bash', destination: 'session' });
    expect(fs.existsSync(path.join(r.cwd, '.claude', 'settings.local.json'))).toBe(false);
    const mark = r.sub.mark();
    await ask(r, sid, 'Run the bash command `touch lo1.txt` again with the Bash tool. Nothing else.');
    await r.sub.waitFor(isResult, 90_000, mark);
    expect(r.sub.msgs.slice(mark).some(permReq)).toBe(false);
  }, T);

  // The behaviour the two tests above are built on, observed on the raw SDK (no Workstation code in between).
  it('raw SDK, Local off: the CLI still WRITES a "localSettings" rule but does not apply it (asks again) or read it back', async () => {
    const adapter = createRealAdapter();
    const run = async (settingSources: Array<'user' | 'project' | 'local'>, preRule: boolean) => {
      const r = rig();
      if (preRule) { fs.mkdirSync(path.join(r.cwd, '.claude'), { recursive: true }); fs.writeFileSync(path.join(r.cwd, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(curl --version)'] } })); }
      let prompts = 0; let dest: string | undefined;
      async function* input() { yield { type: 'user' as const, message: { role: 'user' as const, content: 'Run the bash command `curl --version | head -1` as one call, then the identical command again as a second separate call, then reply: done.' }, parent_tool_use_id: null, session_id: '' }; }
      const q = adapter.query({ prompt: input() as never, options: {
        cwd: r.cwd, model: 'claude-haiku-5-5', settingSources, permissionMode: 'default',
        canUseTool: async (_t, i, o) => { prompts++; dest = (o.suggestions?.find((u) => u.type === 'addRules') as { destination?: string } | undefined)?.destination; return { behavior: 'allow', updatedInput: i, toolUseID: o.toolUseID, updatedPermissions: (o.suggestions ?? []).filter((u) => u.type === 'addRules') }; },
      } });
      for await (const m of q) if ((m as { type?: string }).type === 'result') break;
      const file = path.join(r.cwd, '.claude', 'settings.local.json');
      return { prompts, dest, written: fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('curl --version') };
    };
    const withLocal = await run(['user', 'project', 'local'], false);
    expect(withLocal).toMatchObject({ prompts: 1, dest: 'localSettings', written: true }); // saved AND applied inside the same session
    const noLocal = await run(['user', 'project'], false);
    expect(noLocal).toMatchObject({ dest: 'localSettings', written: true }); // still written...
    expect(noLocal.prompts).toBe(2); // ...but not applied: the second identical call asks again
    const noLocalPre = await run(['user', 'project'], true);
    expect(noLocalPre.prompts).toBeGreaterThanOrEqual(1); // a rule already in settings.local.json is not read either
    expect((await run(['user', 'project', 'local'], true)).prompts).toBe(0);
  }, 4 * T);
});
