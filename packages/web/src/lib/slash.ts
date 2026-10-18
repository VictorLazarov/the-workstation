import { fuzzy } from './utils';

export interface SlashOption { id: string; label: string; detail?: string; insert: string; /** the command's argument hint, e.g. `<name>` (required) or `[model]` (optional) */ hint?: string }

/** Commands the app itself knows how to run (Claude Code built-ins): shown before skills and plugin commands. */
const BUILTIN = new Set([
  'clear', 'compact', 'context', 'cost', 'help', 'init', 'memory', 'model', 'rename', 'resume', 'review', 'status', 'config', 'agents', 'mcp',
  'permissions', 'plan', 'rewind', 'usage', 'doctor', 'export', 'login', 'logout', 'bug', 'vim', 'terminal-setup', 'add-dir',
]);

/** Internal commands (`/__remote-workflow`): not for people. */
export const isInternalCommand = (name: string) => name.startsWith('__');

/**
 * What the slash menu lists for `query`: built-in commands first, then the rest. Within a group a name that STARTS with the
 * query beats a fuzzy match. Internal commands never appear.
 */
export function rankSlash(options: SlashOption[], query: string, limit = 8): SlashOption[] {
  const q = query.toLowerCase();
  return options
    .filter((o) => !isInternalCommand(o.id))
    .map((o) => ({ o, s: fuzzy(query, o.id), prefix: !q || o.id.toLowerCase().startsWith(q), builtin: BUILTIN.has(o.id) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => Number(b.prefix) - Number(a.prefix) || Number(b.builtin) - Number(a.builtin) || b.s - a.s || a.o.id.localeCompare(b.o.id))
    .slice(0, limit)
    .map((x) => x.o);
}

/** Enter on a highlighted command runs it unless it needs an argument (`<required>`): then it only completes the name. */
export const slashRunsOnEnter = (o: SlashOption) => !/^\s*</.test(o.hint ?? '');
