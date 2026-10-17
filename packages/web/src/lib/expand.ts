import { createContext, useContext, useState } from 'react';
import { create } from 'zustand';

/**
 * Expand/collapse state of thinking blocks and tool cards, kept per session item for the lifetime of the page. Without it every
 * switch to another session unmounts the conversation and all of this state resets (cards you opened snap shut).
 */
const useStore = create<{ open: Record<string, boolean>; set: (k: string, v: boolean) => void }>((set) => ({
  open: {},
  set: (k, v) => set((s) => ({ open: { ...s.open, [k]: v } })),
}));

/** Identifies the item (`<sessionId>/<item id>`) whose descendants call useExpanded. */
export const ExpandScope = createContext<string | null>(null);

/** `useState`-like open flag that survives unmounting when inside an ExpandScope. `slot` tells several flags of one item apart. */
export function useExpanded(initial: boolean, slot = ''): [boolean, (v: boolean) => void] {
  const scope = useContext(ExpandScope);
  const key = scope ? scope + '#' + slot : null;
  const stored = useStore((s) => (key ? s.open[key] : undefined));
  const [local, setLocal] = useState(initial);
  if (!key) return [local, setLocal];
  return [stored ?? initial, (v) => useStore.getState().set(key, v)];
}

/** Test helper / reset. */
export const resetExpanded = () => useStore.setState({ open: {} });
export const expandedSnapshot = () => useStore.getState().open;
