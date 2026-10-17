import { describe, expect, it } from 'vitest';
import { sessionTitle, titleFromPrompt, TITLE_MAX } from '../src/title.js';

describe('stable session titles', () => {
  // shapes seen with the real SDK: no customTitle, `summary` = the latest prompt, `firstPrompt` = the first one
  const real = { firstPrompt: 'In greet.ts change "hello" to "hi". Do it with the Edit tool.', summary: 'Reply with the single word: RECOVERED' };
  it('uses the first prompt, not the SDK summary that follows the latest prompt', () => {
    expect(sessionTitle(real)).toBe(titleFromPrompt(real.firstPrompt));
    expect(sessionTitle({ ...real, summary: 'something else entirely' })).toBe(sessionTitle(real)); // stays the same as turns are added
  });
  it('equals the live title (derived from the same prompt with the same function)', () => {
    expect(titleFromPrompt('  In greet.ts   change\n"hello" to "hi". Do it with the Edit tool.  ')).toBe(sessionTitle(real));
  });
  it('an explicit rename wins; summary is the last fallback', () => {
    expect(sessionTitle({ ...real, customTitle: 'My title' })).toBe('My title');
    expect(sessionTitle({ summary: 'Only a summary' })).toBe('Only a summary');
    expect(sessionTitle({})).toBe('Untitled');
  });
  it('truncates long prompts', () => { expect(titleFromPrompt('x'.repeat(200)).length).toBe(TITLE_MAX); });
});
