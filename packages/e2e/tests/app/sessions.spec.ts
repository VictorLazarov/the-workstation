import { composer, expect, expectIdle, newSessionInProject, openApp, sendPrompt, test } from '../../support/app.ts';

test.describe('projects and sessions', () => {
  test('project picker browses folders and opens a new session in the chosen one', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Open project', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Open a project' });
    await expect(picker).toBeVisible();
    const folders = picker.getByRole('listbox', { name: 'Folders' });
    await expect(folders.getByRole('option', { name: 'alpha' })).toBeVisible();
    await expect(folders.getByRole('option', { name: 'beta' })).toBeVisible();
    await folders.getByRole('option', { name: 'alpha' }).dblclick();
    await expect(picker.getByRole('button', { name: 'Open “alpha”' })).toBeVisible();
    await picker.getByRole('button', { name: 'Open “alpha”' }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'What should we work on?' })).toBeVisible();
    await expect(page.locator('.topbar .crumb').first()).toHaveText(/alpha/);
    await expect(composer(page)).toBeFocused();
  });

  test('the picker can be cancelled without opening anything', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Open project', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Open a project' });
    await picker.getByRole('button', { name: 'Cancel' }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'What should we work on?' })).toHaveCount(0);
  });

  test('a prompt streams a markdown reply and the session appears in the sidebar', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'hello streaming world');
    const reply = page.locator('.msg-assistant').last();
    await expect(reply).toContainText('Here is a mock reply to: "hello streaming world"');
    await expect(reply.locator('pre code')).toContainText('const answer = 42');
    await expectIdle(page);
    const row = page.locator('.sess', { hasText: 'hello streaming world' });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('aria-current', 'true');
  });

  test('reload restores the conversation history from the server', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'remember this across reload');
    await expect(page.locator('.msg-assistant').last()).toContainText('remember this across reload');
    await expectIdle(page);

    await page.reload();
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
    await page.locator('.sess', { hasText: 'remember this across reload' }).click();
    await expect(page.locator('.msg-user-text', { hasText: 'remember this across reload' })).toBeVisible();
    await expect(page.locator('.msg-assistant').last()).toContainText('Here is a mock reply to: "remember this across reload"');
  });
});
