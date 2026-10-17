import { describe, expect, it } from 'vitest';
import { emptyConversation } from '../../lib/reducer';
import type { Conversation } from '../../lib/types';
import { absPath, matchesFocus, mergeChanges, porcelainStatus, sessionFiles } from './derive';
import { hunkLabel, parseGitDiff, toSplitRows } from './gitdiff';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@ function a()
 keep
--- sql comment
+-- changed comment
 tail
@@ -20,2 +20,3 @@
 x
+added
 y
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+one
+two
diff --git a/old.bin b/old.bin
deleted file mode 100644
Binary files a/old.bin and /dev/null differ
diff --git a/x.ts b/y.ts
similarity index 90%
rename from x.ts
rename to y.ts
`;

describe('parseGitDiff', () => {
  const files = parseGitDiff(DIFF);
  it('splits files and statuses', () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([['src/a.ts', 'modified'], ['new.txt', 'added'], ['old.bin', 'deleted'], ['y.ts', 'renamed']]);
    expect(files[3].oldPath).toBe('x.ts');
    expect(files[2].binary).toBe(true);
  });
  it('counts and numbers lines, never treating "--- x" removals as headers', () => {
    const a = files[0];
    expect(a.added).toBe(2);
    expect(a.removed).toBe(1);
    expect(a.lines.find((l) => l.t === '-')).toMatchObject({ text: '-- sql comment', oldNo: 2 });
    expect(a.lines.find((l) => l.t === '+')).toMatchObject({ text: '-- changed comment', newNo: 2 });
    expect(a.lines.filter((l) => l.t === '@')).toHaveLength(2);
    expect(files[1]).toMatchObject({ added: 2, removed: 0 });
  });
  it('hunkLabel', () => { expect(hunkLabel('@@ -1,4 +1,4 @@ function a()')).toBe('function a()'); expect(hunkLabel('@@ -1 +1 @@')).toBe(''); });
});

describe('toSplitRows', () => {
  it('pairs runs and mirrors context', () => {
    const rows = toSplitRows(parseGitDiff(DIFF)[0].lines);
    expect(rows[0]).toMatchObject({ kind: 'sep' });
    expect(rows[1]).toMatchObject({ kind: 'pair', left: { text: 'keep' }, right: { text: 'keep' } });
    expect(rows[2]).toMatchObject({ kind: 'pair', left: { t: '-' }, right: { t: '+' } });
  });
  it('handles uneven runs', () => {
    const rows = toSplitRows([{ t: '-', text: 'a' }, { t: '-', text: 'b' }, { t: '+', text: 'c' }]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ left: { text: 'b' }, right: undefined });
  });
});

function convWithEdits(): Conversation {
  const c = emptyConversation();
  c.lanes[''] = { live: null, items: [{ kind: 'assistant', id: 'a1', msgId: 'm', ts: 1, blocks: [
    { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/p/src/a.ts', old_string: 'one\n', new_string: 'two\nthree\n' }, final: true },
    { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/p/new.ts', content: 'a\nb\n' }, final: true },
    { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/p/src/a.ts', old_string: 'x', new_string: 'y' }, final: true },
    { type: 'tool_use', id: 't4', name: 'Edit', input: { file_path: '/p/failed.ts', old_string: 'x', new_string: 'y' }, final: true },
    { type: 'tool_use', id: 't5', name: 'Edit', input: { file_path: '/p/pending.ts', old_string: 'x', new_string: 'y' }, final: true },
  ] }] };
  const r = (content: string, isError = false) => ({ content, isError, images: [] });
  c.toolResults = { t1: r('ok'), t2: r('File created successfully'), t3: r('ok'), t4: r('nope', true) };
  return c;
}

describe('sessionFiles', () => {
  const files = sessionFiles(convWithEdits(), '/p');
  it('aggregates per file, skipping failed and pending edits', () => {
    expect(files.map((f) => f.path)).toEqual(['/p/src/a.ts', '/p/new.ts']);
    expect(files[0]).toMatchObject({ added: 3, removed: 2, edits: 2 });
    expect(files[1]).toMatchObject({ added: 2, removed: 0, isNew: true });
  });
});

describe('mergeChanges', () => {
  const session = sessionFiles(convWithEdits(), '/p');
  it('uses git as truth inside a repo and drops clean session files', () => {
    const m = mergeChanges('/p', {
      isRepo: true, root: '/p',
      files: [{ path: 'src/a.ts', index: ' ', worktree: 'M' }, { path: 'other.md', index: '?', worktree: '?' }],
      diffs: { '/p/src/a.ts': { path: 'src/a.ts', status: 'modified', binary: false, lines: [], added: 7, removed: 1 } },
    }, session);
    expect(m.map((f) => [f.rel, f.status, f.added, f.bySession, f.source])).toEqual([
      ['other.md', 'untracked', undefined, false, 'git'], ['src/a.ts', 'modified', 7, true, 'git'],
    ]);
  });
  it('falls back to session edits without git', () => {
    const m = mergeChanges('/p', { isRepo: false, files: [], diffs: {} }, session);
    expect(m.map((f) => [f.rel, f.status, f.source])).toEqual([['new.ts', 'added', 'session'], ['src/a.ts', 'modified', 'session']]);
    expect(mergeChanges('/p', null, [])).toEqual([]);
  });
  it('keeps session files outside the repo root', () => {
    const m = mergeChanges('/p', { isRepo: true, root: '/p', files: [], diffs: {} }, [{ ...session[0], path: '/elsewhere/z.ts' }]);
    expect(m).toHaveLength(1);
  });
  it('helpers', () => {
    expect(porcelainStatus({ path: 'a', index: 'A', worktree: ' ' })).toBe('added');
    expect(porcelainStatus({ path: 'a', index: ' ', worktree: 'D' })).toBe('deleted');
    expect(absPath('src/../a.ts', '/p/')).toBe('/p/a.ts');
    expect(matchesFocus({ path: '/p/a.ts' } as never, 'a.ts', '/p')).toBe(true);
  });
});
