import { composer, expect, expectIdle, newSessionInProject, openApp, sendPrompt, test, toolCard } from '../../support/app.ts';

const permission = (page: import('@playwright/test').Page) => page.getByRole('group', { name: 'Permission request' });

test.describe('session features', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
  });

  test('approving a plan with auto-accept switches the mode chip to Auto-accept edits', async ({ page }) => {
    await sendPrompt(page, 'make a plan for auto accept');
    await page.getByRole('button', { name: 'Approve & auto-accept edits' }).click();
    await expect(page.locator('.msg-assistant').last()).toContainText('Plan approved, starting work.');
    await expect(page.getByRole('button', { name: /Auto-accept edits/ }).first()).toBeVisible();
    await expectIdle(page);
  });

  test('the question card accepts a free-text Other answer', async ({ page }) => {
    await sendPrompt(page, 'ask me for an other answer');
    await expect(toolCard(page, 'ask').locator('.tool-title')).toHaveText('Claude has a question');
    await page.getByRole('radio', { name: /^vitest/ }).click();
    await page.getByRole('checkbox', { name: /^lint/ }).click();
    await page.getByRole('textbox', { name: 'Other answer' }).first().fill('custom-runner');
    await page.getByRole('radio', { name: /^vitest/ }).click();
    await page.getByRole('button', { name: /Submit answers?/ }).click();
    await expect(page.locator('.msg-assistant').last()).toContainText('lint');
    await expectIdle(page);
  });

  test('a sidebar session can be renamed from its context menu', async ({ page }) => {
    await sendPrompt(page, 'rename me please');
    await expectIdle(page);
    const row = page.locator('.sess', { hasText: 'rename me please' });
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename…' }).click();
    const input = page.getByRole('textbox', { name: 'Rename session' });
    await input.fill('Renamed by e2e');
    await input.press('Enter');
    await expect(page.locator('.sess', { hasText: 'Renamed by e2e' })).toBeVisible();
    await expect(page.locator('.topbar-session')).toHaveText('Renamed by e2e');
  });

  test('a sidebar session can be deleted after confirmation', async ({ page }) => {
    await sendPrompt(page, 'delete me please');
    await expectIdle(page);
    const row = page.locator('.sess', { hasText: 'delete me please' });
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this session?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.sess', { hasText: 'delete me please' })).toHaveCount(0);
  });

  test('an unsent draft survives a reload of the same session', async ({ page }) => {
    await sendPrompt(page, 'first message for draft check');
    await expectIdle(page);
    await composer(page).fill('unsent draft text');
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('ws.draft.')))).toBe(true);
    await page.reload();
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
    await page.locator('.sess', { hasText: 'first message for draft check' }).click();
    await expect(composer(page)).toHaveValue('unsent draft text');
  });

  test('the model and effort chips change the session settings', async ({ page }) => {
    await sendPrompt(page, 'hello chips');
    await expectIdle(page);
    // The model/mode/effort chips live in the composer (the top bar only shows status and cost).
    const chips = page.locator('.composer-chips');
    await chips.getByRole('button', { name: 'Medium' }).click();
    await page.getByRole('menuitem', { name: /^High/ }).click();
    await expect(chips.getByRole('button', { name: 'High' })).toBeVisible();
    // Label casing is covered by BUG-002 below; here we only check the selection took effect.
    await chips.getByRole('button', { name: /Default model/ }).click();
    await page.getByRole('menuitem', { name: /^Opus/ }).click();
    await expect(chips.getByRole('button', { name: /default model/i })).toHaveCount(0);
    await expect(chips.getByRole('button', { name: /opus/i })).toBeVisible();
  });

  test('BUG-002: the model chip shows the friendly name of the chosen model', async ({ page }) => {
    test.fail(true, 'BUG-002: chip shows the raw alias "opus" while the menu says "Opus"; see BUGS.md');
    await sendPrompt(page, 'hello model label');
    await expectIdle(page);
    const chips = page.locator('.composer-chips');
    await chips.getByRole('button', { name: /Default model/ }).click();
    await page.getByRole('menuitem', { name: /^Opus/ }).click();
    await expect(chips.getByRole('button', { name: 'Opus', exact: true })).toBeVisible({ timeout: 3_000 });
  });

  test('a completed turn reports context usage and cost', async ({ page }) => {
    await sendPrompt(page, 'usage check');
    await expectIdle(page);
    await expect(page.locator('.ctx')).toBeVisible();
    await expect(page.locator('.cost')).toContainText('$');
  });

  test('the inspector toggles open and closed from the keyboard', async ({ page }) => {
    await sendPrompt(page, 'inspector check');
    await expectIdle(page);
    // The overview pane is open by default; the shortcut hides it and shows it again.
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    await page.keyboard.press('Control+Alt+b');
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toHaveCount(0);
    await page.keyboard.press('Control+Alt+b');
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  });

  test('the sidebar search filters sessions and reports no matches', async ({ page }) => {
    await sendPrompt(page, 'searchable session marker');
    await expectIdle(page);
    const search = page.getByRole('textbox', { name: 'Search sessions' });
    await search.fill('zz-no-such-session-xyz');
    await expect(page.getByText('No sessions match.')).toBeVisible();
    await search.fill('searchable session');
    await expect(page.locator('.sess', { hasText: 'searchable session marker' })).toBeVisible();
  });

  test('the demo tour renders its cards and completes after each permission', async ({ page }) => {
    await sendPrompt(page, 'demo everything please');
    for (let i = 0; i < 4; i++) {
      await expect(permission(page)).toBeVisible({ timeout: 20_000 });
      await permission(page).getByRole('button', { name: 'Allow once' }).click();
    }
    // The tour's closing summary is the last assistant text; the mock's "Demo complete." is only the result line.
    await expect(page.locator('.msg-assistant').last()).toContainText('Everything is done', { timeout: 20_000 });
    await expect(toolCard(page, 'task')).toHaveCount(1);
    await expect(toolCard(page, 'todo').last()).toContainText('3/3 done');
    await expect(toolCard(page, 'web').first()).toBeVisible();
    await expectIdle(page);
  });
});
