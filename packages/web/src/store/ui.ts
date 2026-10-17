import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { ls } from '../lib/storage';
import { uid } from '../lib/utils';

export type Theme = 'system' | 'light' | 'dark';
export type Brand = 'horizon' | 'warm';
export type Density = 'compact' | 'comfortable';
export interface Toast {
  id: string; kind: 'info' | 'success' | 'error' | 'attention'; title: string; body?: string;
  action?: { label: string; run: () => void }; ttl: number;
  /** groups toasts about the same thing (a session id): opening it dismisses them */
  tag?: string;
}
export interface ConfirmOpts {
  title: string; body?: string; confirmLabel?: string; danger?: boolean; details?: string[];
  /** shown as a plain line under the details list (e.g. "+3 −1 lines") */
  summary?: string;
  /** extra emphasised line, e.g. what is NOT covered */
  note?: string;
}
export interface PromptOpts { title: string; label?: string; initial?: string; confirmLabel?: string }

interface UiState {
  theme: Theme;
  brand: Brand;
  density: Density;
  sidebarOpen: boolean; sidebarWidth: number;
  inspectorOpen: boolean; inspectorWidth: number; inspectorTab: string; inspectorFocus?: string;
  paletteOpen: boolean; settingsOpen: boolean; pickerOpen: boolean; shortcutsOpen: boolean;
  sidebarQuery: string;
  toasts: Toast[];
  confirm: (ConfirmOpts & { resolve: (ok: boolean) => void }) | null;
  prompt: (PromptOpts & { resolve: (v: string | null) => void }) | null;
  firstRunChecked: boolean;
  set: (p: Partial<UiState>) => void;
  setTheme: (t: Theme) => void;
  setBrand: (b: Brand) => void;
  setDensity: (d: Density) => void;
  toast: (t: Omit<Toast, 'id' | 'ttl'> & { ttl?: number }) => string;
  dismissToast: (id: string) => void;
  dismissToastsByTag: (tag: string) => void;
  ask: (o: ConfirmOpts) => Promise<boolean>;
  askText: (o: PromptOpts) => Promise<string | null>;
  openInspector: (tab: string, focus?: string) => void;
}

export function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === 'system') delete el.dataset.theme; else el.dataset.theme = t;
}

/** 'horizon' is the default look (no attribute); 'warm' is the original Claude-warm palette. */
export function applyBrand(b: Brand) {
  const el = document.documentElement;
  if (b === 'warm') el.dataset.brand = 'warm'; else delete el.dataset.brand;
}

/** 'compact' is the default (no attribute); 'comfortable' loosens every --sp-*, --fs-* and row height token. */
export function applyDensity(d: Density) {
  const el = document.documentElement;
  if (d === 'comfortable') el.dataset.density = 'comfortable'; else delete el.dataset.density;
}

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

/**
 * Responsive breakpoints. Up to 1100px the inspector is an overlay drawer instead of a docked pane, and up to 800px the
 * sidebar is too. The open flags then describe the drawer, start closed, and are not persisted, so the saved docked
 * layout comes back on a wider window.
 */
export const BP_INSPECTOR_DRAWER = 1100;
export const BP_SIDEBAR_DRAWER = 800;
const mq = (px: number) => `(max-width: ${px}px)`;
const narrow = (px: number) => typeof matchMedia !== 'undefined' && matchMedia(mq(px)).matches;
export const sidebarIsDrawer = () => narrow(BP_SIDEBAR_DRAWER);
export const inspectorIsDrawer = () => narrow(BP_INSPECTOR_DRAWER);

/** Live `matchMedia` for components (e.g. which icon the sidebar toggle shows). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => { const m = matchMedia(query); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); },
    () => matchMedia(query).matches,
    () => false,
  );
}
export const useSidebarDrawer = () => useMedia(mq(BP_SIDEBAR_DRAWER));
export const useInspectorDrawer = () => useMedia(mq(BP_INSPECTOR_DRAWER));

export const useUi = create<UiState>((set, get) => ({
  theme: (ls.get('ws.theme') as Theme) || 'system',
  brand: ls.get('ws.brand') === 'warm' ? 'warm' : 'horizon',
  density: ls.get('ws.density') === 'comfortable' ? 'comfortable' : 'compact',
  sidebarOpen: ls.get('ws.sidebarOpen') !== '0' && !sidebarIsDrawer(),
  sidebarWidth: clamp(Number(ls.get('ws.sidebarW')) || 264, 220, 480),
  inspectorOpen: ls.get('ws.inspectorOpen') !== '0' && !inspectorIsDrawer(),
  inspectorWidth: clamp(Number(ls.get('ws.inspectorW')) || 340, 280, 720),
  inspectorTab: ls.get('ws.inspectorTab') || 'overview',
  paletteOpen: false, settingsOpen: false, pickerOpen: false, shortcutsOpen: false,
  sidebarQuery: '', toasts: [], confirm: null, prompt: null, firstRunChecked: false,
  set: (p) => {
    set(p);
    if ('sidebarOpen' in p && !sidebarIsDrawer()) ls.set('ws.sidebarOpen', p.sidebarOpen ? '1' : '0');
    if ('inspectorOpen' in p && !inspectorIsDrawer()) ls.set('ws.inspectorOpen', p.inspectorOpen ? '1' : '0');
    if ('sidebarWidth' in p) ls.set('ws.sidebarW', String(p.sidebarWidth));
    if ('inspectorWidth' in p) ls.set('ws.inspectorW', String(p.inspectorWidth));
    if ('inspectorTab' in p && p.inspectorTab) ls.set('ws.inspectorTab', p.inspectorTab);
  },
  setTheme: (t) => { ls.set('ws.theme', t); applyTheme(t); set({ theme: t }); },
  setBrand: (b) => { ls.set('ws.brand', b); applyBrand(b); set({ brand: b }); },
  setDensity: (d) => { ls.set('ws.density', d); applyDensity(d); set({ density: d }); },
  toast: (t) => {
    const id = uid('t');
    const ttl = t.ttl ?? (t.kind === 'error' ? 8000 : 4500);
    set({ toasts: [...get().toasts.slice(-4), { ...t, id, ttl }] });
    if (ttl > 0) setTimeout(() => get().dismissToast(id), ttl);
    return id;
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
  dismissToastsByTag: (tag) => set({ toasts: get().toasts.filter((x) => x.tag !== tag) }),
  ask: (o) => new Promise<boolean>((resolve) => set({ confirm: { ...o, resolve: (ok) => { set({ confirm: null }); resolve(ok); } } })),
  askText: (o) => new Promise<string | null>((resolve) => set({ prompt: { ...o, resolve: (v) => { set({ prompt: null }); resolve(v); } } })),
  openInspector: (tab, focus) => get().set({ inspectorOpen: true, inspectorTab: tab, inspectorFocus: focus }),
}));

// Crossing a breakpoint: a drawer always starts closed; going back to a docked layout restores the saved preference.
if (typeof matchMedia !== 'undefined') {
  matchMedia(mq(BP_SIDEBAR_DRAWER)).addEventListener('change', (e) => useUi.setState({ sidebarOpen: e.matches ? false : ls.get('ws.sidebarOpen') !== '0' }));
  matchMedia(mq(BP_INSPECTOR_DRAWER)).addEventListener('change', (e) => useUi.setState({ inspectorOpen: e.matches ? false : ls.get('ws.inspectorOpen') !== '0' }));
}
