import { expect, expectIdle, newSessionInProject, openApp, sendPrompt, test, TOKEN } from '../../support/app.ts';

const palette = (page: import('@playwright/test').Page) => page.getByRole('textbox', { name: 'Command palette' });
// The settings dialog is titled "Welcome. Set up your connection" until a key or base URL is configured.
const settingsDialog = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: /^(Settings|Welcome\. Set up your connection)$/ });
const SECRET = 'sk-ant-api03-E2E-SECRET-DO-NOT-ECHO-0001';

test.describe('command palette and theme', () => {
  test('Ctrl+K opens the palette, filters commands and runs the chosen one', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette(page)).toBeFocused();
    await palette(page).fill('Theme: Dark');
    await expect(page.getByRole('option', { name: /Theme: Dark/ })).toBeVisible();
    await expect(page.getByRole('option')).toHaveCount(1);
    await palette(page).press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(palette(page)).toHaveCount(0);
  });

  test('Escape closes the palette', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette(page)).toHaveCount(0);
  });

  test('the palette shows a no-results state for unknown text', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('ControlOrMeta+k');
    await palette(page).fill('zzqqxx-no-such-command');
    await expect(page.getByText('No results')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('palette can change the permission mode of the open session', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await page.keyboard.press('ControlOrMeta+k');
    await palette(page).fill('Mode: Plan mode');
    await palette(page).press('Enter');
    await expect(page.getByRole('button', { name: /Plan mode/ }).first()).toBeVisible();
  });

  test('theme can be switched to light and back to system from the palette', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('ControlOrMeta+k');
    await palette(page).fill('Theme: Light');
    await palette(page).press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('');
    await page.keyboard.press('ControlOrMeta+k');
    await palette(page).fill('Theme: System');
    await palette(page).press('Enter');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  });

  test('the settings theme control switches appearance and persists it', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('ControlOrMeta+,');
    const dialog = settingsDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(dialog.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.reload();
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.keyboard.press('ControlOrMeta+k');
    await palette(page).fill('Theme: System');
    await palette(page).press('Enter');
  });
});

test.describe('settings dialog', () => {
  test('saves the base URL, never shows the API key back, and rejects a bad URL', async ({ page, request, baseURL }) => {
    await openApp(page);
    await page.keyboard.press('ControlOrMeta+,');
    const dialog = settingsDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Anthropic base URL').fill('https://gateway.example.test/anthropic');
    await dialog.getByLabel(/^API key/).fill(SECRET);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Settings saved')).toBeVisible();
    await expect(dialog).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+,');
    const again = settingsDialog(page);
    await expect(again.getByLabel('Anthropic base URL')).toHaveValue('https://gateway.example.test/anthropic');
    const keyField = again.getByLabel(/^API key/);
    await expect(keyField).toHaveValue('');
    await expect(keyField).toHaveAttribute('placeholder', /leave blank to keep/);
    await expect(again.getByText('set', { exact: true })).toBeVisible();
    expect(await page.content()).not.toContain(SECRET);

    const cfg = await request.get(`${baseURL}/api/config`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(cfg.status()).toBe(200);
    expect(await cfg.text()).not.toContain(SECRET);
    await again.getByRole('button', { name: 'Cancel' }).click();
  });

  test('a non-http base URL is rejected with an error toast', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('ControlOrMeta+,');
    const dialog = settingsDialog(page);
    await dialog.getByLabel('Anthropic base URL').fill('ftp://not-http.example.test');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not save settings' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'must start with http' })).toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('Ctrl+B hides and restores the sidebar', async ({ page }) => {
    await openApp(page);
    const side = page.getByRole('complementary', { name: 'Sessions' });
    await page.keyboard.press('ControlOrMeta+b');
    await expect(side).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+b');
    await expect(side).toBeVisible();
  });

  test('settings are reachable from the session context without losing the open conversation', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'keep this conversation open');
    await expectIdle(page);
    await page.getByRole('button', { name: 'Settings (Ctrl+,)' }).click();
    await expect(settingsDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.msg-assistant').last()).toContainText('keep this conversation open');
  });
});
