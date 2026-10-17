/**
 * Platform adapter: every native-ish capability goes through here so an Electron/Tauri build can
 * swap the implementation (set `window.__WORKSTATION_PLATFORM__` before the app boots, or call
 * `setPlatform`). UI components must never touch Electron/Node APIs directly.
 */
export interface Platform {
  readonly name: 'browser' | 'electron' | 'tauri' | string;
  /** Native folder dialog. Undefined in the browser: the UI falls back to the server-side directory browser. */
  pickFolder?(): Promise<string | null>;
  copyText(text: string): Promise<void>;
  notificationsSupported(): boolean;
  notificationPermission(): 'granted' | 'denied' | 'default' | 'unsupported';
  requestNotificationPermission(): Promise<boolean>;
  notify(opts: { title: string; body?: string; tag?: string; onClick?: () => void }): void;
  /** Open a file in the user's editor (needs a native shell; browser: unsupported). */
  openInEditor?(path: string, line?: number): Promise<void>;
  revealInFinder?(path: string): Promise<void>;
  openExternal(url: string): void;
}

export const browserPlatform: Platform = {
  name: 'browser',
  async copyText(text) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
  },
  notificationsSupported: () => typeof Notification !== 'undefined',
  notificationPermission: () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission),
  async requestNotificationPermission() {
    if (typeof Notification === 'undefined') return false;
    return (await Notification.requestPermission()) === 'granted';
  },
  notify({ title, body, tag, onClick }) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try { const n = new Notification(title, { body, tag }); n.onclick = () => { window.focus(); onClick?.(); }; } catch { /* ignore */ }
  },
  openExternal: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
};

let current: Platform = (globalThis as { __WORKSTATION_PLATFORM__?: Platform }).__WORKSTATION_PLATFORM__ ?? browserPlatform;
export const getPlatform = (): Platform => current;
export const setPlatform = (p: Platform) => { current = p; };
export const platform: Platform = new Proxy({} as Platform, { get: (_t, k) => (current as never)[k], has: (_t, k) => k in current });
