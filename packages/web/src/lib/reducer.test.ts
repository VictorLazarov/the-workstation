import { describe, expect, it } from 'vitest';
import { addLocalUser, applySdk, emptyConversation, finishStreaming, foldMessages, hasToolUse } from './reducer';
import type { AssistantItem } from './types';
import { buildRows } from './tools';

const se = (event: any, parent: string | null = null) => ({ type: 'stream_event', event, parent_tool_use_id: parent, uuid: 'u', session_id: 's' });
const main = (c: ReturnType<typeof emptyConversation>) => c.lanes[''].items;

function streamText(id: string, text: string) {
  return [
    se({ type: 'message_start', message: { id, usage: { input_tokens: 100 } } }),
    se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...text.split(' ').map((w, i) => se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: (i ? ' ' : '') + w } })),
    se({ type: 'content_block_stop', index: 0 }),
  ];
}

describe('reducer: streaming', () => {
  it('folds text deltas into one assistant item and finalizes on assistant message', () => {
    let c = foldMessages(streamText('m1', 'hello brave world'));
    const a = main(c)[0] as AssistantItem;
    expect(a.blocks).toHaveLength(1);
    expect(a.blocks[0]).toMatchObject({ type: 'text', text: 'hello brave world' });
    expect(c.lanes[''].live).not.toBeNull();
    c = applySdk(c, { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'hello brave world' }] }, parent_tool_use_id: null });
    expect(main(c)).toHaveLength(1);
    expect((main(c)[0] as AssistantItem).blocks[0]).toMatchObject({ final: true });
    c = applySdk(c, se({ type: 'message_stop' }));
    expect(c.lanes[''].live).toBeNull();
  });

  it('keeps thinking and text as separate blocks and replaces them in order', () => {
    let c = foldMessages([
      se({ type: 'message_start', message: { id: 'm2' } }),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
      se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } }),
    ]);
    // SDK emits one assistant message per content block, same message id
    c = applySdk(c, { type: 'assistant', message: { id: 'm2', content: [{ type: 'thinking', thinking: 'hmm done' }] } });
    c = applySdk(c, { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'answer!' }] } });
    const a = main(c)[0] as AssistantItem;
    expect(a.blocks.map((b) => b.type)).toEqual(['thinking', 'text']);
    expect((a.blocks[0] as any).text).toBe('hmm done');
    expect((a.blocks[1] as any).text).toBe('answer!');
  });

  it('accumulates tool_use input json and parses at block stop', () => {
    const c = foldMessages([
      se({ type: 'message_start', message: { id: 'm3' } }),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls ' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '-la"}' } }),
      se({ type: 'content_block_stop', index: 0 }),
    ]);
    const b = (main(c)[0] as AssistantItem).blocks[0] as any;
    expect(b.input).toEqual({ command: 'ls -la' });
    expect(hasToolUse(c, 't1')).toBe(true);
  });

  it('works without streaming (final messages only) and pairs tool results', () => {
    const c = foldMessages([
      { type: 'assistant', message: { id: 'x', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu', name: 'Read', input: { file_path: '/a/b.ts' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'file body' }] }, tool_use_result: { foo: 1 } },
    ]);
    expect(main(c)).toHaveLength(1);
    expect(c.toolResults.tu).toMatchObject({ content: 'file body', isError: false, raw: { foo: 1 } });
  });
});

describe('reducer: subagents', () => {
  it('routes parent_tool_use_id messages to a nested lane', () => {
    const c = foldMessages([
      { type: 'assistant', message: { id: 'p', content: [{ type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'explore' } }] }, parent_tool_use_id: null },
      { type: 'assistant', message: { id: 'sub1', content: [{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'x' } }] }, parent_tool_use_id: 'task1' },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'g1', content: 'hit' }] }, parent_tool_use_id: 'task1' },
    ]);
    expect(main(c)).toHaveLength(1);
    expect(c.lanes.task1.items).toHaveLength(1);
    expect(c.toolResults.g1.content).toBe('hit');
  });

  it('tracks task progress', () => {
    let c = applySdk(emptyConversation(), { type: 'system', subtype: 'task_started', task_id: 'k', tool_use_id: 'task1', description: 'd' });
    c = applySdk(c, { type: 'system', subtype: 'task_progress', task_id: 'k', tool_use_id: 'task1', description: 'd', usage: { total_tokens: 10, tool_uses: 2, duration_ms: 5 } });
    expect(c.tasks.task1).toMatchObject({ status: 'running', toolUses: 2 });
    c = applySdk(c, { type: 'system', subtype: 'task_notification', task_id: 'k', tool_use_id: 'task1', status: 'completed', summary: 'done' });
    expect(c.tasks.task1.status).toBe('completed');
  });
});

describe('reducer: user, result, system', () => {
  it('confirms optimistic user message when echoed and keeps uuid', () => {
    let c = addLocalUser(emptyConversation(), 'cm1', 'fix the bug');
    expect((main(c)[0] as any).pending).toBe(true);
    c = applySdk(c, { type: 'user', uuid: 'U1', message: { role: 'user', content: 'fix the bug' }, parent_tool_use_id: null });
    expect(main(c)).toHaveLength(1);
    expect(main(c)[0]).toMatchObject({ pending: false, uuid: 'U1' });
    // replay of same uuid is ignored
    c = applySdk(c, { type: 'user', uuid: 'U1', message: { role: 'user', content: 'fix the bug' } });
    expect(main(c)).toHaveLength(1);
  });

  it('strips system reminders and ignores synthetic messages', () => {
    let c = applySdk(emptyConversation(), { type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>x</system-reminder>hi' }] } });
    expect((main(c)[0] as any).text).toBe('hi');
    c = applySdk(c, { type: 'user', isSynthetic: true, message: { content: 'skill body' } });
    expect(main(c)).toHaveLength(1);
  });

  it('records TodoWrite todos and plan', () => {
    const c = foldMessages([
      { type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 'td', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'Doing b' }] } }] } },
      { type: 'assistant', message: { id: 'b', content: [{ type: 'tool_use', id: 'pl', name: 'ExitPlanMode', input: { plan: '# Plan' } }] } },
    ]);
    expect(c.todos).toHaveLength(2);
    expect(c.todos![1].status).toBe('in_progress');
    expect(c.plan).toBe('# Plan');
  });

  it('computes turn cost deltas and clears streaming on result', () => {
    let c = foldMessages(streamText('m', 'a b'));
    c = applySdk(c, { type: 'result', subtype: 'success', is_error: false, result: 'a b', total_cost_usd: 0.05, duration_ms: 1200, num_turns: 1 });
    c = applySdk(c, { type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0.08, duration_ms: 800, num_turns: 1 });
    const results = main(c).filter((i) => i.kind === 'result') as any[];
    expect(results[0].turnCostUsd).toBeCloseTo(0.05);
    expect(results[1].turnCostUsd).toBeCloseTo(0.03);
    expect(c.lanes[''].live).toBeNull();
    expect(c.usage.costUsd).toBeCloseTo(0.08);
  });

  it('shows and clears api retry banner', () => {
    let c = applySdk(emptyConversation(), { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 2000, error_status: 529, error: 'overloaded' });
    expect(c.retry).toMatchObject({ attempt: 2, status: 529 });
    c = applySdk(c, se({ type: 'message_start', message: { id: 'z' } }));
    expect(c.retry).toBeNull();
  });

  it('stores init info and ignores unknown messages', () => {
    let c = applySdk(emptyConversation(), { type: 'system', subtype: 'init', model: 'claude-x', tools: ['Bash'], slash_commands: ['help'], mcp_servers: [{ name: 'gh', status: 'connected' }] });
    expect(c.init?.model).toBe('claude-x');
    const same = applySdk(c, { type: 'weird' });
    expect(same).toBe(c);
    expect(finishStreaming(c).retry).toBeNull();
  });
});

describe('buildRows', () => {
  it('groups consecutive Read/Grep/Glob across assistant messages into one explore row', () => {
    const c = foldMessages([
      { type: 'assistant', message: { id: '1', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/a' } }] } },
      { type: 'assistant', message: { id: '2', content: [{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'p' } }] } },
      { type: 'assistant', message: { id: '3', content: [{ type: 'text', text: 'found' }, { type: 'tool_use', id: 'e1', name: 'Edit', input: {} }] } },
    ]);
    const rows = buildRows(c.lanes[''].items, null);
    expect(rows.map((r) => r.kind)).toEqual(['explore', 'text', 'tool']);
    expect((rows[0] as any).blocks).toHaveLength(2);
  });
});

describe('usage after resume', () => {
  const history = [
    { type: 'user', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null, uuid: 'u1' },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null },
  ];
  it('a resumed transcript has no result messages: usage is unknown (not a fake $0.00 / 0 turns)', async () => {
    const { withKnownUsage } = await import('./reducer');
    const c = withKnownUsage(foldMessages(history), null);
    expect(c.usage).toMatchObject({ known: false, turns: 0 });
  });
  it('remembered totals carry over and the next turn adds to them (the SDK restarts total_cost_usd at 0)', async () => {
    const { withKnownUsage } = await import('./reducer');
    let c = withKnownUsage(foldMessages(history), { costUsd: 0.05, turns: 3, durationMs: 9000 });
    expect(c.usage).toMatchObject({ known: true, turns: 3, costUsd: 0.05 });
    c = applySdk(c, { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 1000, num_turns: 1, result: 'ok' });
    expect(c.usage.turns).toBe(4);
    expect(c.usage.costUsd).toBeCloseTo(0.06, 5);
    const r = c.lanes[''].items.at(-1) as { turnCostUsd: number };
    expect(r.turnCostUsd).toBeCloseTo(0.01, 5);
  });
  it('an empty conversation stays a normal $0.00 / 0 turns', async () => {
    const { withKnownUsage } = await import('./reducer');
    expect(withKnownUsage(emptyConversation(), null).usage.known).toBeUndefined();
  });
});
