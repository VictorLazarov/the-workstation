import { isMac } from './utils';

/**
 * New session. Ctrl+N is reserved by Chrome (it opens a new window and pages cannot intercept it), so in the browser
 * the shortcut is Alt+N; the desktop app (and macOS, where Cmd+N is not reserved by the page) keeps Cmd/Ctrl+N.
 */
export const newSessionShortcut = (): string => (isMac() ? '⌘N' : 'Alt+N');

/** True for the keydown that should start a new session: Alt+N (browser) or Cmd/Ctrl+N (desktop app). */
export function isNewSessionKey(e: Pick<KeyboardEvent, 'code' | 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): boolean {
  const n = e.code === 'KeyN' || e.key.toLowerCase() === 'n';
  if (!n || e.shiftKey) return false;
  if (e.altKey && !e.ctrlKey && !e.metaKey) return true;
  return (isMac() ? e.metaKey : e.ctrlKey) && !e.altKey;
}
