import type { Page } from '@playwright/test';
import { closeDrawers, expect, expectIdle, newSessionInProject, openApp, openInspector, sendPrompt, setAppearance, test } from '../../support/app.ts';
import { errorsOf, formatIssues, lintPage } from '../../support/layout-lint.ts';

/**
 * Layout lint for the Logs feature at 1480 / 1100 / 800 / 560px in light and dark: the panel (entries, an expanded row opened by
 * "View details", the jump strip, the empty-filter state, debug on), the Logs dialog without a session, the Overview diagnostics
 * card with the red tab badge, an error toast with its "View details" action, and Settings with "View logs".
 */
const logs = (page: Page) => page.getByTestId('logs-view');

test.describe('layout lint: Logs', () => {
  test.describe.configure({ timeout: 120_000 });
  for (const width of [1480, 1100, 800, 560]) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${width}px ${theme}`, async ({ page }) => {
        const log: string[] = [];
        page.on('console', (m) => { if (m.type() === 'error') log.push(`console.error: ${m.text()}`); });
        page.on('pageerror', (e) => log.push(`pageerror: ${e.message}`));
        page.on('requestfailed', (r) => log.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
        page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/fonts/')) log.push(`http ${r.status()}: ${r.url()}`); });
        await page.setViewportSize({ width, height: 900 });
        await setAppearance(page, { theme, brand: 'horizon', density: 'compact' });
        await openApp(page);

        const failures: string[] = [];
        let checks = 0;
        const check = async (state: string) => {
          await page.waitForTimeout(150);
          const errs = errorsOf(await lintPage(page, { brand: 'horizon' }));
          checks++;
          if (errs.length) failures.push(`── ${state} @ ${width} ${theme}\n${formatIssues(errs)}`);
        };
        const noSideways = async (what: string) => {
          const [sw, cw] = await logs(page).locator('.logs-list').evaluate((e) => [e.scrollWidth, e.clientWidth]);
          expect(sw, `${what}: log list scrolls sideways`).toBeLessThanOrEqual(cw + 1);
        };

        // 1. no session open: Logs in a dialog (command palette)
        await page.keyboard.press('ControlOrMeta+k');
        await page.getByRole('textbox', { name: 'Command palette' }).fill('open logs');
        await page.getByRole('option', { name: /Open logs/ }).click();
        await expect(page.getByRole('dialog', { name: 'Logs' })).toBeVisible();
        await expect(logs(page).locator('.log-row').first()).toBeVisible();
        await check('logs dialog (no session)');
        await noSideways('dialog');
        await page.keyboard.press('Escape');

        // 2. a session with an error and a 401: "View details" lands on the entry (expanded)
        await newSessionInProject(page);
        await sendPrompt(page, 'error please');
        await expectIdle(page);
        await sendPrompt(page, 'hit a 401 now');
        await expect(page.locator('.banner.error').first()).toBeVisible();
        await closeDrawers(page);
        await check('conversation with error banners (View details)');
        await page.locator('.banner.error').last().getByRole('button', { name: 'View details' }).click();
        await expect(logs(page)).toBeVisible();
        await expect(logs(page).locator('.log-row [aria-expanded="true"]')).toHaveCount(1);
        await check('logs: focused entry expanded');
        await noSideways('focused');

        // 3. all sessions, debug on, a long list scrolled away from the tail (jump strip), a detail block open
        await page.getByRole('combobox', { name: 'Session' }).selectOption('all');
        await logs(page).getByRole('button', { name: /^Debug/ }).click();
        await logs(page).locator('.logs-list').evaluate((e) => e.scrollTo(0, 0));
        await expect(logs(page).getByRole('button', { name: 'Jump to latest' })).toBeVisible();
        await logs(page).locator('.log-row').first().locator('.log-head').click();
        await check('logs: all sessions + debug, scrolled up (jump strip)');
        await noSideways('all sessions');
        await logs(page).getByRole('button', { name: 'Jump to latest' }).click();
        await check('logs: at the tail');

        // 4. nothing matches
        await logs(page).getByRole('searchbox', { name: 'Search logs' }).fill('zzz-no-such-entry');
        await expect(logs(page)).toContainText('No entries match these filters');
        await check('logs: empty filter result');
        await logs(page).getByRole('button', { name: 'Reset filters' }).click();

        // 5. Overview with the diagnostics card and the red badge on the Logs tab (a new error arrives while Overview is open)
        await page.locator('.itab[data-panel="overview"]').click();
        await sendPrompt(page, 'error again');
        await expectIdle(page);
        await expect(page.locator('.itab[data-panel="logs"] .itab-badge')).toBeVisible();
        await check('overview: diagnostics card + logs badge');
        await page.locator('[data-card="diagnostics"]').scrollIntoViewIfNeeded();

        // 6. an error toast with "View details"
        await closeDrawers(page); // (a toast sits under an open drawer's scrim: the drawer is transient)
        await page.evaluate(() => (window as unknown as { __ws: { toast: (t: unknown) => string } }).__ws.toast({ kind: 'error', title: 'Something failed', body: 'a long explanation that should wrap inside the toast instead of widening it ' + 'x'.repeat(60) }));
        await expect(page.locator('.toast').getByRole('button', { name: 'View details' })).toBeVisible();
        await check('error toast with View details');
        await page.locator('.toast').getByRole('button', { name: 'View details' }).click();

        // 7. Settings -> View logs
        await closeDrawers(page);
        await page.keyboard.press('ControlOrMeta+,');
        await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'View logs' })).toBeVisible();
        await check('settings with View logs');
        await page.keyboard.press('Escape');

        // the tab strip itself (8 tabs) with Logs active
        await openInspector(page, 'logs');
        await check('inspector tabs with Logs active');

        expect(checks).toBeGreaterThanOrEqual(9);
        expect(failures.join('\n\n')).toBe('');
        expect(log).toEqual([]);
      });
    }
  }
});
