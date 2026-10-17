import { describe, expect, it } from 'vitest';
import { isNewSessionKey, newSessionShortcut } from './shortcuts';

const key = (o: Partial<Parameters<typeof isNewSessionKey>[0]>) => ({ code: 'KeyN', key: 'n', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...o });

describe('new session shortcut (Ctrl+N is reserved by Chrome)', () => {
  it('Alt+N starts a session in the browser', () => {
    expect(isNewSessionKey(key({ altKey: true }))).toBe(true);
    // Option+N on a Mac types a dead key: the physical code still identifies it
    expect(isNewSessionKey(key({ altKey: true, key: 'Dead' }))).toBe(true);
  });
  it('Ctrl+N still works where the page can see it (desktop app); other chords do not', () => {
    expect(isNewSessionKey(key({ ctrlKey: true }))).toBe(true);
    expect(isNewSessionKey(key({}))).toBe(false);
    expect(isNewSessionKey(key({ altKey: true, shiftKey: true }))).toBe(false);
    expect(isNewSessionKey(key({ code: 'KeyB', key: 'b', altKey: true }))).toBe(false);
  });
  it('is documented as Alt+N outside macOS', () => { expect(newSessionShortcut()).toMatch(/Alt\+N|⌘N/); });
});
