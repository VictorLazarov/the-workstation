import { create } from 'zustand';
import type { LogEntry, LogLevel } from '@workstation/protocol';
import { CLIENT_CAP, DEFAULT_FILTERS, entriesText, mergeEntries, serverQuery, type LogFilters } from '../lib/logs';
import { logsApi, saveTextFile } from '../lib/logs-api';
import { isDemo } from '../lib/storage';
import { platform } from '../platform';
import { sendClient, useSessions } from './sessions';
import { useUi } from './ui';

/** Where an error banner / toast wants the Logs to look: a session (or none) and roughly when. */
export interface LogsTarget { sessionId?: string; ts?: number; /** the text the banner showed, to find the entry that says exactly that */ text?: string; levels?: LogLevel[]; q?: string }

interface LogsState {
  entries: LogEntry[];
  lastSeq: number;
  loaded: boolean;
  loadError?: string;
  /** the rotating file on the server's disk */
  file?: string;
  filters: LogFilters;
  /** errors that arrived while no Logs view was open: the red badge on the tab */
  unseen: number;
  /** number of Logs views on screen right now (panel / dialog) */
  viewing: number;
  /** the Logs dialog (used when no session is open, so there is no inspector) */
  dialogOpen: boolean;
  /** one-shot request from "View details": the view scrolls to the entry nearest to `ts` */
  focus?: { sessionId?: string; ts?: number; text?: string; nonce: number };
  /** load the backlog (or what was missed) and subscribe to the live stream; safe to call on every (re)connect */
  start: () => Promise<void>;
  ingest: (entries: LogEntry[]) => void;
  setFilters: (p: Partial<LogFilters>) => void;
  attachView: () => () => void;
  clearFocus: () => void;
  clear: () => Promise<void>;
  download: (sessionId?: string) => Promise<void>;
  openLogs: (target?: LogsTarget) => void;
}

let starting: Promise<void> | null = null;

export const useLogs = create<LogsState>((set, get) => ({
  entries: [], lastSeq: 0, loaded: false, filters: DEFAULT_FILTERS, unseen: 0, viewing: 0, dialogOpen: false,

  async start() {
    if (isDemo()) { set({ loaded: true }); return; }
    sendClient({ type: 'logs.subscribe' }); // subscribe first: whatever happens during the fetch below arrives over the socket and is merged by seq
    if (starting) return starting;
    const since = get().lastSeq;
    starting = (async () => {
      try {
        const r = await logsApi.list({ ...serverQuery({ since: since || undefined, limit: CLIENT_CAP }) });
        // the server restarted (its counter is lower than ours): the old entries belong to the previous run
        const restarted = r.lastSeq < since;
        const base = restarted ? [] : get().entries;
        const firstLoad = !get().loaded || restarted;
        const merged = mergeEntries(base, r.entries);
        // errors that were already there when this page opened are history, not news: only later ones badge the tab
        set({ entries: merged, lastSeq: Math.max(r.lastSeq, merged.at(-1)?.seq ?? 0), loaded: true, loadError: undefined, file: r.file, ...(firstLoad ? { unseen: 0 } : {}) });
      } catch (e) {
        set({ loadError: (e as Error).message, loaded: true });
      } finally { starting = null; }
    })();
    return starting;
  },

  ingest(incoming) {
    if (!incoming.length) return;
    const s = get();
    const fresh = incoming.filter((e) => e.seq > (s.entries.at(-1)?.seq ?? 0));
    const entries = mergeEntries(s.entries, incoming);
    const newErrors = s.viewing > 0 ? 0 : fresh.filter((e) => e.level === 'error').length;
    set({ entries, lastSeq: Math.max(s.lastSeq, incoming[incoming.length - 1]!.seq), unseen: s.unseen + newErrors });
  },

  setFilters(p) { set({ filters: { ...get().filters, ...p } }); },

  attachView() {
    set({ viewing: get().viewing + 1, unseen: 0 });
    let done = false;
    return () => { if (!done) { done = true; set({ viewing: Math.max(0, get().viewing - 1) }); } };
  },

  clearFocus() { set({ focus: undefined }); },

  async clear() {
    const ok = await useUi.getState().ask({
      title: 'Clear the log view?',
      body: 'This empties the log kept in the server\'s memory for every tab. The log file on disk keeps its history.',
      confirmLabel: 'Clear',
    });
    if (!ok) return;
    try {
      await logsApi.clear();
      set({ entries: [], unseen: 0 });
      void get().start(); // picks up the line the server writes about the clear
    } catch (e) { useUi.getState().toast({ kind: 'error', title: 'Could not clear the log', body: (e as Error).message }); }
  },

  async download(sessionId) {
    const f = get().filters;
    try {
      const { text, filename } = await logsApi.download(serverQuery({ levels: f.levels, source: f.source, sessionId, q: f.q }));
      saveTextFile(filename, text);
    } catch (e) { useUi.getState().toast({ kind: 'error', title: 'Could not download the log', body: (e as Error).message }); }
  },

  openLogs(target = {}) {
    const U = useUi.getState();
    const f = get().filters;
    const sid = target.sessionId && !useSessions.getState().sessions[target.sessionId]?.isDraft ? target.sessionId : undefined;
    const aimed = sid !== undefined || target.ts !== undefined || target.levels !== undefined || target.q !== undefined;
    if (aimed) {
      // a banner or toast points at something specific: show exactly that (its session, errors and warnings on, no stale search)
      const levels = target.levels ?? [...new Set<LogLevel>([...f.levels, 'error', 'warn'])];
      set({ filters: { levels, source: 'all', q: target.q ?? '', scope: sid ?? 'all' }, focus: target.ts !== undefined || sid ? { sessionId: sid, ts: target.ts, text: target.text, nonce: Date.now() } : undefined });
    }
    if (U.settingsOpen) U.set({ settingsOpen: false });
    if (U.paletteOpen) U.set({ paletteOpen: false });
    if (useSessions.getState().activeId) U.openInspector('logs');
    else set({ dialogOpen: true });
  },
}));

/** Unseen-error count for the tab badge. */
export const useUnseenErrors = () => useLogs((s) => s.unseen);

/** Copies a plain-text rendition of the entries (what the Logs panel shows) */
export async function copyEntries(entries: LogEntry[]): Promise<void> {
  await platform.copyText(entriesText(entries));
  useUi.getState().toast({ kind: 'success', title: `Copied ${entries.length} log line${entries.length === 1 ? '' : 's'}` });
}

/** "Copy debug info": versions, platform, SDK, base URL host, model, mode and the last 50 redacted log lines of the session. */
export async function copyDebugInfo(sessionId: string): Promise<void> {
  const { toast } = useUi.getState();
  const s = useSessions.getState().sessions[sessionId];
  if (isDemo()) { toast({ kind: 'info', title: 'Not available in the demo', body: 'Debug info comes from a real server.' }); return; }
  try {
    const text = await logsApi.debugInfo({ sessionId: s?.isDraft ? undefined : sessionId, model: s?.runtime.model, permissionMode: s?.runtime.permissionMode });
    await platform.copyText(`${text}Browser:         ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}\n`);
    toast({ kind: 'success', title: 'Debug info copied', body: 'Safe to paste into a bug report: keys and tokens are removed.' });
  } catch (e) { toast({ kind: 'error', title: 'Could not collect debug info', body: (e as Error).message }); }
}

/** (Re)subscribe whenever the socket (re)opens: sessions.ts dispatches this after every handshake. */
if (typeof window !== 'undefined') window.addEventListener('ws:reconnected', () => { void useLogs.getState().start(); });

