import { useEffect, useMemo, useState } from 'react';
import type { DiffLine } from '../../lib/diff';
import { highlightLines, langFromPath } from '../../lib/shiki';
import { hunkLabel, toSplitRows } from './gitdiff';

const PAGE = 400;

/** Highlighted html per non-separator line (index among non-'@' lines), or null while loading/unsupported. */
function useHighlight(lines: DiffLine[], path: string): string[] | null {
  const lang = langFromPath(path);
  const code = useMemo(() => lines.filter((l) => l.t !== '@').map((l) => l.text).join('\n'), [lines]);
  const [hl, setHl] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    if (!lang || code.length > 60_000) { setHl(null); return; }
    highlightLines(code, lang).then((r) => { if (live) setHl(r); });
    return () => { live = false; };
  }, [code, lang]);
  return hl;
}

const Code = ({ html, text }: { html?: string; text: string }) => (html != null ? <span dangerouslySetInnerHTML={{ __html: html || ' ' }} /> : <>{text || ' '}</>);

export function FileDiff({ lines, path, mode }: { lines: DiffLine[]; path: string; mode: 'unified' | 'split' }) {
  const [limit, setLimit] = useState(PAGE);
  const visible = useMemo(() => lines.slice(0, limit), [lines, limit]);
  const hl = useHighlight(visible, path);
  // index of each content line within the highlighted array
  const idx = useMemo(() => { const m = new Map<DiffLine, number>(); let i = 0; for (const l of visible) if (l.t !== '@') m.set(l, i++); return m; }, [visible]);
  const more = lines.length - visible.length;
  if (!lines.length) return <div className="cdiff-empty">No textual changes.</div>;

  let body;
  if (mode === 'unified') {
    body = (
      <table className="diff-table cdiff-table">
        <tbody>
          {visible.map((l, i) => l.t === '@'
            ? <tr key={i} className="diff-sep"><td colSpan={4}>{hunkLabel(l.text) || '···'}</td></tr>
            : (
              <tr key={i} className={`diff-row diff-${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}`}>
                <td className="diff-no">{l.oldNo ?? ''}</td><td className="diff-no">{l.newNo ?? ''}</td>
                <td className="diff-sign">{l.t === ' ' ? '' : l.t}</td>
                <td className="diff-code"><Code html={hl?.[idx.get(l)!]} text={l.text} /></td>
              </tr>
            ))}
        </tbody>
      </table>
    );
  } else {
    const rows = toSplitRows(visible);
    const side = (l: DiffLine | undefined, which: 'l' | 'r') => {
      const cls = !l ? 'diff-empty' : l.t === '+' ? 'diff-add' : l.t === '-' ? 'diff-del' : 'diff-ctx';
      return (
        <>
          <td className={`diff-no ${cls}`}>{l ? (which === 'l' ? l.oldNo : l.newNo) ?? '' : ''}</td>
          <td className={`diff-code ${cls}`}>{l && <Code html={hl?.[idx.get(l)!]} text={l.text} />}</td>
        </>
      );
    };
    body = (
      <table className="diff-table cdiff-table split">
        <colgroup><col className="c-no" /><col /><col className="c-no" /><col /></colgroup>
        <tbody>
          {rows.map((r, i) => r.kind === 'sep'
            ? <tr key={i} className="diff-sep"><td colSpan={4}>{hunkLabel(r.text) || '···'}</td></tr>
            : <tr key={i} className="diff-row split-row">{side(r.left, 'l')}{side(r.right, 'r')}</tr>)}
        </tbody>
      </table>
    );
  }
  return (
    <div className="cdiff">
      <div className="cdiff-scroll">{body}</div>
      {more > 0 && (
        <button type="button" className="diff-more" onClick={() => setLimit(limit + PAGE * 5)}>Show {Math.min(more, PAGE * 5)} more of {more} lines</button>
      )}
    </div>
  );
}
