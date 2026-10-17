import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { hasToolUse } from '../lib/reducer';
import { projectName, useSessions, type SessionData } from '../store/sessions';
import { formatDuration, relativeTime } from '../lib/utils';
import { Icon } from './Icon';
import { PermissionDock } from './PermissionCards';
import { RowList } from './RowList';
import { Spinner } from './ui';
import { useUi } from '../store/ui';

const SUGGESTIONS = [
  { icon: 'search' as const, text: 'Give me a tour of this codebase and how it is organized' },
  { icon: 'wrench' as const, text: 'Find and fix a bug. Start by running the test suite' },
  { icon: 'file-edit' as const, text: 'Review my uncommitted changes and suggest improvements' },
  { icon: 'list-checks' as const, text: 'Plan a refactor of the most complex module, and ask me questions first' },
];

function Elapsed({ since }: { since?: number }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return <>{since ? formatDuration(Date.now() - since) : ''}</>;
}

export function Conversation({ session }: { session: SessionData }) {
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);
  const { conv, id } = session;
  const respond = useSessions((s) => s.respondPermission);
  const running = session.runtime.status === 'running' || session.runtime.status === 'waiting_permission' || session.runtime.status === 'starting' || session.starting;
  const main = conv.lanes[''];
  const empty = !main || main.items.length === 0;

  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  useLayoutEffect(() => { stick.current = true; setAway(false); toBottom(); }, [id, toBottom]);
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (stick.current) toBottom(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom, id]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    const up = el.scrollTop < lastTop.current - 2;
    lastTop.current = el.scrollTop;
    if (near) stick.current = true; else if (up) stick.current = false;
    setAway(!stick.current && !near);
  };

  const orphanPerms = session.perms.filter((p) => !hasToolUse(conv, p.toolUseID));
  const lastRow = main?.items[main.items.length - 1];
  const streamingNow = !!main?.live;
  const showWorking = running && !streamingNow && session.perms.length === 0 && lastRow?.kind !== 'result';
  const lastIsUser = lastRow?.kind === 'user';

  return (
    <div className="conv">
      <div className="conv-scroll" ref={scroller} onScroll={onScroll}>
        <div className="conv-inner" ref={inner}>
          {session.loading && <div className="skeleton-conv" aria-busy="true"><i /><i /><i /><i /></div>}
          {!session.loading && empty && !running && <EmptySession session={session} />}
          {!session.loading && (
            <RowList conv={conv} laneKey="" sessionId={id} cwd={session.cwd} sessionRunning={running} perms={session.perms} outcomes={session.outcomes} />
          )}
          {orphanPerms.map((p) => <PermissionDock key={p.requestId} perm={p} onRespond={(d) => respond(id, p.requestId, d)} />)}
          {conv.retry && (
            <div className="banner warn" role="status">
              <Spinner size={13} />
              <div>
                <b>API {conv.retry.status ?? 'error'}, retrying</b> (attempt {conv.retry.attempt}/{conv.retry.max})
                <div className="banner-sub">Retrying in {Math.round(conv.retry.delayMs / 1000)}s. {conv.retry.message}</div>
              </div>
            </div>
          )}
          {conv.statusText === 'compacting' && <div className="banner info"><Spinner size={13} /> Compacting conversation…</div>}
          {(showWorking || lastIsUser) && running && (
            <div className="working" role="status"><Spinner size={13} /><span className="shimmer">Working</span><span className="working-time"><Elapsed since={session.turnStartedAt} /></span></div>
          )}
          <div className="conv-end" />
        </div>
      </div>
      {away && (
        <button type="button" className="jump" onClick={() => { stick.current = true; toBottom(true); setAway(false); }}>
          <Icon name="arrow-up" size={13} style={{ transform: 'rotate(180deg)' }} /> Jump to latest
        </button>
      )}
    </div>
  );
}

function EmptySession({ session }: { session: SessionData }) {
  return (
    <div className="empty-session">
      <div className="empty-mark" aria-hidden="true"><Icon name="sparkles" size={22} /></div>
      <h1 className="serif">What should we work on?</h1>
      <p className="muted">
        <Icon name="folder" size={13} /> {projectName(session.cwd)}
        {session.branch && <> <span className="sep">·</span> <Icon name="branch" size={13} /> {session.branch}</>}
      </p>
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s.text} type="button" className="suggestion" onClick={() => window.dispatchEvent(new CustomEvent('ws:insert', { detail: s.text }))}>
            <Icon name={s.icon} size={15} /><span>{s.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Home() {
  const projects = useSessions((s) => s.projects);
  const summaries = useSessions((s) => s.summaries);
  const ready = useSessions((s) => s.ready);
  const newSession = useSessions((s) => s.newSession);
  const open = useSessions((s) => s.openSession);
  const recent = [...summaries].sort((a, b) => b.lastModified - a.lastModified).slice(0, 5);
  return (
    <div className="home">
      <div className="home-inner">
        <div className="empty-mark" aria-hidden="true"><Icon name="sparkles" size={22} /></div>
        <h1 className="serif">Welcome to The Workstation</h1>
        <p className="muted">Run Claude Code agents side by side in your projects. Pick up where you left off, or start something new.</p>
        <div className="home-actions">
          <button type="button" className="btn primary lg" onClick={() => useUi.getState().set({ pickerOpen: true })}><Icon name="folder-open" size={16} /> Open a project</button>
        </div>
        {projects.length > 0 && (
          <section>
            <h3>Recent projects</h3>
            <div className="home-grid">
              {projects.slice(0, 6).map((p) => (
                <button key={p} type="button" className="home-card" onClick={() => newSession(p)}>
                  <Icon name="folder" size={16} /><div><b>{projectName(p)}</b><span>{p}</span></div>
                </button>
              ))}
            </div>
          </section>
        )}
        {recent.length > 0 && (
          <section>
            <h3>Recent sessions</h3>
            <div className="home-list">
              {recent.map((s) => (
                <button key={s.sessionId} type="button" className="home-row" onClick={() => open(s)}>
                  <Icon name="chat" size={15} /><span className="home-row-title">{s.title}</span>
                  <span className="muted">{s.cwd ? projectName(s.cwd) : ''}</span><span className="muted">{relativeTime(s.lastModified)}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        {!ready && <div className="muted center"><Spinner /> Connecting…</div>}
      </div>
    </div>
  );
}
