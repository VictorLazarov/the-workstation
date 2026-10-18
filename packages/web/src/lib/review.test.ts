import { describe, expect, it } from 'vitest';
import { formatReview, type ReviewComment } from './review';

const c = (p: Partial<ReviewComment>): ReviewComment => ({ id: 'x', path: '/p/src/a.ts', rel: 'src/a.ts', line: 1, side: 'new', code: 'const a = 1;', text: 'rename', ...p });

describe('formatReview: all comments become one prompt', () => {
  it('groups by file, orders by line, names removed lines, keeps multi-line comments together', () => {
    const text = formatReview([
      c({ line: 20, text: 'second\nthird line' }),
      c({ line: 3, side: 'old', code: '  oldCall(`x`)', text: 'why removed?' }),
      c({ rel: 'src/b.ts', path: '/p/src/b.ts', line: 7, code: '', text: 'add a test' }),
    ]);
    expect(text).toBe([
      'I reviewed your changes and left 3 comments. Please address each one, then summarize what you changed.',
      '',
      'src/a.ts',
      "- removed line 3 (`oldCall('x')`): why removed?",
      '- line 20 (`const a = 1;`): second',
      '  third line',
      '',
      'src/b.ts',
      '- line 7: add a test',
    ].join('\n'));
  });
  it('singular wording and long code snippets are clipped', () => {
    const t = formatReview([c({ code: 'x'.repeat(300) })]);
    expect(t.startsWith('I reviewed your changes and left 1 comment.')).toBe(true);
    expect(t).toContain('…');
    expect(t.length).toBeLessThan(400);
  });
});
