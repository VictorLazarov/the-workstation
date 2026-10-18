import { composer, expect, expectIdle, newSessionInProject, openApp, openInspector, openSidebar, sendPrompt, test, TOKEN } from '../../support/app.ts';
import { readState } from '../../support/env.ts';
import { startPrivateServer } from '../../support/server.ts';

const S = readState();

/** Order of the conversation's visible rows, as short tags. */
const order = (page: import('@playwright/test').Page) =>
  page.locator('.conv .msg-user, .conv .msg-assistant, .conv .result-line').evaluateAll((els) => els.map((e) => (e.classList.contains('msg-user') ? 'U' : e.classList.contains('msg-assistant') ? 'A' : 'R')));

test.describe('pass 5: history replay keeps each turn footer after its own answer', () => {
  test('two turns, reload, reopen: U A R U A R (never all footers at the end)', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'replay order one');
    await expectIdle(page);
    await sendPrompt(page, 'replay order two');
    await expectIdle(page);
    const live = await order(page);
    expect(live.join('')).toMatch(/^(UA+R)(UA+R)$/);
    await page.reload();
    await openSidebar(page);
    await page.locator('.sess', { hasText: 'replay order one' }).first().click();
    await expect(page.locator('.conv .msg-user')).toHaveCount(2);
    await expectIdle(page);
    await expect.poll(async () => (await order(page)).join('')).toBe(live.join(''));
    await expect(composer(page)).toBeVisible();
  });
});

test.describe('pass 5: composer, palette, diff', () => {
  test('slash menu: built-in commands first, internal ones hidden, ONE Enter runs a command without arguments', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await composer(page).fill('/');
    const opts = page.getByRole('listbox', { name: 'Commands' }).getByRole('option');
    await expect(opts.first()).toBeVisible();
    const labels = await opts.locator('.suggest-label').allTextContents();
    expect(labels.some((l) => l.startsWith('/__'))).toBe(false);
    expect(labels.indexOf('/compact')).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('/mock-skill')).toBeGreaterThan(labels.indexOf('/compact')); // skills after built-ins
    await composer(page).fill('/comp');
    await expect(opts.first()).toContainText('/compact');
    await composer(page).press('Enter');
    await expect(page.locator('.msg-user').first()).toContainText('/compact'); // sent by the first Enter
    await expect(composer(page)).toHaveValue('');
    await expectIdle(page);
  });

  test('palette: "Open terminal" opens the Terminal tab', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').or(page.getByRole('textbox', { name: /command|search/i })).first().fill('term');
    await page.getByRole('option', { name: /Open terminal/ }).first().click();
    await expect(page.locator('.itab[data-panel="terminal"]')).toHaveAttribute('aria-selected', 'true');
  });

  test('a long line comment stays readable in the narrow inspector and focus returns to the composer after sending the review', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await openApp(page);
    await newSessionInProject(page);
    await openInspector(page, 'changes');
    const file = page.locator('.cfile', { hasText: 'long.txt' });
    await expect(file).toBeVisible();
    const row = file.locator('.diff-row.diff-add').first();
    await row.hover();
    await row.getByRole('button', { name: /^Comment on line \d+/ }).click();
    const text = 'removeTodo should throw if the id does not exist, and say which id it was so the caller can tell';
    await page.getByRole('textbox', { name: 'Comment' }).fill(text);
    await page.getByRole('button', { name: 'Add comment' }).click();
    const scroll = file.locator('.cdiff-scroll');
    await scroll.evaluate((el) => { el.scrollLeft = 300; });
    const cmt = file.locator('.cmt').first();
    await expect(cmt).toBeVisible();
    const [c, s] = await Promise.all([cmt.boundingBox(), scroll.boundingBox()]);
    expect(c!.x).toBeGreaterThanOrEqual(s!.x - 1);
    expect(c!.x + c!.width).toBeLessThanOrEqual(s!.x + s!.width + 1);
    await expect(file.locator('.cmt-text')).toHaveText(text);
    await page.getByRole('button', { name: 'Send to agent' }).click();
    await expect(composer(page)).toBeFocused();
    await expectIdle(page);
  });
});

test.describe('pass 5: bypass permissions unavailable (server as root, no sandbox)', () => {
  test('mode menu disables Bypass with the reason; Shift+Tab and the palette never select it', async ({ page }) => {
    const srv = await startPrivateServer({ cwd: S.project, env: { WORKSTATION_ALLOW_BYPASS: '0' } });
    try {
      const base = srv.base;
      const health = await (await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as any;
      expect(health.bypassPermissions.available).toBe(false);
      await page.goto(`${base}/?token=${TOKEN}`);
      await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
      await openSidebar(page);
      await page.getByRole('button', { name: 'New session', exact: true }).click();
      const dlg = page.getByRole('dialog', { name: 'Open a project' });
      if (await dlg.isVisible().catch(() => false)) await dlg.getByRole('button', { name: /^Open “/ }).click();
      await expect(composer(page)).toBeFocused();
      await page.locator('[class*="mode-"] > .chip-btn').click();
      const item = page.getByRole('menuitem', { name: /Bypass permissions/ });
      await expect(item).toBeDisabled();
      await expect(item).toContainText('switched off'); // WORKSTATION_ALLOW_BYPASS=0 here; as root the reason names root + IS_SANDBOX (unit-tested)
      await page.keyboard.press('Escape');
      for (let i = 0; i < 6; i++) {
        await composer(page).press('Shift+Tab');
        await expect(page.locator('[class*="mode-"] > .chip-btn')).not.toContainText('Bypass');
      }
      await page.keyboard.press('Control+k');
      await page.getByRole('combobox').or(page.getByRole('textbox', { name: /command|search/i })).first().fill('bypass');
      await expect(page.getByRole('option', { name: /Mode: Bypass/ })).toHaveCount(0);
    } finally { srv.stop(); }
  });
});

test('the "Not connected" toast disappears when the connection is back', async ({ page }) => {
  let down = false;
  const open: import('@playwright/test').WebSocketRoute[] = [];
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => { if (down) { ws.close(); return; } open.push(ws); ws.connectToServer(); });
  await openApp(page);
  await newSessionInProject(page);
  await sendPrompt(page, 'before the outage');
  await expectIdle(page);
  down = true;
  for (const ws of open.splice(0)) ws.close();
  await expect(page.getByRole('alert').filter({ hasText: /Connection lost|Connecting to the server/ })).toBeVisible();
  await sendPrompt(page, 'while offline');
  const toast = page.locator('.toast', { hasText: 'Not connected' });
  await expect(toast).toBeVisible();
  down = false;
  await expect(page.locator('.msg-user', { hasText: 'while offline' })).toBeVisible({ timeout: 20_000 });
  await expect(toast).toHaveCount(0);
});
