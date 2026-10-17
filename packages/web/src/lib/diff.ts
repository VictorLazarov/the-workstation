export interface DiffLine { t: ' ' | '+' | '-' | '@'; text: string; oldNo?: number; newNo?: number }

const splitLines = (s: string): string[] => {
  if (s === '') return [];
  const l = s.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
};

/** Line diff via LCS (with common prefix/suffix trimming). Falls back to replace-all for huge inputs. */
export function diffLines(oldStr: string, newStr: string, startLine = 1): DiffLine[] {
  const a = splitLines(oldStr);
  const b = splitLines(newStr);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const out: DiffLine[] = [];
  let o = startLine, n = startLine;
  for (let i = 0; i < pre; i++) out.push({ t: ' ', text: a[i], oldNo: o++, newNo: n++ });

  if (am.length * bm.length > 2_000_000) {
    for (const x of am) out.push({ t: '-', text: x, oldNo: o++ });
    for (const x of bm) out.push({ t: '+', text: x, newNo: n++ });
  } else {
    const R = am.length, C = bm.length;
    const dp: Uint32Array[] = Array.from({ length: R + 1 }, () => new Uint32Array(C + 1));
    for (let i = R - 1; i >= 0; i--)
      for (let j = C - 1; j >= 0; j--)
        dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < R || j < C) {
      if (i < R && j < C && am[i] === bm[j]) { out.push({ t: ' ', text: am[i], oldNo: o++, newNo: n++ }); i++; j++; }
      else if (j < C && (i >= R || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ t: '+', text: bm[j], newNo: n++ }); j++; }
      else { out.push({ t: '-', text: am[i], oldNo: o++ }); i++; }
    }
  }
  for (let i = a.length - suf; i < a.length; i++) out.push({ t: ' ', text: a[i], oldNo: o++, newNo: n++ });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of lines) { if (l.t === '+') added++; else if (l.t === '-') removed++; }
  return { added, removed };
}

/** Keep `ctx` unchanged lines around changes; elide the rest with '@' separator lines. */
export function collapseContext(lines: DiffLine[], ctx = 2): DiffLine[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.t === '+' || l.t === '-') for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep[k] = true;
  });
  if (!keep.some(Boolean)) return lines.slice(0, 0);
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ t: '@', text: `${skipped} unchanged line${skipped > 1 ? 's' : ''}` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  return out;
}

/** SDK Edit tool `structuredPatch` ([{oldStart,newStart,lines:[' x','+y','-z']}]) -> DiffLine[] */
export function fromStructuredPatch(patch: unknown): DiffLine[] | null {
  if (!Array.isArray(patch) || !patch.length) return null;
  const out: DiffLine[] = [];
  for (const h of patch) {
    if (!h || !Array.isArray(h.lines)) return null;
    if (out.length) out.push({ t: '@', text: '' });
    let o = Number(h.oldStart ?? 1), n = Number(h.newStart ?? 1);
    for (const raw of h.lines as string[]) {
      const t = raw[0] === '+' || raw[0] === '-' ? (raw[0] as '+' | '-') : ' ';
      const text = raw.slice(1);
      if (t === ' ') out.push({ t, text, oldNo: o++, newNo: n++ });
      else if (t === '-') out.push({ t, text, oldNo: o++ });
      else out.push({ t, text, newNo: n++ });
    }
  }
  return out;
}

/** Parse a unified diff text (git diff) into lines; useful for the Changes panel. */
export function parseUnified(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0, n = 0;
  for (const raw of diff.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
    if (m) { o = +m[1]; n = +m[2]; out.push({ t: '@', text: raw }); continue; }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
    if (raw.startsWith('+')) out.push({ t: '+', text: raw.slice(1), newNo: n++ });
    else if (raw.startsWith('-')) out.push({ t: '-', text: raw.slice(1), oldNo: o++ });
    else if (raw.startsWith(' ')) out.push({ t: ' ', text: raw.slice(1), oldNo: o++, newNo: n++ });
  }
  return out;
}
