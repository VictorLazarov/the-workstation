/** Alpha features: worktree project filing, rewind cut, task state after the turn, MCP init merge (shapes seen from the real SDK). */
import { describe, expect, it } from 'vitest';
import { addLocalUser, applySdk, applyServer, conversationBefore, emptyConversation } from './reducer';
import { deriveTasks } from '../panels/tasks/derive';
import { sessionProject, sessionWorktree } from '../store/sessions';
import type { Conversation, UserItem } from './types';

const sdk = (message: unknown) => ({ type: 'sdk', sessionId: 's', seq: 1, message });

describe('worktree session identity', () => {
  const base = { cwd: '/r/.claude/worktrees/ab12', branch: 'workstation/ab12', projectRoot: '/r' };
  it('a session opened from history is filed under its project and knows it is a worktree', () => {
    const c = emptyConversation();
    expect(sessionWorktree({ ...base, conv: c })).toEqual({ path: '/r/.claude/worktrees/ab12', branch: 'workstation/ab12', root: '/r' });
    expect(sessionProject({ ...base, conv: c })).toBe('/r');
  });
  it('a plain session is not a worktree session', () => {
    const c = emptyConversation();
    expect(sessionWorktree({ cwd: '/r', branch: 'main', projectRoot: '/r', conv: c })).toBeUndefined();
    expect(sessionProject({ cwd: '/r', conv: c })).toBe('/r');
  });
  it('the CLI init that follows the synthetic one does not forget the worktree', () => {
    let c = applySdk(emptyConversation(), { type: 'system', subtype: 'init', synthetic: true, cwd: '/r/.claude/worktrees/ab12', worktree: { path: '/r/.claude/worktrees/ab12', branch: 'workstation/ab12', root: '/r' }, mcp_servers: [] });
    c = applySdk(c, { type: 'system', subtype: 'init', cwd: '/r/.claude/worktrees/ab12', model: 'm', mcp_servers: [{ name: 'a', status: 'connected' }] });
    expect(c.init?.worktree).toMatchObject({ branch: 'workstation/ab12', root: '/r' });
    expect(sessionProject({ cwd: c.init!.cwd ?? '', conv: c })).toBe('/r');
  });
});

describe('rewind: the thread before a user message', () => {
  const thread = (): Conversation => {
    let c = addLocalUser(emptyConversation(), 'c1', 'first');
    c = applyServer(c, sdk({ type: 'user', message: { role: 'user', content: 'first' }, uuid: 'u1', clientMsgId: 'c1' }));
    c = applyServer(c, sdk({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'answer one' }] }, parent_tool_use_id: null }));
    c = addLocalUser(c, 'c2', 'second');
    c = applyServer(c, sdk({ type: 'user', message: { role: 'user', content: 'second' }, uuid: 'u2', clientMsgId: 'c2' }));
    return c;
  };
  it('keeps everything before the message and nothing from it onward', () => {
    const cut = conversationBefore(thread(), 'u2')!;
    const items = cut.lanes[''].items;
    expect(items.filter((i) => i.kind === 'user').map((i) => (i as UserItem).text)).toEqual(['first']);
    expect(JSON.stringify(items)).toContain('answer one');
    expect(JSON.stringify(items)).not.toContain('second');
    expect(cut.lanes[''].live).toBeNull();
    expect(cut.usage.known).toBe(false); // totals of the cut thread cannot be recomputed: not shown as if known
  });
  it('before the first message the thread is empty; an unknown uuid is null', () => {
    expect(conversationBefore(thread(), 'u1')!.lanes[''].items).toEqual([]);
    expect(conversationBefore(thread(), 'nope')).toBeNull();
  });
});

describe('subagent tasks after the main turn ended (real event shapes)', () => {
  it('stay running until the CLI says otherwise; stopped notification ends them; a dead session shows them stopped', () => {
    let c = emptyConversation();
    c = applySdk(c, { type: 'assistant', message: { id: 'a', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'Run sleep', subagent_type: 'general-purpose', prompt: 'x' } }] }, parent_tool_use_id: null });
    c = applySdk(c, { type: 'system', subtype: 'task_started', task_id: 'abc', tool_use_id: 'toolu_1', description: 'Run sleep', task_type: 'local_agent' });
    // the main turn is over (idle) but the session is live
    expect(deriveTasks(c, false, true)[0]).toMatchObject({ status: 'running', taskId: 'abc' });
    expect(deriveTasks(c, false, false)[0].status).toBe('stopped');
    c = applySdk(c, { type: 'system', subtype: 'task_notification', task_id: 'abc', tool_use_id: 'toolu_1', status: 'stopped', summary: 'Run sleep' });
    expect(deriveTasks(c, false, true)[0].status).toBe('stopped');
  });
});
