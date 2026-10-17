import { useEffect, useMemo, useState } from 'react';
import { collapseContext, type DiffLine } from '../lib/diff';
import { highlightLines, langFromPath } from '../lib/shiki';

/** Unified diff rendering with optional syntax highlighting, line numbers and context collapsing. */
export function DiffView({ lines, path, maxLines = 14, collapsed: startCollapsed = true, context = 2 }: {
  lines: DiffLine[]; path?: string; maxLines?: number; collapsed?: boolean; context?: number;
}) {
  const [expanded, setExpanded] = useState(!startCollapsed);
  const shown = useMemo(() => collapseContext(lines, context), [lines, context]);
  const visible = expanded ? shown : shown.slice(0, maxLines);
  const lang = path ? langFromPath(path) : null;
  const [hl, setHl] = useState<string[] | null>(null);

  // highlight old+new text streams separately would be exact; per-line highlight of the new-side text is good enough
  const code = useMemo(() => visible.filter((l) => l.t !== '@').map((l) => l.text).join('\n'), [visible]);
  useEffect(() => {
    let live = true;
    if (!lang || code.length > 30_000) { setHl(null); return; }
    highlightLines(code, lang).then((r) => { if (live) setHl(r); });
    return () => { live = false; };
  }, [code, lang]);

  let hi = -1;
  const hidden = shown.length - visible.length;
  return (
    <div className="diff">
      <div className="diff-scroll">
        <table className="diff-table">
          <tbody>
            {visible.map((l, i) => {
              if (l.t === '@') return <tr key={i} className="diff-sep"><td colSpan={4}>{l.text || '···'}</td></tr>;
              hi++;
              const html = hl?.[hi];
              return (
                <tr key={i} className={`diff-row diff-${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}`}>
                  <td className="diff-no">{l.oldNo ?? ''}</td>
                  <td className="diff-no">{l.newNo ?? ''}</td>
                  <td className="diff-sign">{l.t === ' ' ? '' : l.t}</td>
                  <td className="diff-code">{html != null ? <span dangerouslySetInnerHTML={{ __html: html || ' ' }} /> : l.text || ' '}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!expanded && hidden > 0 && <button type="button" className="diff-more" onClick={() => setExpanded(true)}>Show {hidden} more line{hidden > 1 ? 's' : ''}</button>}
      {expanded && shown.length > maxLines && <button type="button" className="diff-more" onClick={() => setExpanded(false)}>Collapse</button>}
    </div>
  );
}
