import type { Page } from '@playwright/test';
import { composer, expect, expectIdle, newSessionInProject, openApp, openInspector, sendPrompt, test, toolCard } from '../../support/app.ts';
import { errorsOf, formatIssues, lintPage } from '../../support/layout-lint.ts';

/**
 * Scrutiniser pass 3 regressions (N1 stop/error display, N2 project-only changes, N3 toast pile).
 * The mock now emits the REAL SDK shapes (captured payloads: packages/server/test/fixtures/real-*.json), which is what
 * hid N1 before: its interrupt result used to carry a convenient "Interrupted by user" string the real SDK never sends.
 */

const toast = (page: Page, t: { kind: 'info' | 'success' | 'error' | 'attention'; title: string; body?: string; tag?: string; ttl?: number }) =>
  page.evaluate((x) => (window as unknown as { __ws: { toast: (t: unknown) => string } }).__ws.toast(x), t);
const settingsDialog = (page: Page) => page.getByRole('dialog', { name: /^(Settings|Welcome\. Set up your connection)$/ });

test.describe('N1: a real API error is one actionable message (mock 401, real stream shape)', () => {
  test('shows the real message with an Open Settings action, and no false "Interrupted by user" or raw diagnostic', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'please say hi 401');
    const banner = page.locator('.banner.error', { hasText: 'API error 401: authentication_failed' });
    await expect(banner).toBeVisible();
    await expectIdle(page);
    await expect(page.locator('.banner.error')).toHaveCount(1); // exactly one: the result adds no second banner
    const body = page.locator('.conv');
    await expect(body).not.toContainText('Interrupted by user');
    await expect(body).not.toContainText('ede_diagnostic');
    await expect(body).not.toContainText('Something went wrong');
    // the action leads to the place that fixes it
    await banner.getByRole('button', { name: 'Open Settings' }).click();
    await expect(settingsDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    // an error is a real error: the session shows it (status), unlike a Stop
    await expect(page.locator('.status-pill')).toContainText(/Error/);
  });

  test('the server error is not also dumped into a toast', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'say 401 again');
    await expect(page.locator('.banner.error')).toBeVisible();
    await expect(page.locator('.toast', { hasText: 'API error 401' })).toHaveCount(0);
  });
});

test.describe('N2: only project files are changes; plan files are separate', () => {
  async function planApproved(page: Page) {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'make a plan for it');
    await page.getByRole('button', { name: 'Approve plan' }).click();
    await expect(page.locator('.msg-assistant').last()).toContainText('Plan approved, starting work.');
    await expectIdle(page);
    await openInspector(page, 'overview');
  }

  test('the plan file appears as a "Plan file" row in Outputs and never in the Changes count or list', async ({ page }) => {
    await planApproved(page);
    const outputs = page.locator('[data-card="outputs"]');
    await expect(outputs.getByText('Plan file', { exact: true })).toBeVisible();
    await expect(outputs.locator('[title*="plan-do-not-edit-lexical-quill.md"]').first()).toBeVisible();
    // the project fixture has exactly 3 uncommitted files (edited example.ts, edited long.txt, new NOTES.md): the plan is not a 4th
    const card = page.locator('[data-card="changes"]');
    await expect(card.locator('.ovc-aside')).toHaveText('3 files');
    await page.locator('.itab[data-panel="changes"]').click();
    await expect(page.locator('.changes-sum')).toContainText('3 files');
    await expect(page.locator('.cfile')).toHaveCount(3);
    await expect(page.locator('.changes')).not.toContainText('lexical-quill');
    await expect(page.locator('.itab[data-panel="changes"] .badge, .itab[data-panel="changes"] [class*=badge]').first()).toContainText('3');
  });

  test('the Changes card count, the Changes tab, and the Commit button list can never disagree', async ({ page }) => {
    await planApproved(page);
    const aside = await page.locator('[data-card="changes"] .ovc-aside').innerText();
    await page.locator('.itab[data-panel="changes"]').click();
    const header = await page.locator('.changes-sum b').innerText();
    const commit = await page.locator('.ccommit-row .muted').innerText();
    const n = (t: string) => Number(/\d+/.exec(t)![0]);
    expect(n(aside)).toBe(n(header));
    expect(n(header)).toBe(n(commit));
    await expect(page.locator('.cfile')).toHaveCount(n(commit));
  });

  test('Outputs paths ellipsize in the middle (full path as tooltip) and the inspector has no horizontal scrollbar', async ({ page }) => {
    await planApproved(page);
    const row = page.locator('[data-card="outputs"] .ov-item', { hasText: 'Plan file' });
    await expect(row).toBeVisible();
    const head = row.locator('.mid-head').first();
    await expect(head).toBeVisible();
    // the end of the name (".md") is always visible; the row does not overflow its card
    await expect(row.locator('.mid-tail').first()).toContainText('.md');
    const fits = await row.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= el.closest('.ovc')!.getBoundingClientRect().right + 1);
    expect(fits).toBe(true);
    const hs = await page.locator('.inspector-body').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ov: getComputedStyle(el.firstElementChild as Element).overflowX }));
    expect(hs.sw).toBeLessThanOrEqual(hs.cw + 1);
    const issues = errorsOf(await lintPage(page, { brand: 'horizon' }));
    expect(issues, formatIssues(issues)).toEqual([]);
  });

  test('the Edit the mock makes inside the project is still an output and a change', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'edit the greeting');
    await page.locator('[data-perm-allow]').first().click();
    await expectIdle(page);
    await openInspector(page, 'overview');
    await expect(page.locator('[data-card="outputs"] .ov-item', { hasText: 'example.ts' })).toBeVisible();
    await expect(page.locator('[data-card="outputs"]').getByText('Plan file')).toHaveCount(0);
  });
});

test.describe('N3: toasts', () => {
  test('repeats coalesce into one toast with a count', async ({ page }) => {
    await openApp(page);
    for (let i = 0; i < 5; i++) await toast(page, { kind: 'success', tag: 'coalesce-s1', title: 'Coalesce finished', body: 'bash please: Ready for your review', ttl: 0 });
    const mine = page.locator('.toast', { hasText: 'Coalesce finished' });
    await expect(mine).toHaveCount(1);
    await expect(mine.locator('.toast-count')).toHaveText('×5');
  });

  test('at most two toasts are visible at once; the rest queue and appear as others go', async ({ page }) => {
    await openApp(page);
    // other sessions on the shared mock server may raise their own toasts: start from a clean slate
    while (await page.locator('.toast').count()) await page.locator('.toast').first().getByRole('button', { name: 'Dismiss' }).click();
    for (const s of ['a', 'b', 'c', 'd', 'e']) await toast(page, { kind: 'success', tag: `q-${s}`, title: `Queued ${s}`, ttl: 0 });
    await expect(page.locator('.toast')).toHaveCount(2);
    await expect(page.locator('.toast-more')).toHaveText('+3 more');
    await page.locator('.toast').first().getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('.toast').first()).toContainText('Queued b');
    await expect(page.locator('.toast')).toHaveCount(2);
    await expect(page.locator('.toast-more')).toHaveText('+2 more');
  });

  test('finished/info toasts dismiss themselves after about 4 seconds', async ({ page }) => {
    await openApp(page);
    await toast(page, { kind: 'success', title: 'Session finished', body: 'auto' });
    await expect(page.locator('.toast')).toHaveCount(1);
    const t0 = Date.now();
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 8000 });
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThan(2500);
    expect(dt).toBeLessThan(6500);
  });

  for (const width of [1480, 560, 360]) {
    test(`a pile of toasts never covers Allow/Deny, the composer or its suggestions at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openApp(page);
      await newSessionInProject(page);
      await sendPrompt(page, 'bash please');
      await expect(page.locator('[data-perm-allow]').first()).toBeVisible();
      for (const s of ['a', 'b', 'c', 'd', 'e']) await toast(page, { kind: 'attention', tag: s, title: 'Approval needed', body: `session ${s}: wants to run something`, ttl: 0 });
      await composer(page).fill('/');
      await expect(page.locator('.toast').first()).toBeVisible();
      const visible = await page.locator('.toast').count();
      expect(visible).toBeLessThanOrEqual(width <= 800 ? 1 : 2);
      const overlaps = await page.evaluate(() => {
        const rects = (sel: string) => [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
        const toasts = rects('.toast');
        const targets = [...rects('[data-perm-allow]'), ...rects('[data-perm-deny], .perm-actions button'), ...rects('.composer'), ...rects('.suggest')];
        return toasts.flatMap((t) => targets.filter((r) => Math.min(t.right, r.right) - Math.max(t.left, r.left) > 1 && Math.min(t.bottom, r.bottom) - Math.max(t.top, r.top) > 1).map((r) => `${r.width | 0}x${r.height | 0}@${r.left | 0},${r.top | 0}`));
      });
      expect(overlaps).toEqual([]);
      const issues = errorsOf(await lintPage(page, { brand: 'horizon' }));
      expect(issues, formatIssues(issues)).toEqual([]);
    });
  }

  test('popovers and menus stack above toasts', async ({ page }) => {
    await page.setViewportSize({ width: 1480, height: 800 });
    await openApp(page);
    await newSessionInProject(page);
    await toast(page, { kind: 'info', title: 'Hello toast', ttl: 0 });
    await page.getByRole('button', { name: 'Appearance' }).click();
    const z = await page.evaluate(() => {
      const num = (sel: string) => Number(getComputedStyle(document.querySelector(sel)!).zIndex);
      return { toasts: num('.toasts'), popover: num('.popover') };
    });
    expect(z.popover).toBeGreaterThan(z.toasts);
  });
});

test.describe('minors', () => {
  test('opening Settings yourself is titled "Settings"; "Welcome" is only for the automatic first-run prompt', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.removeItem('ws.firstRunDone'); } catch { /* ignore */ } });
    await openApp(page);
    const welcome = page.getByRole('dialog', { name: /Welcome\. Set up your connection/ });
    if (await welcome.isVisible().catch(() => false)) { await page.keyboard.press('Escape'); await expect(welcome).toHaveCount(0); }
    await page.keyboard.press('Control+,');
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('switching sessions keeps an opened thinking / tool card open', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'bash please');
    await page.locator('[data-perm-allow]').first().click();
    await expectIdle(page);
    const card = toolCard(page, 'bash').first();
    const head = card.locator('.tool-head');
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    const think = page.locator('.thinking-head').first();
    const hadThinking = (await think.count()) > 0;
    if (hadThinking) await think.click();
    // another session, then back
    await newSessionInProject(page);
    await sendPrompt(page, 'hello other');
    await expectIdle(page);
    const rows = page.locator('.sess-row, .sess').filter({ hasText: 'bash please' });
    await rows.first().click();
    await expect(toolCard(page, 'bash').first().locator('.tool-head')).toHaveAttribute('aria-expanded', 'true');
    if (hadThinking) await expect(page.locator('.thinking-head').first()).toHaveAttribute('aria-expanded', 'true');
  });

  test('a zero-sided change is not shown as a red "−0"', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'write a notes file');
    await page.locator('[data-perm-allow]').first().click();
    await expectIdle(page);
    await expect(page.locator('.tool-write .stats .add').first()).toBeVisible();
    await expect(page.locator('.stats .del', { hasText: '−0' })).toHaveCount(0);
    await openInspector(page, 'overview');
    await expect(page.locator('.stats .del', { hasText: '−0' })).toHaveCount(0);
  });
});
