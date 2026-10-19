/**
 * "Loaded configuration": what the agent picked up from the user's machine for one session, grouped by origin.
 *
 * Two sources are combined (docs/ARCHITECTURE.md "Config sources"):
 *  - the SDK's own answers (init message: skills, slash commands, agents, plugins, MCP servers; `getContextUsage`: memory files),
 *    which say what was REALLY loaded;
 *  - a small read-only scan of the config files of each ENABLED source, which says where a name came from and lists hooks
 *    (the SDK has no query call for them). The scan reads names, paths and hook events/matchers/commands only: never the
 *    body of a CLAUDE.md, skill or agent, and never env values. Everything is path-contained: only fixed locations under the
 *    user's Claude dir and the project's `.claude/` are visited, with entry caps, and symlinks that leave their root are skipped.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigItem, ConfigOrigin, SettingSourceId } from '@workstation/protocol';
import { redactString } from './redact.js';

const MAX_ENTRIES = 300;
const MAX_DEPTH = 3;
const MAX_COMMAND = 90;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function readJson(file: string): Json | null {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown; return isObj(v) ? v : null; } catch { return null; }
}
const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** A hook command for display: redacted, one line, shortened. */
export function shortCommand(cmd: string): string {
  const one = redactString(cmd.replace(/\s+/g, ' ').trim(), { maxString: 400 });
  return one.length > MAX_COMMAND ? one.slice(0, MAX_COMMAND - 1) + '…' : one;
}

/** `~/…` for the home directory, a path relative to the project for files inside it. */
export function displayPath(file: string, projectDir: string, home = os.homedir()): string {
  const rel = path.relative(projectDir, file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  const h = path.relative(home, file);
  if (h && !h.startsWith('..') && !path.isAbsolute(h)) return '~/' + h.split(path.sep).join('/');
  return file;
}

/** Entries of a fixed config directory (capped). Symlinks are common there (a linked skills dir); we only stat them, never read through them. */
function safeEntries(dir: string): fs.Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).slice(0, MAX_ENTRIES); } catch { return []; }
}

function mdNames(dir: string, depth = 0, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of safeEntries(dir)) {
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch { continue; } }
    if (isDir) { if (depth < MAX_DEPTH) out.push(...mdNames(full, depth + 1, prefix + e.name + ':')); }
    else if (/\.md$/i.test(e.name)) out.push(prefix + e.name.replace(/\.md$/i, ''));
  }
  return out;
}

function skillNames(dir: string): string[] {
  const out: string[] = [];
  for (const e of safeEntries(dir)) {
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch { continue; } }
    if (isDir && isFile(path.join(full, 'SKILL.md'))) out.push(e.name);
  }
  return out;
}

/** Hooks of one settings-like JSON (`hooks: { Event: [{ matcher?, hooks: [{ type, command|prompt|url }] }] }`). */
export function hooksOf(json: Json | null, origin: ConfigOrigin): ConfigItem[] {
  const out: ConfigItem[] = [];
  const hooks = json?.hooks;
  if (!isObj(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks)) continue;
      const matcher = typeof g.matcher === 'string' && g.matcher ? g.matcher : '';
      for (const h of g.hooks) {
        if (!isObj(h) || out.length >= MAX_ENTRIES) continue;
        const type = typeof h.type === 'string' ? h.type : 'command';
        const raw = typeof h.command === 'string' ? h.command : typeof h.url === 'string' ? h.url : typeof h.prompt === 'string' ? `(${type} hook)` : `(${type} hook)`;
        out.push({ kind: 'hook', origin, name: event, detail: matcher ? `${event} · ${shortCommand(matcher)}` : event, command: shortCommand(raw) });
      }
    }
  }
  return out;
}

export interface ScanResult {
  memory: ConfigItem[];
  skills: Map<string, ConfigOrigin>;
  commands: Map<string, ConfigOrigin>;
  agents: Map<string, ConfigOrigin>;
  hooks: ConfigItem[];
}

export interface ScanDirs {
  /** the user's Claude config dir (`~/.claude`, or CLAUDE_CONFIG_DIR) */
  userDir: string;
  /** the project whose `.claude/` is read (main checkout root, see settingsProjectDir) */
  projectDir: string;
  /** the session's working directory (CLAUDE.md files are looked up from here upwards to projectDir) */
  cwd: string;
}

/** Read-only scan of the files the ENABLED sources would load. */
export function scanConfig(dirs: ScanDirs, sources: readonly SettingSourceId[]): ScanResult {
  const res: ScanResult = { memory: [], skills: new Map(), commands: new Map(), agents: new Map(), hooks: [] };
  const on = new Set(sources);
  const mem = (file: string, origin: ConfigOrigin) => { if (isFile(file)) res.memory.push({ kind: 'memory', origin, name: path.basename(file), detail: displayPath(file, dirs.projectDir) }); };
  const named = (root: string, origin: ConfigOrigin) => {
    for (const n of skillNames(path.join(root, 'skills'))) res.skills.set(n, origin);
    for (const n of mdNames(path.join(root, 'commands'))) res.commands.set(n, origin);
    for (const n of mdNames(path.join(root, 'agents'))) res.agents.set(n, origin);
  };
  if (on.has('user')) {
    mem(path.join(dirs.userDir, 'CLAUDE.md'), 'user');
    named(dirs.userDir, 'user');
    res.hooks.push(...hooksOf(readJson(path.join(dirs.userDir, 'settings.json')), 'user'));
  }
  if (on.has('project')) {
    // CLAUDE.md / .claude/CLAUDE.md from the working directory up to the project root (nearest last, like the CLI's order)
    const chain: string[] = [];
    for (let d = dirs.cwd; ; d = path.dirname(d)) {
      chain.unshift(d);
      if (d === dirs.projectDir || path.dirname(d) === d) break;
      if (path.relative(dirs.projectDir, d).startsWith('..')) { chain.length = 0; chain.push(dirs.projectDir); break; }
    }
    for (const d of chain) { mem(path.join(d, 'CLAUDE.md'), 'project'); mem(path.join(d, '.claude', 'CLAUDE.md'), 'project'); }
    named(path.join(dirs.projectDir, '.claude'), 'project');
    res.hooks.push(...hooksOf(readJson(path.join(dirs.projectDir, '.claude', 'settings.json')), 'project'));
  }
  if (on.has('local')) {
    for (const d of new Set([dirs.cwd, dirs.projectDir])) mem(path.join(d, 'CLAUDE.local.md'), 'local');
    res.hooks.push(...hooksOf(readJson(path.join(dirs.projectDir, '.claude', 'settings.local.json')), 'local'));
  }
  return res;
}

/** Hooks a plugin ships (`<plugin>/hooks/hooks.json`, either `{hooks:{…}}` or the events at the top level). */
export function pluginHooks(pluginPath: string): ConfigItem[] {
  const j = readJson(path.join(pluginPath, 'hooks', 'hooks.json'));
  if (!j) return [];
  return hooksOf(isObj(j.hooks) ? j : { hooks: j }, 'plugin');
}

const MEMORY_ORIGIN: Array<[RegExp, ConfigOrigin]> = [[/local/i, 'local'], [/project/i, 'project'], [/user/i, 'user']];

export interface ComposeInput {
  sources: readonly SettingSourceId[];
  dirs: ScanDirs;
  /** the SDK's init (real `system/init` message, or our synthetic one before the first prompt) */
  init: Json | undefined;
  /** getContextUsage().memoryFiles, when the SDK answered */
  memoryFiles?: Array<{ path: string; type: string }>;
  /** mcpServerStatus() */
  mcp?: Array<{ name: string; status: string; scope?: string; source?: string }>;
  /** names of the SDK's agents (initializationResult().agents) */
  agents?: string[];
}

const names = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : isObj(x) && typeof x.name === 'string' ? x.name : '')).filter(Boolean) : []);

/** Combine SDK lists and the file scan into the card's items. */
export function composeLoadedConfig(input: ComposeInput): { items: ConfigItem[]; builtinCounts: { skills: number; commands: number; agents: number }; hasHooks: boolean } {
  const scan = scanConfig(input.dirs, input.sources);
  const items: ConfigItem[] = [];
  const init = input.init ?? {};

  // memory: what the SDK says it loaded (it includes managed / nested files), else the files the scan found
  const sdkMem = (input.memoryFiles ?? []).filter((m) => m && typeof m.path === 'string');
  if (sdkMem.length) {
    for (const m of sdkMem) {
      const origin = MEMORY_ORIGIN.find(([re]) => re.test(m.type))?.[1] ?? 'builtin';
      items.push({ kind: 'memory', origin, name: path.basename(m.path), detail: displayPath(m.path, input.dirs.projectDir) });
    }
  } else items.push(...scan.memory);

  const plugins = Array.isArray(init.plugins) ? (init.plugins as Array<Json>).filter((p) => typeof p.name === 'string') : [];
  const pluginNames = new Set(plugins.map((p) => String(p.name)));
  const fromPlugin = (n: string) => { const i = n.indexOf(':'); return i > 0 && pluginNames.has(n.slice(0, i)); };
  const originOf = (n: string, map: Map<string, ConfigOrigin>): ConfigOrigin => map.get(n) ?? (fromPlugin(n) ? 'plugin' : 'builtin');

  const slash = names(init.slash_commands).map((n) => n.replace(/^\//, ''));
  // Before the first prompt only our own init exists and it has no `skills` list: skills found on disk that the CLI reports as commands count
  const skills = [...new Set([...names(init.skills), ...slash.filter((n) => scan.skills.has(n))])];
  const skillSet = new Set(skills);
  // slash_commands also lists every skill; those are shown once, as skills
  const commands = slash.filter((n) => !skillSet.has(n));
  const agents = [...new Set([...names(init.agents), ...(input.agents ?? [])])];

  const counts = { skills: 0, commands: 0, agents: 0 };
  const add = (kind: 'skill' | 'command' | 'agent', list: string[], map: Map<string, ConfigOrigin>) => {
    for (const n of list) {
      const origin = originOf(n, map);
      if (origin === 'builtin') counts[`${kind}s` as 'skills' | 'commands' | 'agents']++;
      else items.push({ kind, origin, name: n });
    }
  };
  add('skill', skills, scan.skills);
  add('command', commands, scan.commands);
  add('agent', agents, scan.agents);

  for (const p of plugins) items.push({ kind: 'plugin', origin: 'plugin', name: String(p.name), ...(typeof p.version === 'string' ? { detail: p.version } : {}) });

  const mcp = input.mcp ?? (Array.isArray(init.mcp_servers) ? init.mcp_servers as Array<{ name: string; status: string; scope?: string; source?: string }> : []);
  for (const m of mcp) {
    const scope = (m.source && m.source !== 'sdk' ? m.source : m.scope) ?? '';
    const origin: ConfigOrigin = scope === 'user' ? 'user' : scope === 'project' ? 'project' : scope === 'local' ? 'local' : scope === 'plugin' ? 'plugin' : 'builtin';
    items.push({ kind: 'mcp', origin, name: m.name, detail: scope && origin === 'builtin' ? `${m.status} · ${scope}` : m.status });
  }

  items.push(...scan.hooks);
  for (const p of plugins) if (typeof p.path === 'string') items.push(...pluginHooks(p.path).map((h) => ({ ...h, detail: `${h.detail ?? h.name} · ${String(p.name)}` })));

  return { items, builtinCounts: counts, hasHooks: items.some((i) => i.kind === 'hook') };
}
