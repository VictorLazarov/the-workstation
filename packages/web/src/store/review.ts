import { create } from 'zustand';
import { uid } from '../lib/utils';
import type { ReviewComment } from '../lib/review';

interface ReviewState {
  /** pending (unsent) comments per session */
  by: Record<string, ReviewComment[]>;
  add: (sessionId: string, c: Omit<ReviewComment, 'id'>) => void;
  remove: (sessionId: string, id: string) => void;
  clear: (sessionId: string) => void;
}

const EMPTY: ReviewComment[] = [];
export const useReview = create<ReviewState>((set, get) => ({
  by: {},
  add: (sid, c) => set({ by: { ...get().by, [sid]: [...(get().by[sid] ?? []), { ...c, id: uid('rc') }] } }),
  remove: (sid, id) => set({ by: { ...get().by, [sid]: (get().by[sid] ?? []).filter((x) => x.id !== id) } }),
  clear: (sid) => { const { [sid]: _d, ...rest } = get().by; set({ by: rest }); },
}));
export const useComments = (sid: string) => useReview((s) => s.by[sid] ?? EMPTY);
