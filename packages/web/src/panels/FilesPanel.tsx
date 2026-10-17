import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FsEntry } from '@workstation/protocol';
import { api } from '../lib/api';
import { highlightLines, langFromPath } from '../lib/shiki';
import { basename, dirname, relPath } from '../lib/utils';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { CopyButton, IconButton, Spinner } from '../components/ui';
import { platform } from '../platform';
import { useUi } from '../store/ui';
import { registerPanel, type PanelProps } from './registry';
import { porcelainStatus, absPath } from './changes/derive';
import { selectGit, useGit } from './changes/store';
import { HIDDEN, formatBytes, imageSrc, viewKind, type ViewKind } from './files/util';
import './panels.css';

type Children = FsEntry[] | 'loading' | { error: string };
interface Mem { open: Set<string>; kids: Map<string, Children>; file?: string; query: string }
const mem = new Map<string, Mem>(); // survives tab switches, per session
const memFor = (id: string): Mem => { let m = mem.get(id); if (!m) { m = { open: new Set(), kids: new Map(), query: '' }; mem.set(id, m); } return m; };

export function mentionInChat(cwd: string, abs: string) {
  window.dispatchEvent(new CustomEvent('ws:mention', { detail: relPath(abs, cwd) }));
}

/* ───────────── tree ───────────── */
function useDirty(id: string, cwd: string): Map<string, string> {
  const git = useGit(selectGit(id));
  return useMemo(() => {
    const m = new Map<string, string>();
    if (!git.isRepo || !git.root) return m;
    for (const f of git.files) {
      const abs = absPath(f.path.replace(/\/$/, ''), git.root);
      const st = porcelainStatus(f);
      m.set(abs, st === 'untracked' ? 'U' : st === 'added' ? 'A' : st === 'deleted' ? 'D' : 'M');
      for (let d = dirname(abs); d.length > cwd.length - 1 && d.startsWith(cwd.replace(/\/+$/, '')); d = dirname(d)) { if (m.get(d) === 'dir') break; m.set(d, 'dir'); if (d === cwd) break; }
    }
    return m;
  }, [git, cwd]);
}

function Tree({ id, cwd, mem: m, onOpen, selected, force }: { id: string; cwd: string; mem: Mem; onOpen: (p: string) => void; selected?: string; force: () => void }) {
  const dirty = useDirty(id, cwd);
  const load = useCallback((dir: string) => {
    if (m.kids.has(dir)) return;
    m.kids.set(dir, 'loading'); force();
    api.fsList(dir).then((es) => m.kids.set(dir, es.filter((e) => !HIDDEN.has(e.name)))).catch((e) => m.kids.set(dir, { error: e instanceof Error ? e.message : String(e) })).finally(force);
  }, [m, force]);
  useEffect(() => { load(cwd); }, [cwd, load]);
  const toggle = (e: FsEntry) => {
    if (m.open.has(e.path)) m.open.delete(e.path); else { m.open.add(e.path); load(e.path); }
    force();
  };
  const render = (dir: string, depth: number): React.ReactNode => {
    const kids = m.kids.get(dir);
    if (!kids || kids === 'loading') return <div className="ftree-msg" style={{ paddingLeft: 12 + depth * 14 }}><Spinner size={11} /> Loading…</div>;
    if ('error' in kids) return <div className="ftree-msg err" style={{ paddingLeft: 12 + depth * 14 }}>{kids.error}</div>;
    if (!kids.length) return <div className="ftree-msg" style={{ paddingLeft: 12 + depth * 14 }}>Empty</div>;
    return kids.map((e) => {
      const isDir = e.kind === 'dir';
      const open = m.open.has(e.path);
      const st = dirty.get(e.path);
      return (
        <div key={e.path}>
          <button type="button" className={`frow${selected === e.path ? ' sel' : ''}${e.name.startsWith('.') ? ' dim' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}
            aria-expanded={isDir ? open : undefined} onClick={() => (isDir ? toggle(e) : onOpen(e.path))} title={relPath(e.path, cwd)}>
            {isDir ? <Icon name="chevron-right" size={12} className={`frow-chev${open ? ' open' : ''}`} /> : <span className="frow-chev" />}
            <Icon name={isDir ? (open ? 'folder-open' : 'folder') : 'file'} size={14} className={isDir ? 'frow-ico dir' : 'frow-ico'} />
            <span className="frow-name">{e.name}</span>
            {st && st !== 'dir' && <span className={`cstatus cs-${st === 'U' ? 'untracked' : st === 'A' ? 'added' : st === 'D' ? 'deleted' : 'modified'} sm`}>{st}</span>}
            {st === 'dir' && <span className="cdot" title="Contains changes" />}
          </button>
          {isDir && open && render(e.path, depth + 1)}
        </div>
      );
    });
  };
  return <div className="ftree" role="tree">{render(cwd, 0)}</div>;
}

/* ───────────── viewer ───────────── */
interface Loaded { content: string; encoding: string; truncated: boolean; size?: number }

function CodeView({ text, path }: { text: string; path: string }) {
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text]);
  const [limit, setLimit] = useState(1500);
  const shown = lines.slice(0, limit);
  const [hl, setHl] = useState<string[] | null>(null);
  const lang = langFromPath(path);
  const chunk = useMemo(() => shown.join('\n'), [shown]);
  useEffect(() => {
    let live = true;
    setHl(null);
    if (!lang || chunk.length > 200_000) return;
    highlightLines(chunk, lang).then((r) => { if (live) setHl(r); });
    return () => { live = false; };
  }, [chunk, lang]);
  return (
    <div className="fcode">
      <table className="diff-table"><tbody>
        {shown.map((l, i) => (
          <tr key={i}>
            <td className="diff-no">{i + 1}</td>
            <td className="diff-code">{hl?.[i] != null ? <span dangerouslySetInnerHTML={{ __html: hl[i] || ' ' }} /> : l || ' '}</td>
          </tr>
        ))}
      </tbody></table>
      {lines.length > limit && <button type="button" className="diff-more" onClick={() => setLimit(limit + 3000)}>Show more ({lines.length - limit} lines left)</button>}
    </div>
  );
}

function Viewer({ cwd, path, onBack }: { cwd: string; path: string; onBack: () => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState('');
  const [raw, setRaw] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setData(null); setErr(''); setRaw(false);
    api.fsRead(path).then((r) => { if (live) setData(r as Loaded); }).catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [path, nonce]);
  const kind: ViewKind | null = data ? viewKind(path, data.encoding) : null;
  const rel = relPath(path, cwd);
  const canEditor = !!platform.openInEditor, canReveal = !!platform.revealInFinder;
  return (
    <div className="fview">
      <div className="fview-head">
        <div className="fview-top">
          <IconButton icon="chevron-right" label="Back to files" onClick={onBack} size={15} className="fview-back" />
          <div className="fview-title" title={path}><b>{basename(path)}</b><span className="muted small">{dirname(rel) || '.'}{data?.size !== undefined ? ` · ${formatBytes(data.size)}` : ''}</span></div>
        </div>
        <div className="fview-actions">
          <button type="button" className="btn ghost sm" title="Insert @path into the message box" onClick={() => mentionInChat(cwd, path)}><Icon name="chat" size={13} /> Mention</button>
          {(kind === 'markdown' || kind === 'svg') && <button type="button" className="btn ghost sm" onClick={() => setRaw(!raw)}>{raw ? 'Preview' : 'Source'}</button>}
          <CopyButton text={rel} label="Copy path" />
          {canEditor && <IconButton icon="external" label="Open in editor" size={14} onClick={() => void platform.openInEditor!(path)} />}
          {canReveal && <IconButton icon="folder-open" label="Reveal in file manager" size={14} onClick={() => void platform.revealInFinder!(path)} />}
          <IconButton icon="refresh" label="Reload" size={14} onClick={() => setNonce(nonce + 1)} />
        </div>
      </div>
      <div className="fview-body">
        {err ? <div className="panel-empty"><Icon name="alert" size={20} /><b>Can't open this file</b><span>{err}</span></div>
          : !data ? <div className="panel-empty"><Spinner size={18} /></div>
          : kind === 'image' || (kind === 'svg' && !raw) ? <div className="fimg"><img src={imageSrc(path, kind, data.content)} alt={basename(path)} /></div>
          : kind === 'binary' ? <div className="panel-empty"><Icon name="file" size={22} /><b>Binary file</b><span>{data.truncated ? `Too large to preview (${formatBytes(data.size)}).` : `${formatBytes(data.size)}. No preview available.`}</span></div>
          : kind === 'markdown' && !raw ? <div className="fmd"><Markdown text={data.content} /></div>
          : <>{data.truncated && <div className="changes-note"><Icon name="info" size={13} /> Showing the first {formatBytes(data.content.length)} of {formatBytes(data.size)}.</div>}<CodeView text={data.content} path={path} /></>}
      </div>
    </div>
  );
}

/* ───────────── panel ───────────── */
function FilesPanel({ sessionId, cwd, focus }: PanelProps) {
  const m = memFor(sessionId);
  const [, setTick] = useState(0);
  const force = useCallback(() => setTick((n) => n + 1), []);
  const [query, setQuery] = useState(m.query);
  const [results, setResults] = useState<string[] | null>(null);
  const [searching, setSearching] = useState(false);
  const lastFocus = useRef<string>();
  useEffect(() => { if (focus && focus !== lastFocus.current) { lastFocus.current = focus; m.file = absPath(focus, cwd); force(); } }, [focus, cwd, m, force]);
  useEffect(() => {
    m.query = query;
    if (!query.trim()) { setResults(null); setSearching(false); return; }
    setSearching(true);
    let live = true;
    const t = setTimeout(() => {
      api.searchFiles(cwd, query.trim()).then((r) => { if (live) { setResults(r); setSearching(false); } }).catch(() => { if (live) { setResults([]); setSearching(false); } });
    }, 160);
    return () => { live = false; clearTimeout(t); };
  }, [query, cwd, m]);
  const open = (p: string) => { m.file = p; force(); };
  if (m.file) return <Viewer cwd={cwd} path={m.file} onBack={() => { m.file = undefined; force(); }} />;
  return (
    <div className="files">
      <div className="files-bar">
        <div className="files-search">
          <Icon name="search" size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find file…" aria-label="Find file" spellCheck={false} />
          {query && <IconButton icon="x" label="Clear" size={13} onClick={() => setQuery('')} />}
        </div>
        <IconButton icon="refresh" label="Refresh tree" size={15} onClick={() => { m.kids.clear(); force(); }} />
      </div>
      <div className="files-root" title={cwd}><Icon name="folder-open" size={13} />{basename(cwd)}</div>
      {results ? (
        results.length ? (
          <div className="ftree">{results.map((p) => (
            <button key={p} type="button" className="frow" onClick={() => open(absPath(p, cwd))} title={p}>
              <span className="frow-chev" /><Icon name="file" size={14} className="frow-ico" />
              <span className="frow-name">{basename(p)}</span><span className="frow-dir">{dirname(p)}</span>
            </button>
          ))}</div>
        ) : <div className="ftree-msg">{searching ? <><Spinner size={11} /> Searching…</> : 'No matching files'}</div>
      ) : <Tree id={sessionId} cwd={cwd} mem={m} onOpen={open} selected={m.file} force={force} />}
    </div>
  );
}

registerPanel({ id: 'files', title: 'Files', icon: 'folder', order: 30, component: FilesPanel });
