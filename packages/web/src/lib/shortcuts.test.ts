import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNewSessionKey, newSessionShortcut } from './shortcuts';

const key = (o: Partial<Parameters<typeof isNewSessionKey>[0]>) => ({ code: 'KeyN', key: 'n', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...o });

// isMac() reads navigator.platform, which Node >= 21 defines from the host OS: pin it so the result does not depend on the runner
const asPlatform = (platform: string) => vi.stubGlobal('navigator', { platform, userAgent: '' });
afterEach(() => vi.unstubAllGlobals());

describe('new session shortcut (Ctrl+N is reserved by Chrome)', () => {
  it('Alt+N starts a session in the browser', () => {
    asPlatform('Win32');
    expect(isNewSessionKey(key({ altKey: true }))).toBe(true);
    // Option+N on a Mac types a dead key: the physical code still identifies it
    expect(isNewSessionKey(key({ altKey: true, key: 'Dead' }))).toBe(true);
  });
  it('Ctrl+N still works where the page can see it (desktop app); other chords do not', () => {
    asPlatform('Win32');
    expect(isNewSessionKey(key({ ctrlKey: true }))).toBe(true);
    expect(isNewSessionKey(key({}))).toBe(false);
    expect(isNewSessionKey(key({ altKey: true, shiftKey: true }))).toBe(false);
    expect(isNewSessionKey(key({ code: 'KeyB', key: 'b', altKey: true }))).toBe(false);
  });
  it('on macOS the desktop chord is Cmd+N, not Ctrl+N', () => {
    asPlatform('MacIntel');
    expect(isNewSessionKey(key({ metaKey: true }))).toBe(true);
    expect(isNewSessionKey(key({ ctrlKey: true }))).toBe(false);
    expect(newSessionShortcut()).toBe('⌘N');
  });
  it('is documented as Alt+N outside macOS', () => { asPlatform('Win32'); expect(newSessionShortcut()).toBe('Alt+N'); });
});
