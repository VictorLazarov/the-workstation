/**
 * Inspector panel registry. Other engineers add tabs by calling `registerPanel` from a module
 * imported in `src/panels/index.ts`. A panel receives the active session id + cwd and can read
 * everything else via the exported stores/selectors (see `src/panels/README` notes in index.ts).
 */
import type { ComponentType } from 'react';
import { create } from 'zustand';
import type { IconName } from '../components/Icon';

export interface PanelProps {
  sessionId: string;
  cwd: string;
  /** Optional hint set by e.g. "open in Changes" clicks (file path to focus). */
  focus?: string;
}
export interface PanelDef {
  id: string;
  title: string;
  icon: IconName;
  /** lower sorts first; built-ins use 10,20,... */
  order?: number;
  component: ComponentType<PanelProps>;
  /** Optional hook returning a small badge (count/label) for the tab. Must follow the rules of hooks. */
  useBadge?: (sessionId: string) => string | number | undefined;
}

interface Reg { panels: PanelDef[]; register: (p: PanelDef) => void }
export const usePanelRegistry = create<Reg>((set, get) => ({
  panels: [],
  register: (p) => set({ panels: [...get().panels.filter((x) => x.id !== p.id), p].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)) }),
}));

export const registerPanel = (p: PanelDef) => usePanelRegistry.getState().register(p);
export const hasPanel = (id: string) => usePanelRegistry.getState().panels.some((p) => p.id === id);
export const usePanels = () => usePanelRegistry((s) => s.panels);
export const useHasPanel = (id: string) => usePanelRegistry((s) => s.panels.some((p) => p.id === id));
