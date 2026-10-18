import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LOG_SOURCES, type LogEntry, type LogLevel } from '@workstation/protocol';
import { Icon } from '../../components/Icon';
import { IconButton, MiddleEllipsis, Spinner } from '../../components/ui';
import { copyEntries, useLogs } from '../../store/logs';
import { useSessions } from '../../store/sessions';
import { DEFAULT_FILTERS, LEVEL_CHIPS, PAGE, absoluteTime, clock, countByLevel, filterEntries, findFocusSeq, followAfterScroll, resolveScope, shortId, timeTitle } from '../../lib/logs';
import { isDemo } from '../../lib/storage';
import { truncate } from '../../lib/utils';
import './logs.css';

const THIS = '__this';

const LogRow = memo(function LogRow({ e, open, onToggle, showSession, flash }: { e: LogEntry; open: boolean; onToggle: (seq: number) => void; showSession: boolean; flash: boolean }) {
  const detail = e.detail ? JSON.stringify(e.detail, null, 2) : '';
  return (
    <div className={`log-row lv-${e.level}${open ? ' open' : ''}${flash ? ' flash-target' : ''}`} data-seq={e.seq} data-level={e.level} data-source={e.source}>
      <button type="button" className="log-head" aria-expanded={open} aria-controls={`log-body-${e.seq}`} onClick={() => onToggle(e.seq)}>
        <span className="log-meta">
          <span className={`log-lvl lv-${e.level}`}>{e.level}</span>
          <span className="log-src">{e.source}</span>
          <time className="log-time" dateTime={new Date(e.ts).toISOString()} title={timeTitle(e.ts)}>{clock(e.ts)}</time>
          {showSession && e.sessionId && <span className="log-sess" title={`Session ${e.sessionId}`}>{shortId(e.sessionId)}</span>}
          <Icon name="chevron-right" size={12} className="log-chev" />
        </span>
        {!open && <span className="log-msg">{e.message}</span>}
      </button>
      {open && (
        <div className="log-body" id={`log-body-${e.seq}`}>
          <div className="log-msg full">{e.message}</div>
          <dl className="log-facts">
            <div><dt>Time</dt><dd>{absoluteTime(e.ts)}</dd></div>
            {e.sessionId && <div><dt>Session</dt><dd className="mono">{e.sessionId}</dd></div>}
            <div><dt>Entry</dt><dd className="mono">#{e.seq}</dd></div>
          </dl>
          {detail && <pre className="log-json" aria-label="Details">{detail}</pre>}
        </div>
      )}
    </div>
  );
});

/**
 * The diagnostics log as a workspace view: level chips, source / session filters, search, a capped list that follows the tail
 * (with a "Jump to latest" strip once you scroll away), expandable rows with their detail, and Copy / Download / Clear.
 * `sessionId` is the open session (undefined when none is: the dialog variant).
 */
export function LogsView({ sessionId }: { sessionId?: string }) {
  const entries = useLogs((s) => s.entries);
  const loaded = useLogs((s) => s.loaded);
  const loadError = useLogs((s) => s.loadError);
  const file = useLogs((s) => s.file);
  const filters = useLogs((s) => s.filters);
  const focus = useLogs((s) => s.focus);
  const { setFilters, attachView, clearFocus } = useLogs.getState();
  const isDraft = useSessions((s) => (sessionId ? !!s.sessions[sessionId]?.isDraft : false));
  const current = sessionId && !isDraft ? sessionId : undefined;
  const scopeId = resolveScope(filters.scope, current);

  useEffect(() => attachView(), [attachView]);
  useEffect(() => { void useLogs.getState().start(); }, []); // a view may open before the first handshake finished or after a failed load

  const base = useMemo(() => ({ source: filters.source, sessionId: scopeId, q: filters.q }), [filters.source, scopeId, filters.q]);
  const counts = useMemo(() => countByLevel(entries, base), [entries, base]);
  const shown = useMemo(() => filterEntries(entries, { ...base, levels: filters.levels }), [entries, base, filters.levels]);
  const [pages, setPages] = useState(1);
  useEffect(() => setPages(1), [filters.source, scopeId, filters.q, filters.levels]);
  const visible = useMemo(() => shown.slice(Math.max(0, shown.length - pages * PAGE)), [shown, pages]);
  const hidden = shown.length - visible.length;
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [flash, setFlash] = useState<number | null>(null);

  // ── follow the tail ──
  const list = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);
  const toBottom = useCallback((smooth = false) => { const el = list.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); }, []);
  const lastSeq = visible.length ? visible[visible.length - 1]!.seq : 0;
  useLayoutEffect(() => { if (following.current) toBottom(); }, [lastSeq, visible.length, toBottom, loaded]);
  const check = useCallback(() => {
    const el = list.current;
    if (!el) return;
    const r = followAfterScroll({ following: following.current, scrollTop: el.scrollTop, lastTop: lastTop.current, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    lastTop.current = el.scrollTop;
    following.current = r.following;
    setAway(r.showJump);
  }, []);
  const toggle = useCallback((seq: number) => {
    following.current = false; // reading a row: the list must not jump to the tail under you
    setOpen((s) => { const n = new Set(s); if (n.has(seq)) n.delete(seq); else n.add(seq); return n; });
    requestAnimationFrame(check);
  }, [check]);

  // ── "View details": go to the entry an error banner / toast points at ──
  useEffect(() => {
    if (!focus || !loaded) return;
    const seq = findFocusSeq(entries, { sessionId: focus.sessionId, ts: focus.ts, text: focus.text });
    clearFocus();
    if (seq === undefined) return;
    const e = entries.find((x) => x.seq === seq)!;
    if (!filters.levels.includes(e.level)) setFilters({ levels: [...filters.levels, e.level] });
    following.current = false;
    setOpen(new Set([seq]));
    setFlash(seq);
    setTimeout(() => setFlash(null), 1800);
    requestAnimationFrame(() => requestAnimationFrame(() => { list.current?.querySelector(`[data-seq="${seq}"]`)?.scrollIntoView({ block: 'center' }); check(); }));
  }, [focus, loaded, entries, filters.levels, setFilters, clearFocus, check]);

  const sessionOptions = useMemo(() => {
    const ids = [...new Set(entries.map((e) => e.sessionId).filter((x): x is string => !!x))].filter((id) => id !== current);
    const known = useSessions.getState().sessions;
    return ids.slice(-30).reverse().map((id) => ({ id, label: known[id]?.title ? truncate(known[id]!.title, 28) : `Session ${shortId(id)}` }));
  }, [entries, current]);
  const selectValue = filters.scope === 'all' ? 'all' : scopeId === undefined ? 'all' : scopeId === current ? THIS : scopeId;
  const onScope = (v: string) => setFilters({ scope: v === 'all' ? 'all' : v === THIS ? 'auto' : v });

  const toggleLevel = (l: LogLevel) => setFilters({ levels: filters.levels.includes(l) ? filters.levels.filter((x) => x !== l) : [...filters.levels, l] });
  const resetFilters = () => setFilters(DEFAULT_FILTERS);

  if (isDemo()) {
    return <div className="panel-empty"><Icon name="logs" size={22} /><b>No server log in the demo</b><span>Logs come from a running Workstation server.</span></div>;
  }

  return (
    <div className="logs" data-testid="logs-view">
      <div className="logs-top">
        <div className="logs-levels" role="group" aria-label="Show levels">
          {LEVEL_CHIPS.map(({ level, label }) => (
            <button key={level} type="button" className={`logs-chip lv-${level}`} aria-pressed={filters.levels.includes(level)} onClick={() => toggleLevel(level)} title={`${filters.levels.includes(level) ? 'Hide' : 'Show'} ${label.toLowerCase()}`}>
              {label}<span className="n">{counts[level]}</span>
            </button>
          ))}
        </div>
        <div className="logs-filters">
          <select className="field sm" aria-label="Source" value={filters.source} onChange={(e) => setFilters({ source: e.target.value as typeof filters.source })}>
            <option value="all">All sources</option>
            {LOG_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="field sm" aria-label="Session" value={selectValue} onChange={(e) => onScope(e.target.value)}>
            <option value="all">All sessions</option>
            {current && <option value={THIS}>This session</option>}
            {sessionOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        <div className="logs-search">
          <input className="field" type="search" aria-label="Search logs" placeholder="Search logs" value={filters.q} onChange={(e) => setFilters({ q: e.target.value })} spellCheck={false} />
          <IconButton icon="copy" label="Copy visible" onClick={() => void copyEntries(shown)} disabled={!shown.length} />
          <IconButton icon="download" label="Download" onClick={() => void useLogs.getState().download(scopeId)} />
          <IconButton icon="trash" label="Clear" onClick={() => void useLogs.getState().clear()} />
        </div>
      </div>

      <div className="logs-list" ref={list} onScroll={check} role="log" aria-label="Log entries" tabIndex={0}>
        {!loaded && <div className="logs-note"><Spinner size={13} /> Loading logs…</div>}
        {loaded && loadError && (
          <div className="logs-note err" role="alert"><Icon name="alert" size={14} /> <span>Could not load the log: {loadError}</span><button type="button" className="link-btn" onClick={() => void useLogs.getState().start()}>Retry</button></div>
        )}
        {loaded && !loadError && shown.length === 0 && (
          <div className="logs-note">
            <Icon name="logs" size={16} />
            <span>{entries.length === 0 ? 'Nothing has been logged yet.' : 'No entries match these filters.'}</span>
            {entries.length > 0 && <button type="button" className="link-btn" onClick={resetFilters}>Reset filters</button>}
          </div>
        )}
        {hidden > 0 && <button type="button" className="logs-more" onClick={() => setPages((p) => p + 1)}>Show {Math.min(PAGE, hidden)} earlier ({hidden} more)</button>}
        {visible.map((e) => <LogRow key={e.seq} e={e} open={open.has(e.seq)} onToggle={toggle} showSession={scopeId === undefined} flash={flash === e.seq} />)}
      </div>

      {away && (
        <div className="jump-strip">
          <button type="button" className="jump" onClick={() => { following.current = true; toBottom(true); setAway(false); }}>
            <Icon name="arrow-up" size={13} style={{ transform: 'rotate(180deg)' }} /> Jump to latest
          </button>
        </div>
      )}
      <div className="logs-foot">
        <span className="logs-count">{shown.length === entries.length ? `${shown.length} entries` : `${shown.length} of ${entries.length}`}</span>
        {file && <span className="logs-file" title={`Log file on the server: ${file}`}><Icon name="file" size={12} /> <MiddleEllipsis text={file} tail={26} /></span>}
      </div>
    </div>
  );
}
