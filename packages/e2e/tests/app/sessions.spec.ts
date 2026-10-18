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

  test('an invalid folder path shows an error and does not open a session', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Open project', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Open a project' });
    await picker.getByRole('textbox', { name: 'Folder path' }).fill('/definitely/not/a/real/folder-xyz');
    await picker.getByRole('textbox', { name: 'Folder path' }).press('Enter');
    await expect(picker.locator('.dir-empty.err')).toBeVisible();
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: 'Cancel' }).click();
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

  test('the sidebar truncates a long project list and can expand it or collapse the project', async ({ page }) => {
    // Seven full round trips plus scrolling: give it more room than the default per-test budget.
    test.setTimeout(120_000);
    await openApp(page);
    // Open the fixture project explicitly: the sidebar's plain "New session" uses the most recent project,
    // which other tests may have changed.
    await page.getByRole('button', { name: 'Open project', exact: true }).click();
    await page.getByRole('dialog', { name: 'Open a project' }).getByRole('button', { name: /^Open “project”$/ }).click();
    await expect(page.getByRole('heading', { name: 'What should we work on?' })).toBeVisible();
    // Ensure more than six sessions exist in this project, each with a distinct title.
    const stamp = Date.now().toString(36);
    for (let i = 0; i < 7; i++) {
      await page.getByRole('button', { name: 'New session in project', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'What should we work on?' })).toBeVisible();
      await sendPrompt(page, `bulk session ${stamp} ${i}`);
      await expectIdle(page);
    }
    const project = page.locator('section.proj').filter({ has: page.locator('.proj-name', { hasText: 'project' }) }).first();
    await expect(project.locator('.sess').first()).toBeVisible();
    // six by recency, plus any session of this shared server that needs input or is running (those are never folded away)
    await expect.poll(async () => (await project.locator('.sess').count()) - (await project.locator('.sess.attn, .sess.run').count())).toBeLessThanOrEqual(6);
    expect(await project.locator('.sess').count()).toBeGreaterThanOrEqual(6);
    const more = project.getByRole('button', { name: /^Show \d+ more$/ });
    await expect(more).toBeVisible();
    await more.click();
    await expect(project.locator('.sess').filter({ hasText: `bulk session ${stamp}` })).toHaveCount(7);

    const toggle = project.locator('.proj-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(project.locator('.sess')).toHaveCount(0);
    await toggle.click();
    await expect(project.locator('.sess').first()).toBeVisible();
  });
});
