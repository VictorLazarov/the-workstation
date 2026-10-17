/**
 * Session titles must not change between a live session and the list read back from disk (after a reload or a restart).
 * The SDK's `summary` is NOT stable: for a session without an AI title it is the LATEST prompt, so it changes with every turn,
 * while the live title is the first prompt. The first prompt is the stable one; an explicit rename (customTitle) wins over it.
 */
export const TITLE_MAX = 60;

export function titleFromPrompt(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1).trimEnd() + '…' : t; // identical to web/src/lib/utils truncate()
}

export function sessionTitle(i: { customTitle?: string; firstPrompt?: string; summary?: string }): string {
  return i.customTitle?.trim() || (i.firstPrompt ? titleFromPrompt(i.firstPrompt) : '') || i.summary?.trim() || 'Untitled';
}
