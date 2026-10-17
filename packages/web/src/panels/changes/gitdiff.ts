import type { DiffLine } from '../../lib/diff';

export interface GitFileDiff {
  /** path relative to the repo root (new path for renames) */
  path: string;
  oldPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  binary: boolean;
  lines: DiffLine[];
  added: number;
  removed: number;
}

const unquote = (s: string) => {
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); }
  }
  return s;
};
const stripPrefix = (s: string) => unquote(s).replace(/^[ab]\//, '');

/**
 * Parse `git diff` output (possibly many files) into per-file diffs. Header lines are only interpreted
 * before the first hunk of a file, so removed lines that begin with `--` are never mistaken for headers.
 */
export function parseGitDiff(diff: string): GitFileDiff[] {
  const out: GitFileDiff[] = [];
  let cur: GitFileDiff | null = null;
  let inHunk = false;
  let o = 0, n = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const rest = raw.slice('diff --git '.length);
      let p = rest;
      const m = /^"?a\/(.*?)"? "?b\/(.*?)"?$/.exec(rest);
      if (m) p = m[2];
      else { const h = rest.slice(Math.floor(rest.length / 2) + 1); p = stripPrefix(h); }
      cur = { path: p, status: 'modified', binary: false, lines: [], added: 0, removed: 0 };
      out.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (raw.startsWith('new file mode')) cur.status = 'added';
      else if (raw.startsWith('deleted file mode')) cur.status = 'deleted';
      else if (raw.startsWith('rename from ')) { cur.status = 'renamed'; cur.oldPath = unquote(raw.slice(12)); }
      else if (raw.startsWith('rename to ')) cur.path = unquote(raw.slice(10));
      else if (raw.startsWith('Binary files') || raw.startsWith('GIT binary patch')) cur.binary = true;
      else if (raw.startsWith('+++ ')) { const p = raw.slice(4); if (p !== '/dev/null') cur.path = stripPrefix(p); }
      else if (raw.startsWith('--- ')) { const p = raw.slice(4); if (p === '/dev/null') cur.status = 'added'; else if (cur.status === 'renamed') cur.oldPath = stripPrefix(p); }
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) { inHunk = true; o = +h[1]; n = +h[2]; cur.lines.push({ t: '@', text: raw }); continue; }
    if (!inHunk) continue;
    if (raw.startsWith('+')) { cur.lines.push({ t: '+', text: raw.slice(1), newNo: n++ }); cur.added++; }
    else if (raw.startsWith('-')) { cur.lines.push({ t: '-', text: raw.slice(1), oldNo: o++ }); cur.removed++; }
    else if (raw.startsWith(' ')) cur.lines.push({ t: ' ', text: raw.slice(1), oldNo: o++, newNo: n++ });
    // "\ No newline at end of file" and trailing blank are ignored
  }
  return out;
}

export type SplitRow = { kind: 'sep'; text: string } | { kind: 'pair'; left?: DiffLine; right?: DiffLine };

/** Pair removed/added runs side by side; context lines appear on both sides. */
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [], adds: DiffLine[] = [];
  const flush = () => {
    const k = Math.max(dels.length, adds.length);
    for (let i = 0; i < k; i++) rows.push({ kind: 'pair', left: dels[i], right: adds[i] });
    dels = []; adds = [];
  };
  for (const l of lines) {
    if (l.t === '-') dels.push(l);
    else if (l.t === '+') adds.push(l);
    else {
      flush();
      if (l.t === '@') rows.push({ kind: 'sep', text: l.text });
      else rows.push({ kind: 'pair', left: l, right: l });
    }
  }
  flush();
  return rows;
}

/** "@@ -1,3 +1,4 @@ fn()" -> "fn()" (the section heading git appends), or '' */
export function hunkLabel(text: string): string {
  const m = /^@@ [^@]*@@\s?(.*)$/.exec(text);
  return m ? m[1] : text;
}
