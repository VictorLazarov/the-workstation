import { describe, expect, it } from 'vitest';
import { resolveBranch } from './derive';

describe('one branch everywhere (M6)', () => {
  it('prefers the worktree branch, then live git, and only then the recorded one', () => {
    expect(resolveBranch({ worktree: 'wt/x', recorded: 'main', git: { loaded: true, isRepo: true, branch: 'master' } })).toBe('wt/x');
    expect(resolveBranch({ recorded: 'main', git: { loaded: true, isRepo: true, branch: 'master' } })).toBe('master');
    expect(resolveBranch({ recorded: 'main', git: { loaded: false, isRepo: false } })).toBe('main');
  });
  it('shows no branch when git says this is not a repository', () => {
    expect(resolveBranch({ recorded: 'main', git: { loaded: true, isRepo: false } })).toBeUndefined();
  });
});
