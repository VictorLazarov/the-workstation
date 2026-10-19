/** Config sources (settingSources): mapping, config persistence, session start, catalog probes, rules viewer, loaded-config, "Always allow" with Local off. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SETTING_SOURCES, resolveSettingSources, type LoadedConfig, type SettingSourceId } from '@workstation/protocol';
import { startServer } from '../src/app.js';
import { ConfigStore } from '../src/config.js';
import { createMockAdapter } from '../src/mock.js';
import { listPermissionRules } from '../src/permission-rules.js';
import { shortCommand } from '../src/loaded-config.js';
import type { SdkAdapter } from '../src/sdk.js';
import { api, connect, startSession, type TestServer } from './helpers.js';

const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `ws-src-${n}-`));
const put = (f: string, body: string | object) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body)); };

// every subset of the three sources, in a scrambled input order
const COMBOS: SettingSourceId[][] = [[], ['user'], ['project'], ['local'], ['user', 'project'], ['user', 'local'], ['project', 'local'], ['user', 'project', 'local']];
const scramble = (c: SettingSourceId[]) => [...c].reverse();

let s: TestServer;
let userDir: string;
let seen: Options[] = [];
const prevCfg = process.env.CLAUDE_CONFIG_DIR;
const SECRET_BODY = 'BODY-OF-CLAUDE-MD-MUST-NOT-LEAK';

beforeAll(async () => {
  userDir = tmp('user');
  process.env.CLAUDE_CONFIG_DIR = userDir;
  put(path.join(userDir, 'CLAUDE.md'), `# user memory\n${SECRET_BODY}\n`);
  put(path.join(userDir, 'skills', 'user-skill', 'SKILL.md'), '---\nname: user-skill\n---\nbody');
  put(path.join(userDir, 'commands', 'user-cmd.md'), 'do it');
  put(path.join(userDir, 'agents', 'user-agent.md'), 'agent');
  put(path.join(userDir, 'settings.json'), {
    permissions: { allow: ['Bash(user-rule)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'AUDIT_TOKEN=hunter2hunter2secret /usr/local/bin/audit --log' }] }] },
  });
  const dir = tmp('srv');
  const cwd = path.join(dir, 'proj');
  put(path.join(cwd, 'CLAUDE.md'), `project memory ${SECRET_BODY}`);
  put(path.join(cwd, 'CLAUDE.local.md'), 'local memory');
  put(path.join(cwd, '.claude', 'commands', 'proj-cmd.md'), 'x');
  put(path.join(cwd, '.claude', 'skills', 'proj-skill', 'SKILL.md'), 'x');
  put(path.join(cwd, '.claude', 'settings.json'), { permissions: { allow: ['Bash(proj-rule)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: './scripts/done.sh' }] }] } });
  put(path.join(cwd, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(local-rule)', 'Bash(local-two)'] } });
  const mock = createMockAdapter();
  const adapter: SdkAdapter = { ...mock, query: (p) => { seen.push(p.options); return mock.query(p); } };
  const config = new ConfigStore(path.join(dir, 'home'));
  const srv = await startServer({ host: '127.0.0.1', port: 0, config, adapter, cwd, webDist: null });
  s = Object.assign(srv, { base: `http://127.0.0.1:${srv.port}`, token: config.token, dir, cwd });
});
afterAll(async () => {
  await s.close();
  if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
});

const setSources = async (v: unknown) => (await api(s, '/api/config', { method: 'PUT', body: JSON.stringify({ settingSources: v }) })).status;

describe('source selection mapping', () => {
  it('maps every combination to the canonical ordered list; unset or garbage means all three', () => {
    for (const c of COMBOS) expect(resolveSettingSources(scramble(c))).toEqual(c);
    expect(resolveSettingSources(undefined)).toEqual([...SETTING_SOURCES]);
    expect(resolveSettingSources('user')).toEqual([...SETTING_SOURCES]);
    expect(resolveSettingSources(['bogus', 'user'])).toEqual(['user']);
    expect(resolveSettingSources(['user', 'user'])).toEqual(['user']);
  });

  it('is persisted in AppConfig: all-on stores nothing, a subset and "none" survive a reload, bad input is rejected', () => {
    const dir = tmp('cfg');
    const c = new ConfigStore(dir);
    expect(c.settingSources()).toEqual(['user', 'project', 'local']);
    c.update({ settingSources: ['local', 'user'] });
    expect(new ConfigStore(dir).settingSources()).toEqual(['user', 'local']);
    c.update({ settingSources: [] });
    expect(new ConfigStore(dir).settingSources()).toEqual([]);
    expect(new ConfigStore(dir).redacted().settingSources).toEqual([]);
    c.update({ settingSources: ['project', 'user', 'local'] });
    expect(c.app.settingSources).toBeUndefined();
    c.update({ settingSources: ['project'] });
    c.update({ settingSources: null });
    expect(c.settingSources()).toEqual(['user', 'project', 'local']);
    expect(() => c.update({ settingSources: ['user', 'machine'] })).toThrow(/settingSources/);
    expect(() => c.update({ settingSources: 'user' })).toThrow(/settingSources/);
  });

  it('REST: PUT validates and GET returns it', async () => {
    expect(await setSources(['project'])).toBe(200);
    expect(((await (await api(s, '/api/config')).json()) as any).settingSources).toEqual(['project']);
    expect(await setSources(['nope'])).toBe(400);
    expect(await setSources(null)).toBe(200);
    expect(((await (await api(s, '/api/config')).json()) as any).settingSources).toBeUndefined();
  });
});

describe('applied to session start', () => {
  it('passes exactly the configured sources to the SDK, reports them in the state, and a running session keeps its own', async () => {
    for (const combo of COMBOS) {
      await setSources(scramble(combo));
      seen = [];
      const c = await connect(s);
      const sid = await startSession(c, s.cwd);
      expect(seen.at(-1)?.settingSources).toEqual(combo);
      const st: any = c.msgs.filter((m) => m.type === 'state').at(-1);
      expect(st.state.settingSources).toEqual(combo);
      // change Settings afterwards: this session is fixed, a new one follows the new value
      await setSources(combo.length === 0 ? ['user'] : []);
      c.send({ type: 'prompt', sessionId: sid, text: 'hi', clientMsgId: 'x' });
      await c.waitFor((m: any) => m.type === 'sdk' && m.message.type === 'result');
      const later: any = c.msgs.filter((m) => m.type === 'state').at(-1);
      expect(later.state.settingSources).toEqual(combo);
      c.close();
    }
    await setSources(null);
  });
});

describe('applied to catalog probes', () => {
  it('probes with the configured sources, and never serves a command list made under other sources', async () => {
    const cwd = path.join(s.dir, 'catalog-proj');
    put(path.join(cwd, '.claude', 'commands', 'proj-cmd.md'), 'x');
    const names = async () => ((await (await api(s, `/api/commands?cwd=${encodeURIComponent(cwd)}`)).json()) as any[]).map((c) => c.name);
    for (const combo of COMBOS) {
      await setSources(scramble(combo));
      seen = [];
      const list = await names();
      // the mock adapter reads the same files the CLI would: user + project commands appear only while their source is on
      expect(list.includes('user-cmd')).toBe(combo.includes('user'));
      expect(list.includes('proj-cmd')).toBe(combo.includes('project'));
      expect(seen.some((o) => JSON.stringify(o.settingSources) === JSON.stringify(combo))).toBe(true);
    }
    await setSources(null);
  });
});

describe('permission rules viewer', () => {
  it('lists only enabled sources and counts what a disabled source holds', async () => {
    const dir = s.cwd;
    for (const combo of COMBOS) {
      const ignored: Partial<Record<SettingSourceId, number>> = {};
      const rules = listPermissionRules(dir, { CLAUDE_CONFIG_DIR: userDir }, combo, ignored);
      expect([...new Set(rules.map((r) => r.source))].sort()).toEqual(combo.filter((c) => ['user', 'project', 'local'].includes(c)).sort());
      expect(Object.keys(ignored).sort()).toEqual(SETTING_SOURCES.filter((c) => !combo.includes(c)).sort());
    }
    await setSources(['user', 'project']);
    const got = await (await api(s, `/api/permission-rules?cwd=${encodeURIComponent(dir)}`)).json() as any;
    expect(got.sources).toEqual(['user', 'project']);
    expect(got.rules.some((r: any) => r.source === 'local')).toBe(false);
    expect(got.ignored).toEqual({ local: 2 });
    await setSources(null);
    const all = await (await api(s, `/api/permission-rules?cwd=${encodeURIComponent(dir)}`)).json() as any;
    expect(all.ignored).toBeUndefined();
    expect(all.rules.filter((r: any) => r.source === 'local')).toHaveLength(2);
  });
});

describe('loaded configuration', () => {
  const load = async (combo: SettingSourceId[]): Promise<LoadedConfig> => {
    await setSources(scramble(combo));
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    const r = await api(s, `/api/sessions/${sid}/loaded-config`);
    expect(r.status).toBe(200);
    const out = await r.json() as LoadedConfig;
    c.close();
    return out;
  };
  const of = (lc: LoadedConfig, origin: string, kind: string) => lc.items.filter((i) => i.origin === origin && i.kind === kind).map((i) => i.name);

  it('groups memory, skills, commands, agents and hooks by origin and follows the enabled sources', async () => {
    const all = await load(['user', 'project', 'local']);
    expect(all.sources).toEqual(['user', 'project', 'local']);
    expect(of(all, 'user', 'memory')).toEqual(['CLAUDE.md']);
    expect(of(all, 'project', 'memory')).toEqual(['CLAUDE.md']);
    expect(of(all, 'local', 'memory')).toEqual(['CLAUDE.local.md']);
    expect(of(all, 'user', 'skill')).toEqual(['user-skill']);
    expect(of(all, 'project', 'skill')).toEqual(['proj-skill']);
    expect(of(all, 'user', 'command')).toEqual(['user-cmd']);
    expect(of(all, 'project', 'command')).toEqual(['proj-cmd']);
    expect(of(all, 'user', 'agent')).toEqual(['user-agent']);
    expect(all.items.filter((i) => i.kind === 'hook').map((i) => [i.origin, i.name])).toEqual([['user', 'PreToolUse'], ['project', 'Stop']]);
    expect(all.hasHooks).toBe(true);
    expect(all.rules).toMatchObject({ user: 1, project: 1, local: 2 });
    expect(all.builtinCounts.agents).toBeGreaterThan(0);

    const onlyProject = await load(['project']);
    expect(onlyProject.items.filter((i) => i.origin === 'user')).toEqual([]);
    expect(onlyProject.items.filter((i) => i.origin === 'local')).toEqual([]);
    expect(onlyProject.items.some((i) => i.origin === 'project')).toBe(true);
    expect(onlyProject.hasHooks).toBe(true);
    expect(onlyProject.rules.user).toBeUndefined();

    const none = await load([]);
    expect(none.items.filter((i) => ['user', 'project', 'local'].includes(i.origin))).toEqual([]);
    expect(none.hasHooks).toBe(false);
    expect(none.notes.join(' ')).toMatch(/No config sources/);

    const localOnly = await load(['local']);
    expect(of(localOnly, 'local', 'memory')).toEqual(['CLAUDE.local.md']);
    expect(localOnly.notes.join(' ')).not.toMatch(/Always allow/);
    expect((await load(['user', 'project'])).notes.join(' ')).toMatch(/Always allow/);
    await setSources(null);
  });

  it('never carries file bodies or env values, shortens and redacts hook commands, and needs a token and a live session', async () => {
    const lc = await load(['user', 'project', 'local']);
    const json = JSON.stringify(lc);
    expect(json).not.toContain(SECRET_BODY);
    expect(json).not.toContain('hunter2hunter2secret');
    const hook = lc.items.find((i) => i.kind === 'hook' && i.origin === 'user')!;
    expect(hook.command).toContain('audit');
    expect(shortCommand('x'.repeat(500)).length).toBeLessThanOrEqual(90);
    expect((await api(s, '/api/sessions/00000000-0000-4000-8000-000000000000/loaded-config')).status).toBe(404);
    expect((await api(s, '/api/sessions/00000000-0000-4000-8000-000000000000/loaded-config', {}, null)).status).toBe(401);
    await setSources(null);
  });
});

describe('"Always allow" with Local off', () => {
  const alwaysAllow = async (combo: SettingSourceId[]) => {
    await setSources(scramble(combo));
    const c = await connect(s);
    const sid = await startSession(c, s.cwd);
    c.send({ type: 'prompt', sessionId: sid, text: 'bash', clientMsgId: 'a' });
    const req: any = await c.waitFor((m) => m.type === 'permission.request');
    c.send({ type: 'permission.respond', sessionId: sid, requestId: req.requestId, decision: { behavior: 'allow', remember: true } });
    await c.waitFor((m: any) => m.type === 'sdk' && m.message.type === 'result');
    const st: any = c.msgs.filter((m) => m.type === 'state').at(-1);
    c.close();
    return st.state.rules as Array<{ destination: string }>;
  };
  it('is kept for the session only (a saved rule would be neither applied nor read); with Local on it is saved', async () => {
    expect((await alwaysAllow(['user', 'project']))[0]!.destination).toBe('session');
    expect((await alwaysAllow([]))[0]!.destination).toBe('session');
    expect((await alwaysAllow(['user', 'project', 'local']))[0]!.destination).toBe('localSettings');
    expect((await alwaysAllow(['local']))[0]!.destination).toBe('localSettings');
    await setSources(null);
  });
});
