/** Third-party gateway: the model_not_found failure names the rejected id and offers the model picker. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { modelNotFoundText, rejectedModelFromText } from '@workstation/protocol';
import { addLocalUser, applyServer, emptyConversation } from './reducer';
import type { Conversation, NoticeItem } from './types';

beforeEach(() => { vi.spyOn(console, 'debug').mockImplementation(() => {}); });

type Ev = { type: string; message?: unknown; sessionId?: string; code?: string; model?: string };
const notices = (c: Conversation) => c.lanes[''].items.filter((i): i is NoticeItem => i.kind === 'notice');
const replay = (events: Ev[]): Conversation => events.reduce((c, e) => applyServer(c, e), addLocalUser(emptyConversation(), 'c1', 'hello'));

const CLI_TEXT = "There's an issue with the selected model (claude-haiku-4-5). It may not exist or you may not have access to it. Run /model to pick a different model.";
const synthetic: Ev = { type: 'sdk', message: { type: 'assistant', error: 'model_not_found', parent_tool_use_id: null, uuid: 'u1', message: { id: 'm1', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: CLI_TEXT }] } } };
const retry: Ev = { type: 'sdk', message: { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 404, error: 'model_not_found' } };

describe('rejected model id', () => {
  it('is read from the CLI wording', () => {
    expect(rejectedModelFromText(CLI_TEXT)).toBe('claude-haiku-4-5');
    expect(rejectedModelFromText('API Error (gpt-x): 404 model not found')).toBe('gpt-x');
    expect(rejectedModelFromText('The model foo/bar is not available on your gateway deployment.')).toBe('foo/bar');
    expect(rejectedModelFromText('something else')).toBeUndefined();
    expect(rejectedModelFromText(undefined)).toBeUndefined();
  });
  it('is named in the message, and a missing id is said plainly', () => {
    expect(modelNotFoundText('claude-sonnet-4-5')).toContain('"claude-sonnet-4-5"');
    expect(modelNotFoundText('default')).not.toContain('"default"');
    expect(modelNotFoundText()).toContain('the model this session asked for');
  });
});

describe('model_not_found banner', () => {
  it('server error event: one notice with the model and the picker action', () => {
    const c = replay([{ type: 'error', sessionId: 's', code: 'model_not_found', model: 'gw-x', message: modelNotFoundText('gw-x') }, retry, synthetic]);
    const n = notices(c);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ action: 'pick-model', model: 'gw-x', code: 'model_not_found' });
    expect(n[0].text).toContain('"gw-x"');
  });
  it('synthetic message alone (history, older server): the id comes from the CLI text', () => {
    const n = notices(replay([retry, synthetic]));
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ action: 'pick-model', model: 'claude-haiku-4-5' });
    expect(n[0].text).toContain('"claude-haiku-4-5"');
  });
});
