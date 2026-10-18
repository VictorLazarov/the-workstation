import { useEffect } from 'react';
import { create } from 'zustand';
import { uid } from '../lib/utils';
import { ls } from '../lib/storage';
import type { ReviewComment } from '../lib/review';

interface ReviewState {
  /** pending (unsent) comments per session */
  by: Record<string, ReviewComment[]>;
  /** read this session's remembered comments from localStorage (once) */
  hydrate: (sessionId: string) => void;
  add: (sessionId: string, c: Omit<ReviewComment, 'id'>) => void;
  remove: (sessionId: string, id: string) => void;
  clear: (sessionId: string) => void;
}

/** Unsent review comments survive a reload: per session, in this browser only (a per-viewer convenience, never shared). */
export const reviewKey = (sid: string) => 'ws.review.' + sid;
const hydrated = new Set<string>();
const isComment = (c: unknown): c is ReviewComment => !!c && typeof c === 'object' && typeof (c as ReviewComment).id === 'string' && typeof (c as ReviewComment).text === 'string' && typeof (c as ReviewComment).path === 'string' && typeof (c as ReviewComment).line === 'number';
const persist = (sid: string, list: ReviewComment[]) => { if (list.length) ls.setJson(reviewKey(sid), list); else ls.del(reviewKey(sid)); };

const EMPTY: ReviewComment[] = [];
export const useReview = create<ReviewState>((set, get) => ({
  by: {},
  hydrate: (sid) => {
    if (hydrated.has(sid)) return;
    hydrated.add(sid);
    const saved = ls.getJson<unknown>(reviewKey(sid), []);
    const list = Array.isArray(saved) ? saved.filter(isComment) : [];
    if (list.length) set({ by: { ...get().by, [sid]: [...list, ...(get().by[sid] ?? [])] } });
  },
  add: (sid, c) => {
    get().hydrate(sid);
    const list = [...(get().by[sid] ?? []), { ...c, id: uid('rc') }];
    persist(sid, list);
    set({ by: { ...get().by, [sid]: list } });
  },
  remove: (sid, id) => {
    const list = (get().by[sid] ?? []).filter((x) => x.id !== id);
    persist(sid, list);
    set({ by: { ...get().by, [sid]: list } });
  },
  clear: (sid) => { hydrated.add(sid); persist(sid, []); const { [sid]: _d, ...rest } = get().by; set({ by: rest }); },
}));
export const useComments = (sid: string) => {
  useEffect(() => { useReview.getState().hydrate(sid); }, [sid]);
  return useReview((s) => s.by[sid] ?? EMPTY);
};
/** test hook: forget which sessions were read from storage */
export const _resetReviewHydration = () => hydrated.clear();
