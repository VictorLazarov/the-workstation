import { describe, expect, it } from 'vitest';
import type { AssistantItem } from './types';
import { buildRows, isInterruptResult, latestTodoId, webVerb } from './tools';

const todoItem = (id: string, toolId: string): AssistantItem => ({ kind: 'assistant', id, msgId: id, ts: 0, blocks: [{ type: 'tool_use', id: toolId, name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'pending' }] }, final: true }] });

describe('single live checklist (M4)', () => {
  it('only the most recent TodoWrite is the live one', () => {
    const rows = buildRows([todoItem('a1', 't1'), todoItem('a2', 't2'), todoItem('a3', 't3')], null);
    expect(latestTodoId(rows)).toBe('t3');
    expect(latestTodoId(buildRows([], null))).toBeUndefined();
  });
});

describe('web step wording (pending must not say "Fetched")', () => {
  it('follows the step state', () => {
    expect(webVerb(false, 'waiting')).toBe('Fetching…');
    expect(webVerb(false, 'running')).toBe('Fetching…');
    expect(webVerb(false, 'done')).toBe('Fetched');
    expect(webVerb(false, 'denied')).toBe('Fetch denied');
    expect(webVerb(true, 'waiting')).toBe('Searching the web…');
    expect(webVerb(true, 'done')).toBe('Searched the web');
    expect(webVerb(true, 'error')).toBe('Web search failed');
  });
});

describe('a stopped run is not an error', () => {
  it('recognises the interrupt result of a tool call', () => {
    expect(isInterruptResult('[Request interrupted by user for tool use]')).toBe(true);
    expect(isInterruptResult('Error: command failed')).toBe(false);
  });
});
