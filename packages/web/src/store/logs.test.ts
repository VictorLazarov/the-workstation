import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '@workstation/protocol';

vi.mock('../lib/storage', async (orig) => ({ ...(await orig<typeof import('../lib/storage')>()), isDemo: () => false }));
// the store talks to the server through sessions.ts (socket) and logs-api.ts (REST): stub both
vi.mock('./sessions', () => ({ sendClient: vi.fn(() => true), useSessions: { getState: () => ({ activeId: 'S1', sessions: { S1: { id: 'S1' }, D1: { id: 'D1', isDraft: true } } }) } }));
vi.mock('../lib/logs-api', () => ({ logsApi: { list: vi.fn(), clear: vi.fn(), download: vi.fn(), debugInfo: vi.fn() }, saveTextFile: vi.fn() }));

const { useLogs } = await import('./logs');
const { useUi } = await import('./ui');
const { logsApi } = await import('../lib/logs-api');
const { sendClient } = await import('./sessions');

let n = 0;
const e = (o: Partial<LogEntry> = {}): LogEntry => ({ seq: ++n, ts: 1000 + n, level: 'info', source: 'server', message: `m${n}`, ...o });
const reset = () => useLogs.setState({ entries: [], lastSeq: 0, loaded: false, unseen: 0, viewing: 0, dialogOpen: false, focus: undefined, loadError: undefined, filters: { levels: ['error', 'warn', 'info'], source: 'all', scope: 'auto', q: '' } });
beforeEach(() => { reset(); vi.clearAllMocks(); useUi.setState({ inspectorOpen: false, inspectorTab: 'overview', settingsOpen: false, paletteOpen: false }); });

describe('tab badge', () => {
  it('counts errors that arrive while no Logs view is on screen', () => {
    useLogs.getState().ingest([e({ level: 'error' }), e({ level: 'warn' }), e({ level: 'error' })]);
    expect(useLogs.getState().unseen).toBe(2);
    useLogs.getState().ingest([e({ level: 'error' })]);
    expect(useLogs.getState().unseen).toBe(3);
  });
  it('opening Logs clears it, and errors that arrive while it is open do not badge', () => {
    useLogs.getState().ingest([e({ level: 'error' })]);
    const detach = useLogs.getState().attachView();
    expect(useLogs.getState().unseen).toBe(0);
    useLogs.getState().ingest([e({ level: 'error' })]);
    expect(useLogs.getState().unseen).toBe(0);
    detach();
    useLogs.getState().ingest([e({ level: 'error' })]);
    expect(useLogs.getState().unseen).toBe(1);
  });
  it('a view that closes twice does not drive the count negative', () => {
    const d = useLogs.getState().attachView();
    d(); d();
    expect(useLogs.getState().viewing).toBe(0);
  });
  it('duplicate entries (streamed and fetched) do not count twice', () => {
    const x = e({ level: 'error' });
    useLogs.getState().ingest([x]);
    useLogs.getState().ingest([x]);
    expect(useLogs.getState().unseen).toBe(1);
    expect(useLogs.getState().entries).toHaveLength(1);
  });
});

describe('start: backlog and live stream', () => {
  it('subscribes on the socket and loads the backlog; old errors are history, not a badge', async () => {
    vi.mocked(logsApi.list).mockResolvedValue({ entries: [e({ level: 'error' }), e()], lastSeq: n, total: 2, buffered: 2, capacity: 5000, file: '/x/logs/server.log' });
    await useLogs.getState().start();
    expect(sendClient).toHaveBeenCalledWith({ type: 'logs.subscribe' });
    const s = useLogs.getState();
    expect(s.entries).toHaveLength(2);
    expect(s.loaded).toBe(true);
    expect(s.unseen).toBe(0);
    expect(s.file).toBe('/x/logs/server.log');
  });
  it('after a reconnect only what was missed is fetched (since=lastSeq) and merged', async () => {
    const first = [e(), e()];
    vi.mocked(logsApi.list).mockResolvedValueOnce({ entries: first, lastSeq: first[1]!.seq, total: 2, buffered: 2, capacity: 5000 });
    await useLogs.getState().start();
    const missed = [e({ level: 'error' })];
    vi.mocked(logsApi.list).mockResolvedValueOnce({ entries: missed, lastSeq: missed[0]!.seq, total: 1, buffered: 3, capacity: 5000 });
    await useLogs.getState().start();
    expect(vi.mocked(logsApi.list).mock.calls[1]![0]).toMatchObject({ since: String(first[1]!.seq) });
    expect(useLogs.getState().entries).toHaveLength(3);
    expect(useLogs.getState().unseen).toBe(0); // fetched, not streamed
  });
  it('a restarted server (lower counter) replaces the old run', async () => {
    useLogs.setState({ entries: [e(), e(), e()], lastSeq: 900, loaded: true });
    vi.mocked(logsApi.list).mockResolvedValue({ entries: [{ seq: 1, ts: 5, level: 'info', source: 'server', message: 'fresh' }], lastSeq: 1, total: 1, buffered: 1, capacity: 5000 });
    await useLogs.getState().start();
    expect(useLogs.getState().entries.map((x) => x.message)).toEqual(['fresh']);
  });
  it('a failed load is shown, not thrown', async () => {
    vi.mocked(logsApi.list).mockRejectedValue(new Error('unauthorized'));
    await useLogs.getState().start();
    expect(useLogs.getState()).toMatchObject({ loaded: true, loadError: 'unauthorized' });
  });
});

describe('openLogs ("View details" / palette / Settings)', () => {
  it('with a session and time: filters to that session, makes sure errors and warnings are on, asks the view to focus', () => {
    useLogs.setState({ filters: { levels: ['info'], source: 'git', scope: 'all', q: 'old search' } });
    useLogs.getState().openLogs({ sessionId: 'S1', ts: 1234 });
    const s = useLogs.getState();
    expect(s.filters).toMatchObject({ scope: 'S1', source: 'all', q: '' });
    expect(s.filters.levels).toEqual(expect.arrayContaining(['info', 'error', 'warn']));
    expect(s.focus).toMatchObject({ sessionId: 'S1', ts: 1234 });
    expect(useUi.getState()).toMatchObject({ inspectorOpen: true, inspectorTab: 'logs' });
  });
  it('a draft session has no log of its own: all sessions', () => {
    useLogs.getState().openLogs({ sessionId: 'D1', ts: 1 });
    expect(useLogs.getState().filters.scope).toBe('all');
  });
  it('plain open keeps the filters the person set and does not jump anywhere', () => {
    useLogs.setState({ filters: { levels: ['error'], source: 'sdk', scope: 'all', q: 'x' } });
    useLogs.getState().openLogs();
    expect(useLogs.getState().filters).toEqual({ levels: ['error'], source: 'sdk', scope: 'all', q: 'x' });
    expect(useLogs.getState().focus).toBeUndefined();
  });
  it('closes Settings and the palette it was opened from', () => {
    useUi.setState({ settingsOpen: true, paletteOpen: true });
    useLogs.getState().openLogs();
    expect(useUi.getState()).toMatchObject({ settingsOpen: false, paletteOpen: false });
  });
});

describe('clear', () => {
  it('asks first; cancelling keeps everything', async () => {
    useLogs.setState({ entries: [e()] });
    const p = useLogs.getState().clear();
    useUi.getState().confirm!.resolve(false);
    await p;
    expect(logsApi.clear).not.toHaveBeenCalled();
    expect(useLogs.getState().entries).toHaveLength(1);
  });
  it('confirming empties the list on the server and here', async () => {
    useLogs.setState({ entries: [e()], unseen: 2, lastSeq: n });
    vi.mocked(logsApi.clear).mockResolvedValue({ cleared: 1 });
    vi.mocked(logsApi.list).mockResolvedValue({ entries: [], lastSeq: n, total: 0, buffered: 0, capacity: 5000 });
    const p = useLogs.getState().clear();
    useUi.getState().confirm!.resolve(true);
    await p;
    expect(logsApi.clear).toHaveBeenCalled();
    expect(useLogs.getState().entries).toEqual([]);
    expect(useLogs.getState().unseen).toBe(0);
  });
});
