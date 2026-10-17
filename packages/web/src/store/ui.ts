import { create } from 'zustand';
import { ls } from '../lib/storage';
import { uid } from '../lib/utils';

export type Theme = 'system' | 'light' | 'dark';
export type Brand = 'horizon' | 'warm';
export interface Toast {
  id: string; kind: 'info' | 'success' | 'error' | 'attention'; title: string; body?: string;
  action?: { label: string; run: () => void }; ttl: number;
}
export interface ConfirmOpts {
  title: string; body?: string; confirmLabel?: string; danger?: boolean; details?: string[];
}
export interface PromptOpts { title: string; label?: string; initial?: string; confirmLabel?: string }

interface UiState {
  theme: Theme;
  brand: Brand;
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
  toast: (t: Omit<Toast, 'id' | 'ttl'> & { ttl?: number }) => string;
  dismissToast: (id: string) => void;
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

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

export const useUi = create<UiState>((set, get) => ({
  theme: (ls.get('ws.theme') as Theme) || 'system',
  brand: ls.get('ws.brand') === 'warm' ? 'warm' : 'horizon',
  sidebarOpen: ls.get('ws.sidebarOpen') !== '0',
  sidebarWidth: clamp(Number(ls.get('ws.sidebarW')) || 288, 220, 480),
  inspectorOpen: ls.get('ws.inspectorOpen') === '1',
  inspectorWidth: clamp(Number(ls.get('ws.inspectorW')) || 380, 280, 720),
  inspectorTab: ls.get('ws.inspectorTab') || 'plan',
  paletteOpen: false, settingsOpen: false, pickerOpen: false, shortcutsOpen: false,
  sidebarQuery: '', toasts: [], confirm: null, prompt: null, firstRunChecked: false,
  set: (p) => {
    set(p);
    if ('sidebarOpen' in p) ls.set('ws.sidebarOpen', p.sidebarOpen ? '1' : '0');
    if ('inspectorOpen' in p) ls.set('ws.inspectorOpen', p.inspectorOpen ? '1' : '0');
    if ('sidebarWidth' in p) ls.set('ws.sidebarW', String(p.sidebarWidth));
    if ('inspectorWidth' in p) ls.set('ws.inspectorW', String(p.inspectorWidth));
    if ('inspectorTab' in p && p.inspectorTab) ls.set('ws.inspectorTab', p.inspectorTab);
  },
  setTheme: (t) => { ls.set('ws.theme', t); applyTheme(t); set({ theme: t }); },
  setBrand: (b) => { ls.set('ws.brand', b); applyBrand(b); set({ brand: b }); },
  toast: (t) => {
    const id = uid('t');
    const ttl = t.ttl ?? (t.kind === 'error' ? 8000 : 4500);
    set({ toasts: [...get().toasts.slice(-4), { ...t, id, ttl }] });
    if (ttl > 0) setTimeout(() => get().dismissToast(id), ttl);
    return id;
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
  ask: (o) => new Promise<boolean>((resolve) => set({ confirm: { ...o, resolve: (ok) => { set({ confirm: null }); resolve(ok); } } })),
  askText: (o) => new Promise<string | null>((resolve) => set({ prompt: { ...o, resolve: (v) => { set({ prompt: null }); resolve(v); } } })),
  openInspector: (tab, focus) => get().set({ inspectorOpen: true, inspectorTab: tab, inspectorFocus: focus }),
}));
