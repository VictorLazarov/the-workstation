import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EffortLevel, ImageAttachment, PermissionMode } from '@workstation/protocol';
import { api } from '../lib/api';
import { debounce, fileToBase64, formatTokens, fuzzy } from '../lib/utils';
import { ls } from '../lib/storage';
import { useSessions, type SessionData } from '../store/sessions';
import { Icon } from './Icon';
import { IconButton } from './ui';
import { useContextSummary } from '../panels/OverviewPanel';
import { useUi } from '../store/ui';
import { EffortChip, MODES, ModeChip, ModelChip } from './Chips';
import { basename, dirname } from '../lib/utils';

interface Popup { kind: 'mention' | 'slash'; query: string; start: number; end: number }
interface Option { id: string; label: string; detail?: string; insert: string }

const draftKey = (id: string) => 'ws.draft.' + id;

export function Composer({ session }: { session: SessionData }) {
  const id = session.id;
  const { send, interrupt, setMode, cancelQueued, retryQueued } = useSessions.getState();
    const config = useSessions((s) => s.config);
  const commands = useSessions((s) => s.commands);
  const [text, setText] = useState(() => ls.get(draftKey(id)) ?? '');
  const [images, setImages] = useState<(ImageAttachment & { url: string })[]>([]);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [sel, setSel] = useState(0);
  const [drag, setDrag] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = session.runtime.status === 'running' || session.runtime.status === 'waiting_permission';

  // draft persistence per session
  useEffect(() => { setText(ls.get(draftKey(id)) ?? ''); setImages([]); setPopup(null); }, [id]);
  const saveDraft = useMemo(() => debounce((k: string, v: string) => (v ? ls.set(k, v) : ls.del(k)), 300), []);
  useEffect(() => { saveDraft(draftKey(id), text); }, [text, id, saveDraft]);

  // autosize
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px';
  }, [text]);

  // focus on session switch + external inserts
  useEffect(() => { ta.current?.focus(); }, [id]);
  useEffect(() => {
    const ins = (e: Event) => { setText((e as CustomEvent<string>).detail); ta.current?.focus(); };
    const foc = () => ta.current?.focus();
    // ws:mention (detail: path) appends "@path " to the draft, e.g. from the Files panel
    const men = (e: Event) => {
      const p = (e as CustomEvent<string>).detail;
      setText((t) => `${t}${t && !/\s$/.test(t) ? ' ' : ''}@${p} `);
      ta.current?.focus();
    };
    window.addEventListener('ws:mention', men);
    window.addEventListener('ws:insert', ins);
    window.addEventListener('ws:focus-composer', foc);
    return () => { window.removeEventListener('ws:mention', men); window.removeEventListener('ws:insert', ins); window.removeEventListener('ws:focus-composer', foc); };
  }, []);

  /* ───── popups ───── */
  const slashOptions = useMemo<Option[]>(() => {
    const map = new Map<string, Option>();
    for (const c of commands) map.set(c.name, { id: c.name, label: '/' + c.name, detail: c.description + (c.argumentHint ? `  ${c.argumentHint}` : ''), insert: `/${c.name} ` });
    for (const n of session.conv.init?.slashCommands ?? []) if (!map.has(n)) map.set(n, { id: n, label: '/' + n, insert: `/${n} ` });
    return [...map.values()];
  }, [commands, session.conv.init]);

  const detect = useCallback((value: string, caret: number) => {
    const before = value.slice(0, caret);
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (at) return { kind: 'mention' as const, query: at[2], start: caret - at[2].length - 1, end: caret };
    const sl = /^\/([\w:.-]*)$/.exec(before);
    if (sl) return { kind: 'slash' as const, query: sl[1], start: 0, end: caret };
    return null;
  }, []);

  const searchFiles = useMemo(() => debounce(async (cwd: string, q: string, token: number) => {
    try {
      const r = await api.searchFiles(cwd, q);
      if (token !== searchToken.current) return;
      setOptions((Array.isArray(r) ? r : []).slice(0, 8).map((p) => ({ id: p, label: basename(p), detail: dirname(p), insert: `@${p} ` })));
      setSel(0);
    } catch { if (token === searchToken.current) setOptions([]); }
  }, 120), []);
  const searchToken = useRef(0);

  useEffect(() => {
    if (!popup) { setOptions([]); return; }
    if (popup.kind === 'slash') {
      const scored = slashOptions.map((o) => ({ o, s: fuzzy(popup.query, o.id) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 8);
      setOptions(scored.map((x) => x.o));
      setSel(0);
    } else {
      searchFiles(session.cwd, popup.query, ++searchToken.current);
    }
  }, [popup?.kind, popup?.query, slashOptions, session.cwd, searchFiles]);

  const accept = (o: Option) => {
    if (!popup) return;
    const next = text.slice(0, popup.start) + o.insert + text.slice(popup.end);
    setText(next);
    setPopup(null);
    requestAnimationFrame(() => { const p = popup.start + o.insert.length; ta.current?.setSelectionRange(p, p); ta.current?.focus(); });
  };

  /* ───── images ───── */
  const addFiles = async (files: FileList | File[]) => {
    // 5 MB per image is the API limit; the server's WebSocket frame cap is 16 MB (base64 grows 4/3).
    const all = [...files].filter((f) => f.type.startsWith('image/'));
    const list = all.filter((f) => f.size <= 5 * 1024 * 1024);
    if (list.length < all.length) useUi.getState().toast({ kind: 'error', title: 'Image too large', body: 'Images can be up to 5 MB each.' });
    const added = await Promise.all(list.map(async (f) => ({ mediaType: f.type, dataBase64: await fileToBase64(f), name: f.name, url: URL.createObjectURL(f) })));
    setImages((x) => [...x, ...added].slice(0, 8));
  };

  const submit = () => {
    const t = text.trim();
    if (!t && !images.length) return;
    if (images.reduce((n, im) => n + im.dataBase64.length, 0) > 14 * 1024 * 1024) {
      useUi.getState().toast({ kind: 'error', title: 'Attachments too large', body: 'Send at most about 10 MB of images per message.' });
      return;
    }
    send(id, t, images.map(({ url: _u, ...rest }) => rest));
    setText(''); ls.del(draftKey(id)); setImages([]); setPopup(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (popup && options.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % options.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + options.length) % options.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); accept(options[sel]); return; }
    }
    if (popup && e.key === 'Escape') { e.preventDefault(); setPopup(null); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !composing.current) { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape' && running && !text) { e.preventDefault(); interrupt(id); return; }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      const order = MODES.map((m) => m.id);
      setMode(id, order[(order.indexOf(session.runtime.permissionMode) + 1) % order.length]);
    }
  };

  const { used: ctxTokens, max: ctxWin, pct: rawPct, tone: ctxTone } = useContextSummary(id);
  const ctxPct = ctxTokens ? Math.min(100, Math.max(1, Math.round(rawPct))) : 0;
  const canSend = (text.trim().length > 0 || images.length > 0);

  return (
    <div className="composer-wrap">
      {session.queue.length > 0 && (
        <div className="queue" aria-label="Queued messages">
          {session.queue.map((q) => (
            <div key={q.id} className={`queue-item${q.failed ? ' failed' : ''}`}>
              <Icon name={q.failed ? 'alert' : 'clock'} size={13} />
              <span className="queue-text">{q.text || `${q.images.length} image(s)`}</span>
              {q.failed
                ? <><span className="queue-tag queue-failed">Not sent</span><button type="button" className="link-btn" onClick={() => retryQueued(id)}>Retry</button></>
                : <span className="muted queue-tag">{session.starting ? 'starts with session' : 'queued'}</span>}
              <IconButton icon="x" label="Remove from queue" size={13} onClick={() => cancelQueued(id, q.id)} />
            </div>
          ))}
        </div>
      )}
      <div
        className={`composer${drag ? ' drag' : ''}${running ? ' running' : ''}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files); }}
      >
        {popup && options.length > 0 && (
          <div className="suggest" role="listbox" aria-label={popup.kind === 'slash' ? 'Commands' : 'Files'}>
            <div className="suggest-head">{popup.kind === 'slash' ? 'Commands & skills' : 'Files'}</div>
            {options.map((o, i) => (
              <button key={o.id} type="button" role="option" aria-selected={i === sel} className={`suggest-item${i === sel ? ' sel' : ''}`} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); accept(o); }}>
                <Icon name={popup.kind === 'slash' ? 'command' : 'file'} size={14} />
                <span className="suggest-label">{o.label}</span>
                {o.detail && <span className="suggest-detail">{o.detail}</span>}
              </button>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="attachments">
            {images.map((im, i) => (
              <div key={i} className="attach">
                <img src={im.url} alt={im.name ?? 'attachment'} />
                <button type="button" aria-label="Remove image" onClick={() => setImages((x) => x.filter((_, k) => k !== i))}><Icon name="x" size={11} /></button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-row">
          <IconButton icon="plus" label="Attach image" className="composer-plus" onClick={() => fileInput.current?.click()} />
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
          <textarea
            ref={ta} rows={1} value={text} spellCheck
            aria-label="Message Claude"
            placeholder={session.perms.length ? 'Waiting for your decision above. Type to queue a follow-up…' : running ? 'Claude is working. Type to queue a follow-up…' : session.isDraft ? 'Describe a task, ask a question, or type / for commands' : 'Reply to Claude, or type / for commands, @ for files'}
            onChange={(e) => { setText(e.target.value); setPopup(detect(e.target.value, e.target.selectionStart)); }}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) setPopup(detect(text, e.currentTarget.selectionStart)); }}
            onClick={(e) => setPopup(detect(text, e.currentTarget.selectionStart))}
            onBlur={() => setTimeout(() => setPopup(null), 120)}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onPaste={(e) => { const f = [...e.clipboardData.files].filter((x) => x.type.startsWith('image/')); if (f.length) { e.preventDefault(); void addFiles(f); } }}
          />
          {running && <button type="button" className="send stop" onClick={() => interrupt(id)} aria-label="Stop" title="Stop (Esc)"><Icon name="stop" size={12} fill /></button>}
          <button type="button" className="send" disabled={!canSend} onClick={submit} aria-label={running ? 'Queue message' : 'Send message'} title={running ? 'Queue (Enter)' : 'Send (Enter)'}>
            <Icon name="arrow-up" size={15} />
          </button>
        </div>
      </div>
      <div className="composer-meta">
        <div className="composer-chips">
          <ModeChip session={session} />
          <ModelChip session={session} />
          <EffortChip session={session} />
        </div>
        {ctxTokens ? (
          <button type="button" className={`ctx ${ctxTone}`} title={`Context: ${formatTokens(ctxTokens)} of ${formatTokens(ctxWin)} tokens (${ctxPct}%). Click for the breakdown`} aria-label={`Context ${ctxPct}% used`} onClick={() => useUi.getState().openInspector('overview')}>
            <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="8" fill="none" stroke="var(--border-strong)" strokeWidth="2.5" />
              <circle cx="10" cy="10" r="8" fill="none" stroke={ctxPct > 85 ? 'var(--danger)' : 'var(--accent-solid)'} strokeWidth="2.5" strokeDasharray={`${(ctxPct / 100) * 50.3} 50.3`} strokeLinecap="round" transform="rotate(-90 10 10)" />
            </svg>
            <span>{ctxPct}%</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
