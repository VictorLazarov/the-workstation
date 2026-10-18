import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySdk, emptyConversation, foldMessages, placeResult, replayOnto } from './reducer';
import { rankSlash, slashRunsOnEnter, type SlashOption } from './slash';
import { truncate } from './utils';
import { usableModes } from '../components/Chips';
import type { AssistantItem } from './types';

const user = (uuid: string, text: string) => ({ type: 'user', uuid, message: { role: 'user', content: text }, parent_tool_use_id: null });
const asst = (id: string, text: string) => ({ type: 'assistant', uuid: 'u-' + id, message: { id, role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
const result = (cost: number) => ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: cost, duration_ms: 10, num_turns: 1 });
const kinds = (c: ReturnType<typeof emptyConversation>) => (c.lanes.main?.items ?? Object.values(c.lanes)[0]!.items).map((i) => ({ user: 'U', assistant: 'A', result: 'R', notice: 'N' } as Record<string, string>)[i.kind] ?? '?').join('');

describe('replayOnto: turn footers follow their own turn (pass 5, minor 1)', () => {
  const transcript = [user('u1', 'one'), asst('m1', 'answer one'), user('u2', 'two'), asst('m2', 'answer two')];
  const buffer = [user('u1', 'one'), asst('m1', 'answer one'), result(0.01), user('u2', 'two'), asst('m2', 'answer two'), result(0.03)];

  it('naive replay stacks the footers at the end (the bug), replayOnto does not', () => {
    const naive = buffer.reduce(applySdk, foldMessages(transcript));
    expect(kinds(naive)).toBe('UAUARR');
    expect(kinds(replayOnto(foldMessages(transcript), buffer))).toBe('UARUAR');
  });
  // items are stamped with Date.now(): freeze it so two folds of the same transcript compare equal even across a clock tick
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000); });
  afterEach(() => { vi.useRealTimers(); });
  it('a turn that only exists in the buffer stays in order, and no events is a no-op', () => {
    const c = replayOnto(foldMessages(transcript.slice(0, 2)), buffer);
    expect(kinds(c)).toBe('UARUAR');
    expect(replayOnto(foldMessages(transcript), [])).toEqual(foldMessages(transcript));
    const last = (c.lanes.main?.items ?? Object.values(c.lanes)[0]!.items).filter((i) => i.kind === 'assistant') as AssistantItem[];
    expect(last.map((a) => a.msgId)).toEqual(['m1', 'm2']);
  });
});

describe('placeResult: a replayed result that arrives AFTER the history fetch (live path)', () => {
  const transcript = [user('u1', 'one'), asst('m1', 'answer one'), user('u2', 'two'), asst('m2', 'answer two')];
  it('is moved after its own turn, while a normal live result (always last) is untouched', () => {
    const late = applySdk(foldMessages(transcript), result(0.01));
    expect(kinds(late)).toBe('UAUAR');
    expect(kinds(placeResult(late, asst('m1', 'answer one'), true))).toBe('UARUA');
    expect(kinds(placeResult(late, asst('m2', 'answer two'), true))).toBe('UAUAR');
    expect(kinds(placeResult(late, null, true))).toBe('UAUAR');
  });
});

describe('placeholder assistant text', () => {
  it('"No response requested." is not shown as an answer', () => {
    const c = applySdk(applySdk(emptyConversation(), user('u1', 'hi')), asst('m1', 'No response requested.'));
    expect(kinds(c)).toBe('U');
    expect(kinds(applySdk(c, asst('m2', 'A real answer. No response requested. is fine inside text')))).toBe('UA');
  });
});

describe('truncate prints one ellipsis', () => {
  it('never doubles an ellipsis that is already there', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(truncate('Create lib/format.js exporting formatTodo(todo) returning…', 40).endsWith('……')).toBe(false);
    expect(truncate('Create lib/format.js exp... more text here', 22)).toBe('Create lib/format.js…');
    expect(truncate('x'.repeat(10) + '...' + 'y'.repeat(10), 13)).toBe('xxxxxxxxxx…');
    expect(truncate('short', 40)).toBe('short');
  });
});

describe('slash menu ranking', () => {
  const o = (id: string, hint?: string): SlashOption => ({ id, label: '/' + id, insert: `/${id} `, hint });
  const all = [o('__remote-workflow'), o('my-skill'), o('compact'), o('model', '[model]'), o('mcp-tools'), o('review', '<pr>'), o('init'), o('other-model-skill')];
  it('hides internal commands, built-ins before skills, prefix matches before fuzzy ones', () => {
    expect(rankSlash(all, '').map((x) => x.id)).not.toContain('__remote-workflow');
    expect(rankSlash(all, '').slice(0, 4).map((x) => x.id).sort()).toEqual(['compact', 'init', 'model', 'review']);
    expect(rankSlash(all, 'mod').map((x) => x.id)).toEqual(['model', 'other-model-skill']);
    expect(rankSlash(all, 'm').map((x) => x.id)[0]).toBe('model'); // built-in prefix first, then the skill
  });
  it('Enter runs unless the command needs an argument', () => {
    expect(slashRunsOnEnter(o('compact'))).toBe(true);
    expect(slashRunsOnEnter(o('model', '[model]'))).toBe(true);
    expect(slashRunsOnEnter(o('review', '<pr>'))).toBe(false);
  });
});

describe('bypass availability in the UI', () => {
  it('Shift+Tab / palette only offer Bypass when the server can do it', () => {
    expect(usableModes({ available: true }).map((m) => m.id)).toContain('bypassPermissions');
    expect(usableModes({ available: false }).map((m) => m.id)).not.toContain('bypassPermissions');
  });
});
