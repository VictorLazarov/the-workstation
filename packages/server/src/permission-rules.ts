import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionRuleEntry } from '@workstation/protocol';
import { HttpError } from './files.js';
import { git } from './git.js';
import { fromGitPath } from './platform.js';
import { writeFileAtomic } from './platform.js';

type Behavior = PermissionRuleEntry['behavior'];
const BEHAVIORS: Behavior[] = ['allow', 'deny', 'ask'];

/**
 * The directory whose `.claude/` holds a session's project settings. Claude Code keys them to the MAIN checkout's root, not to the
 * session's cwd: a session in a sub-directory, or in a linked worktree, saves "Always allow" rules in `<repo>/.claude/settings.local.json`
 * (checked against the real SDK). Outside git the cwd itself is the project.
 */
export async function settingsProjectDir(cwd: string): Promise<string> {
  try {
    const r = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const common = r.code === 0 ? fromGitPath(r.stdout.trim()) : '';
    if (common && path.basename(common) === '.git') return path.dirname(common);
  } catch { /* not a repository */ }
  return cwd;
}

/** Where Claude Code keeps rules, by scope. Only `local` (what "Always allow" writes) is editable from here. */
function files(cwd: string, env: Record<string, string | undefined> = process.env): Array<{ source: PermissionRuleEntry['source']; file: string }> {
  const userDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return [
    { source: 'local', file: path.join(cwd, '.claude', 'settings.local.json') },
    { source: 'project', file: path.join(cwd, '.claude', 'settings.json') },
    { source: 'user', file: path.join(userDir, 'settings.json') },
  ];
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

/** The permission rules (allow / deny / ask) that apply to a project directory, from its local, project and user settings. */
export function listPermissionRules(cwd: string, env?: Record<string, string | undefined>): PermissionRuleEntry[] {
  const out: PermissionRuleEntry[] = [];
  for (const { source, file } of files(cwd, env)) {
    const perms = readJson(file)?.permissions as Record<string, unknown> | undefined;
    if (!perms || typeof perms !== 'object') continue;
    for (const behavior of BEHAVIORS) {
      const list = perms[behavior];
      if (!Array.isArray(list)) continue;
      for (const rule of list) if (typeof rule === 'string' && rule) out.push({ source, behavior, rule, removable: source === 'local' });
    }
  }
  return out;
}

/** Remove one rule from `<cwd>/.claude/settings.local.json`, leaving every other key alone. */
export function removeLocalPermissionRule(cwd: string, behavior: unknown, rule: unknown): { removed: boolean } {
  if (typeof behavior !== 'string' || !BEHAVIORS.includes(behavior as Behavior)) throw new HttpError(400, 'behavior must be allow, deny or ask');
  if (typeof rule !== 'string' || !rule || rule.length > 2000) throw new HttpError(400, 'rule is required');
  const file = path.join(cwd, '.claude', 'settings.local.json');
  const json = readJson(file);
  const perms = json?.permissions as Record<string, unknown> | undefined;
  const list = perms?.[behavior];
  if (!json || !perms || !Array.isArray(list) || !list.includes(rule)) return { removed: false };
  const next = list.filter((r) => r !== rule);
  if (next.length) perms[behavior] = next; else delete perms[behavior];
  if (Object.keys(perms).length === 0) delete json.permissions;
  writeFileAtomic(file, JSON.stringify(json, null, 2) + '\n');
  return { removed: true };
}
