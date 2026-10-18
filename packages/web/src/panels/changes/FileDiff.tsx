import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffLine } from '../../lib/diff';
import { highlightLines, langFromPath } from '../../lib/shiki';
import { hunkLabel, toSplitRows, type SplitRow } from './gitdiff';
import { useComments, useReview } from '../../store/review';
import type { ReviewComment } from '../../lib/review';
import { Icon } from '../../components/Icon';

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

/** A line a comment can be left on: the new side for added/context lines, the old side for removed ones. */
const anchorOf = (l: DiffLine): { line: number; side: 'new' | 'old' } | null =>
  l.t === '@' ? null : l.t === '-' ? (l.oldNo != null ? { line: l.oldNo, side: 'old' } : null) : l.newNo != null ? { line: l.newNo, side: 'new' } : null;

export interface ReviewTarget { sessionId: string; rel: string; path: string }
type Target = { line: number; side: 'new' | 'old'; code: string };
const sameLine = (c: ReviewComment, l: DiffLine) => { const a = anchorOf(l); return !!a && a.line === c.line && a.side === c.side; };

function CommentButton({ l, onOpen }: { l: DiffLine; onOpen: (t: Target) => void }) {
  const a = anchorOf(l);
  if (!a) return null;
  return <button type="button" className="diff-cbtn" aria-label={`Comment on ${a.side === 'old' ? 'removed ' : ''}line ${a.line}`} title="Comment on this line" onClick={() => onOpen({ ...a, code: l.text })}><Icon name="plus" size={11} /></button>;
}

function CommentEditor({ target, review, onClose }: { target: Target; review: ReviewTarget; onClose: () => void }) {
  const [text, setText] = useState('');
  const add = () => { if (!text.trim()) return; useReview.getState().add(review.sessionId, { path: review.path, rel: review.rel, ...target, text: text.trim() }); onClose(); };
  return (
    <div className="cmt cmt-edit">
      <div className="cmt-where">{target.side === 'old' ? 'Removed line' : 'Line'} {target.line}</div>
      <textarea autoFocus rows={2} value={text} aria-label="Comment" placeholder="What should change here?" onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } else if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }} />
      <div className="cmt-actions">
        <button type="button" className="btn primary" disabled={!text.trim()} onClick={add}>Add comment</button>
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function CommentView({ c, sessionId }: { c: ReviewComment; sessionId: string }) {
  return (
    <div className="cmt">
      <div className="cmt-where">{c.side === 'old' ? 'Removed line' : 'Line'} {c.line}</div>
      <div className="cmt-text">{c.text}</div>
      <button type="button" className="icon-btn cmt-del" aria-label={`Delete comment on line ${c.line}`} title="Delete comment" onClick={() => useReview.getState().remove(sessionId, c.id)}><Icon name="x" size={12} /></button>
    </div>
  );
}

const Code = ({ html, text }: { html?: string; text: string }) => (html != null ? <span dangerouslySetInnerHTML={{ __html: html || ' ' }} /> : <>{text || ' '}</>);

/**
 * Side-by-side diff: the old and the new file are two panes made of the SAME rows (so lines stay aligned, an empty cell
 * fills the gap where the other side has no line) and they scroll together, vertically and horizontally.
 */
function SplitDiff({ rows, hl, idx, onComment }: { rows: SplitRow[]; hl: string[] | null; idx: Map<DiffLine, number>; onComment?: (t: Target) => void }) {
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const sync = (src: React.RefObject<HTMLDivElement>, dst: React.RefObject<HTMLDivElement>) => () => {
    const from = src.current, to = dst.current; // resolved when the scroll happens (refs are empty at first render)
    if (!from || !to) return;
    if (to.scrollTop !== from.scrollTop) to.scrollTop = from.scrollTop;
    if (to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft;
  };
  const cell = (l: DiffLine | undefined, which: 'l' | 'r') => {
    const cls = !l ? 'diff-empty' : l.t === '+' ? 'diff-add' : l.t === '-' ? 'diff-del' : 'diff-ctx';
    return (
      <>
        <td className={`diff-no ${cls}`}>{l ? (which === 'l' ? l.oldNo : l.newNo) ?? '' : ''}{l && onComment && (which === 'r' ? l.t !== '-' : l.t === '-') && <CommentButton l={l} onOpen={onComment} />}</td>
        <td className={`diff-code ${cls}`}>{l ? <Code html={hl?.[idx.get(l)!]} text={l.text} /> : ' '}</td>
      </>
    );
  };
  const table = (which: 'l' | 'r') => (
    <table className="diff-table split-table">
      <tbody>
        {rows.map((r, i) => r.kind === 'sep'
          ? <tr key={i} className="diff-sep"><td colSpan={2}>{which === 'l' ? hunkLabel(r.text) || '···' : ' '}</td></tr>
          : <tr key={i} className="diff-row">{cell(which === 'l' ? r.left : r.right, which)}</tr>)}
      </tbody>
    </table>
  );
  return (
    <div className="split-panes">
      <div className="split-pane old" ref={left} onScroll={sync(left, right)} aria-label="Before" role="region" tabIndex={-1}>{table('l')}</div>
      <div className="split-pane new" ref={right} onScroll={sync(right, left)} aria-label="After" role="region" tabIndex={0}>{table('r')}</div>
    </div>
  );
}

export function FileDiff({ lines, path, mode, review }: { lines: DiffLine[]; path: string; mode: 'unified' | 'split'; review?: ReviewTarget }) {
  const [limit, setLimit] = useState(PAGE);
  const visible = useMemo(() => lines.slice(0, limit), [lines, limit]);
  const hl = useHighlight(visible, path);
  // index of each content line within the highlighted array
  const idx = useMemo(() => { const m = new Map<DiffLine, number>(); let i = 0; for (const l of visible) if (l.t !== '@') m.set(l, i++); return m; }, [visible]);
  const more = lines.length - visible.length;
  const comments = useComments(review?.sessionId ?? '').filter((c) => c.path === path);
  const [target, setTarget] = useState<Target | null>(null);
  const open = review ? (t: Target) => setTarget(t) : undefined;
  if (!lines.length) return <div className="cdiff-empty">No textual changes.</div>;

  let body;
  if (mode === 'unified') {
    body = (
      <table className="diff-table cdiff-table">
        <tbody>
          {visible.map((l, i) => {
            if (l.t === '@') return <tr key={i} className="diff-sep"><td colSpan={4}>{hunkLabel(l.text) || '···'}</td></tr>;
            const here = comments.filter((c) => sameLine(c, l));
            const a = anchorOf(l);
            const editing = !!target && !!a && a.line === target.line && a.side === target.side;
            return (
              <Fragment key={i}>
                <tr className={`diff-row diff-${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}`}>
                  <td className="diff-no">{l.oldNo ?? ''}{l.t === '-' && open && <CommentButton l={l} onOpen={open} />}</td>
                  <td className="diff-no">{l.newNo ?? ''}{l.t !== '-' && open && <CommentButton l={l} onOpen={open} />}</td>
                  <td className="diff-sign">{l.t === ' ' ? '' : l.t}</td>
                  <td className="diff-code"><Code html={hl?.[idx.get(l)!]} text={l.text} /></td>
                </tr>
                {(here.length > 0 || editing) && (
                  <tr className="diff-cmt-row"><td colSpan={4}><div className="cmt-stack">
                    {here.map((c) => <CommentView key={c.id} c={c} sessionId={review!.sessionId} />)}
                    {editing && review && <CommentEditor target={target!} review={review} onClose={() => setTarget(null)} />}
                  </div></td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    );
  } else {
    const rows = toSplitRows(visible);
    body = <SplitDiff rows={rows} hl={hl} idx={idx} onComment={open} />;
  }
  return (
    <div className="cdiff">
      <div className="cdiff-scroll">{body}</div>
      {mode === 'split' && review && (comments.length > 0 || target) && (
        // side by side, both panes must stay row-aligned, so comments are listed under the diff instead of between its rows
        <div className="cmt-stack cmt-below">
          {comments.map((c) => <CommentView key={c.id} c={c} sessionId={review.sessionId} />)}
          {target && <CommentEditor target={target} review={review} onClose={() => setTarget(null)} />}
        </div>
      )}
      {more > 0 && (
        <button type="button" className="diff-more" onClick={() => setLimit(limit + PAGE * 5)}>Show {Math.min(more, PAGE * 5)} more of {more} lines</button>
      )}
    </div>
  );
}
