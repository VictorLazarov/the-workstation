import { describe, expect, it } from 'vitest';
import { emptyConversation } from '../../lib/reducer';
import { deriveTasks, sortTasks } from './derive';

function conv() {
  const c = emptyConversation();
  c.lanes[''] = { live: null, items: [{ kind: 'assistant', id: 'a', msgId: 'm', ts: 1, blocks: [
    { type: 'tool_use', id: 'k1', name: 'Task', input: { subagent_type: 'reviewer', description: 'Review it' }, final: true },
    { type: 'tool_use', id: 'k2', name: 'Agent', input: { subagent_type: 'explore', description: 'Look around' }, final: true },
    { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true }, final: true },
    { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'ls' }, final: true },
  ] }] };
  c.tasks = {
    k1: { taskId: 't1', toolUseId: 'k1', description: 'Review it', status: 'running', toolUses: 3, totalTokens: 900, durationMs: 4000, lastToolName: 'Grep' },
    orphan: { taskId: 't9', description: 'Lost', status: 'completed', subagentType: 'x' },
  };
  c.toolResults = { b1: { content: 'started', isError: false, images: [] }, k2: { content: 'done', isError: false, images: [] } };
  return c;
}

describe('deriveTasks', () => {
  it('derives subagents, background commands and orphans', () => {
    const rows = deriveTasks(conv(), true);
    expect(rows.map((r) => [r.id, r.kind, r.status])).toEqual([
      ['k1', 'subagent', 'running'], ['k2', 'subagent', 'completed'], ['b1', 'background', 'started'], ['orphan', 'subagent', 'completed'],
    ]);
    expect(rows[0]).toMatchObject({ title: 'reviewer', tools: 3, tokens: 900, lastTool: 'Grep' });
  });
  it('does not spin forever when the session stopped', () => {
    expect(deriveTasks(conv(), false)[0].status).toBe('stopped');
  });
  it('sorts running first', () => {
    expect(sortTasks(deriveTasks(conv(), true)).map((r) => r.id)).toEqual(['k1', 'orphan', 'b1', 'k2']);
  });
});
