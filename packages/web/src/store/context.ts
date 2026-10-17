import { useEffect } from 'react';
import { create } from 'zustand';
import type { ContextUsage } from '@workstation/protocol';
import { useSessions } from './sessions';

interface Entry { data?: ContextUsage; prevTotal?: number; loading: boolean; error?: string; stamp?: string }
interface Store { by: Record<string, Entry>; set: (id: string, p: Partial<Entry>) => void }

export const useContextStore = create<Store>((set, get) => ({
  by: {},
  set: (id, p) => set({ by: { ...get().by, [id]: { ...get().by[id], loading: false, ...p } } }),
}));

const inflight = new Set<string>();

/** Ask the live session's SDK query for its real context breakdown. Coalesces concurrent calls per session. */
export async function refreshContext(id: string, detail: 'summary' | 'full' = 'full', stamp?: string): Promise<void> {
  if (inflight.has(id)) return;
  inflight.add(id);
  const st = useContextStore.getState();
  st.set(id, { loading: true, ...(stamp ? { stamp } : {}) });
  try {
    const data = await useSessions.getState().contextUsage(id, detail);
    const prev = useContextStore.getState().by[id]?.data;
    useContextStore.getState().set(id, { data, prevTotal: prev && prev.totalTokens !== data.totalTokens ? prev.totalTokens : useContextStore.getState().by[id]?.prevTotal, loading: false, error: undefined });
  } catch (e) {
    useContextStore.getState().set(id, { loading: false, error: e instanceof Error ? e.message : String(e) });
  } finally { inflight.delete(id); }
}

/**
 * Real context usage for a session, refreshed when the session goes live and after every finished turn.
 * Returns the last good snapshot (kept while a refresh runs); `data` is undefined for sessions that are not live
 * (history only) or when the CLI cannot report it, and callers then fall back to the measured token total.
 */
export function useContextUsage(id: string): Entry {
  const live = useSessions((s) => !!s.sessions[id]?.live);
  const idle = useSessions((s) => s.sessions[id]?.runtime.status === 'idle');
  const turns = useSessions((s) => s.sessions[id]?.conv.usage.turns ?? 0);
  const entry = useContextStore((s) => s.by[id]) ?? { loading: false };
  useEffect(() => {
    if (!live) return;
    // idle: the turn just ended (or the session just started), take the full breakdown once per turn.
    // Mid-turn: only fill an empty card, with the cheap summary, so a first long turn is not blank.
    const stamp = idle ? `${turns}` : 'boot';
    const cur = useContextStore.getState().by[id];
    if (cur?.stamp === stamp || (!idle && cur?.data)) return;
    const t = setTimeout(() => void refreshContext(id, idle ? 'full' : 'summary', stamp), 250);
    return () => clearTimeout(t);
  }, [id, live, idle, turns]);
  return entry;
}
