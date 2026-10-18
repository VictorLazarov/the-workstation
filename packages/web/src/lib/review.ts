/** Line comments left on a diff, batched into ONE prompt for the agent. */
export interface ReviewComment {
  id: string;
  /** absolute path (what the Changes panel keys files by) and the project-relative one shown to the agent */
  path: string;
  rel: string;
  /** line number on the new side, or on the old side for a removed line */
  line: number;
  side: 'new' | 'old';
  /** the line's text, so the agent finds it even if the file moved on */
  code: string;
  text: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** The single prompt sent for a review: grouped by file, each comment with its line and a snippet of that line. */
export function formatReview(comments: ReviewComment[]): string {
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) byFile.set(c.rel, [...(byFile.get(c.rel) ?? []), c]);
  const out: string[] = [`I reviewed your changes and left ${comments.length} comment${comments.length === 1 ? '' : 's'}. Please address each one, then summarize what you changed.`];
  for (const [rel, list] of byFile) {
    out.push('', rel);
    for (const c of [...list].sort((a, b) => a.line - b.line)) {
      const where = c.side === 'old' ? `removed line ${c.line}` : `line ${c.line}`;
      const code = c.code.trim() ? ` (\`${clip(c.code.trim(), 100).replace(/`/g, "'")}\`)` : '';
      const lines = c.text.trim().split('\n');
      out.push(`- ${where}${code}: ${lines[0]}`, ...lines.slice(1).map((l) => `  ${l}`));
    }
  }
  return out.join('\n');
}
