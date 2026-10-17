import type { Block, Item, ToolUseBlock } from './types';
import { basename, truncate } from './utils';

export type ToolKind = 'bash' | 'edit' | 'write' | 'read' | 'search' | 'web' | 'task' | 'todo' | 'ask' | 'plan' | 'mcp' | 'other';

export function toolKind(name: string): ToolKind {
  switch (name) {
    case 'Bash': case 'BashOutput': case 'KillShell': case 'KillBash': return 'bash';
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit';
    case 'Write': return 'write';
    case 'Read': case 'LS': case 'NotebookRead': return 'read';
    case 'Grep': case 'Glob': return 'search';
    case 'WebFetch': case 'WebSearch': return 'web';
    case 'Task': case 'Agent': return 'task';
    case 'TodoWrite': return 'todo';
    case 'AskUserQuestion': return 'ask';
    case 'ExitPlanMode': return 'plan';
    default: return name.startsWith('mcp__') ? 'mcp' : 'other';
  }
}

export const isExplore = (name: string) => ['Read', 'Grep', 'Glob', 'LS'].includes(name);

export const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

export function toolPath(b: ToolUseBlock): string {
  return str(b.input.file_path ?? b.input.path ?? b.input.notebook_path);
}

export function mcpParts(name: string): { server: string; tool: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : { server: '', tool: name };
}

/** One-line human summary of a tool call. */
export function toolTitle(b: ToolUseBlock): { verb: string; subject: string } {
  const i = b.input;
  switch (b.name) {
    case 'Bash': return { verb: 'Ran', subject: truncate(str(i.description) || str(i.command).split('\n')[0], 90) };
    case 'Read': return { verb: 'Read', subject: basename(toolPath(b)) };
    case 'LS': return { verb: 'Listed', subject: basename(toolPath(b)) || '.' };
    case 'Grep': return { verb: 'Searched', subject: truncate(str(i.pattern), 60) };
    case 'Glob': return { verb: 'Found files', subject: truncate(str(i.pattern), 60) };
    case 'Edit': case 'MultiEdit': return { verb: 'Edited', subject: basename(toolPath(b)) };
    case 'Write': return { verb: 'Wrote', subject: basename(toolPath(b)) };
    case 'NotebookEdit': return { verb: 'Edited notebook', subject: basename(toolPath(b)) };
    case 'WebFetch': return { verb: 'Fetched', subject: hostOf(str(i.url)) };
    case 'WebSearch': return { verb: 'Searched the web', subject: truncate(str(i.query), 70) };
    case 'Task': case 'Agent': return { verb: str(i.subagent_type) || 'Subagent', subject: truncate(str(i.description), 80) };
    case 'TodoWrite': return { verb: 'Updated plan', subject: '' };
    case 'AskUserQuestion': return { verb: 'Asked', subject: 'a question' };
    case 'ExitPlanMode': return { verb: 'Proposed', subject: 'a plan' };
    default: {
      const { server, tool } = mcpParts(b.name);
      return server ? { verb: tool.replace(/_/g, ' '), subject: server } : { verb: b.name, subject: '' };
    }
  }
}

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/* ───────────── timeline rows ───────────── */
export type Row =
  | { kind: 'user'; key: string; item: Extract<Item, { kind: 'user' }> }
  | { kind: 'text'; key: string; block: Extract<Block, { type: 'text' }>; streaming: boolean }
  | { kind: 'thinking'; key: string; block: Extract<Block, { type: 'thinking' }>; streaming: boolean }
  | { kind: 'tool'; key: string; block: ToolUseBlock }
  | { kind: 'explore'; key: string; blocks: ToolUseBlock[] }
  | { kind: 'notice'; key: string; item: Extract<Item, { kind: 'notice' }> }
  | { kind: 'result'; key: string; item: Extract<Item, { kind: 'result' }> }
  | { kind: 'error'; key: string; text: string };

export function buildRows(items: Item[], liveId: string | null | undefined): Row[] {
  const rows: Row[] = [];
  for (const it of items) {
    switch (it.kind) {
      case 'user': rows.push({ kind: 'user', key: it.id, item: it }); break;
      case 'notice': rows.push({ kind: 'notice', key: it.id, item: it }); break;
      case 'result': rows.push({ kind: 'result', key: it.id, item: it }); break;
      case 'assistant': {
        const live = it.id === liveId;
        it.blocks.forEach((b, bi) => {
          const key = `${it.id}:${bi}`;
          if (b.type === 'text') { if (b.text.trim() || !b.final) rows.push({ kind: 'text', key, block: b, streaming: live && !b.final }); }
          else if (b.type === 'thinking') rows.push({ kind: 'thinking', key, block: b, streaming: live && !b.final });
          else if (isExplore(b.name)) {
            const prev = rows[rows.length - 1];
            if (prev && prev.kind === 'explore') prev.blocks = [...prev.blocks, b];
            else rows.push({ kind: 'explore', key, blocks: [b] });
          } else rows.push({ kind: 'tool', key, block: b });
        });
        if (it.error) rows.push({ kind: 'error', key: it.id + ':err', text: humanizeError(it.error) });
        break;
      }
    }
  }
  return rows;
}

export function humanizeError(code: string): string {
  const map: Record<string, string> = {
    authentication_failed: 'Authentication failed. Check your API key in Settings.',
    billing_error: 'Billing error on the API account.',
    rate_limit: 'Rate limited by the API. Retry in a moment.',
    invalid_request: 'The API rejected the request.',
    server_error: 'The API returned a server error.',
    max_output_tokens: 'The response hit the maximum output length.',
  };
  return map[code] ?? code;
}
