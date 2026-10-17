import { expect, test as base, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { projectDir, TOKEN } from './env.ts';

/**
 * Test fixture. Every page starts with the first-run settings prompt dismissed (it is a per-viewer
 * convenience flag, so localStorage is the right place for it). Tests that need the prompt clear it.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('ws.firstRunDone', '1'); } catch { /* storage may be blocked */ }
    });
    await use(page);
  },
});
export { expect };
export { TOKEN } from './env.ts';

export const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * Opens the app with the given token (default: the fixed test token). With the valid token it also waits
 * for the server's `hello` frame, so the connection is known to be up before a test acts.
 */
export async function openApp(page: Page, opts: { token?: string | null; path?: string } = {}) {
  const token = opts.token === undefined ? TOKEN : opts.token;
  const q = token === null ? '' : `?token=${encodeURIComponent(token)}`;
  const connected = token === TOKEN
    ? page.waitForEvent('websocket').then((ws) => ws.waitForEvent('framereceived', { predicate: (f) => String(f.payload).includes('"type":"hello"'), timeout: 15_000 }))
    : undefined;
  await page.goto((opts.path ?? '/') + q);
  if (connected) await connected;
  await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
}

export const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Claude' });

/** Types a prompt and presses Enter (send or queue, depending on state). */
export async function sendPrompt(page: Page, text: string) {
  const box = composer(page);
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press('Enter');
}

/** Creates a new session in the fixture project through the picker and returns once the draft is open. */
export async function newSessionInProject(page: Page) {
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Open a project' });
  if (await picker.isVisible().catch(() => false)) {
    await picker.getByRole('button', { name: /^Open “/ }).click();
  }
  await expect(page.getByRole('heading', { name: 'What should we work on?' })).toBeVisible();
  await expect(composer(page)).toBeFocused();
}

/** The conversation's user message bubbles, in order. */
export const userMessages = (page: Page) => page.locator('.msg-user-text');

/** Waits for the finished-turn marker (the result line or the working indicator to be gone). */
export async function expectIdle(page: Page) {
  await expect(page.locator('.working')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
}

export function toolCard(page: Page, kind: string, text?: string): Locator {
  const c = page.locator(`.tool-${kind}`);
  return text ? c.filter({ hasText: text }) : c;
}

/** Opens a collapsed tool card so its body (diff, output, questions) is in the DOM. */
export async function expandTool(card: Locator) {
  const head = card.locator('.tool-head');
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
}

export const fixtureFile = (rel: string) => path.join(projectDir(), rel);
