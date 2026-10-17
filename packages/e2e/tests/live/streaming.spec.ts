import { composer, expect, expectIdle, newSessionInProject, openApp, sendPrompt, test } from '../../support/app.ts';

const stop = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Stop', exact: true });

test.describe('streaming and interrupt (slowed mock)', () => {
  test('the reply streams in while the status shows Working, then settles', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'slow streaming check');
    await expect(stop(page)).toBeVisible();
    await expect(page.locator('.status-pill')).toContainText('Working');
    const reply = page.locator('.msg-assistant').last();
    // Partial text is visible before the turn finishes.
    await expect(reply).toContainText('word3 ');
    await expect(reply).not.toContainText('word119');
    await expect(reply).toContainText('word119', { timeout: 30_000 });
    await expectIdle(page);
    await expect(page.locator('.status-pill')).not.toContainText('Working');
  });

  test('the Stop button interrupts the turn and marks it Stopped', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'slow to stop please');
    await expect(stop(page)).toBeVisible();
    await expect(page.locator('.msg-assistant').last()).toContainText('word1 ');
    await stop(page).click();
    await expect(page.locator('.result-line', { hasText: 'Stopped' })).toBeVisible();
    await expectIdle(page);
    await expect(page.locator('.msg-assistant').last()).not.toContainText('word119');
    await expect(composer(page)).toBeEnabled();
  });

  test('Escape with an empty composer interrupts a running turn', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'slow escape path');
    await expect(stop(page)).toBeVisible();
    await composer(page).focus();
    await composer(page).press('Escape');
    await expect(page.locator('.result-line', { hasText: 'Stopped' })).toBeVisible();
    await expectIdle(page);
  });

  test('a new turn works normally after a Stop', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'slow before stop');
    await expect(stop(page)).toBeVisible();
    await stop(page).click();
    await expect(page.locator('.result-line', { hasText: 'Stopped' })).toBeVisible();
    await expectIdle(page);
    await sendPrompt(page, 'hello after stop');
    await expect(page.locator('.msg-assistant').last()).toContainText('Here is a mock reply to: "hello after stop"');
    await expectIdle(page);
  });

  test('reloading mid-turn reattaches to the running session', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'slow reattach check');
    await expect(stop(page)).toBeVisible();
    await page.reload();
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
    const row = page.locator('.sess', { hasText: 'slow reattach check' });
    await expect(row.locator('.run-text')).toHaveText('Running');
    await row.click();
    await expect(stop(page)).toBeVisible();
    await expect(page.locator('.msg-user-text', { hasText: 'slow reattach check' })).toBeVisible();
    await expect(page.locator('.msg-assistant').last()).toContainText('word119', { timeout: 30_000 });
    await expectIdle(page);
  });
});

test.describe('queueing while running (slowed mock)', () => {
  test('a follow-up typed while running is queued, can be removed, and the kept one is sent after the turn', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'slow queue base');
    await expect(stop(page)).toBeVisible();
    await expect(composer(page)).toHaveAttribute('placeholder', /Claude is working/);

    await sendPrompt(page, 'dropped follow up');
    const queue = page.getByLabel('Queued messages');
    await expect(queue.locator('.queue-item', { hasText: 'dropped follow up' })).toBeVisible();
    await expect(queue.locator('.queue-item', { hasText: 'dropped follow up' }).locator('.queue-tag')).toHaveText('queued');
    await queue.locator('.queue-item', { hasText: 'dropped follow up' }).getByRole('button', { name: 'Remove from queue' }).click();
    await expect(queue.locator('.queue-item', { hasText: 'dropped follow up' })).toHaveCount(0);

    await sendPrompt(page, 'kept follow up');
    await expect(queue.locator('.queue-item', { hasText: 'kept follow up' })).toBeVisible();
    await expect(page.locator('.msg-assistant').last()).toContainText('word119', { timeout: 30_000 });
    await expect(page.locator('.msg-user-text', { hasText: 'kept follow up' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.msg-user-text', { hasText: 'dropped follow up' })).toHaveCount(0);
    await expect(page.locator('.msg-assistant').last()).toContainText('Here is a mock reply to: "kept follow up"', { timeout: 30_000 });
    await expect(queue).toHaveCount(0);
    await expectIdle(page);
  });
});

test.describe('concurrent sessions (slowed mock)', () => {
  test('a second session runs while the first is still running, and the sidebar reports both', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'slow concurrent alpha');
    await expect(stop(page)).toBeVisible();
    const alpha = page.locator('.sess', { hasText: 'slow concurrent alpha' });
    await expect(alpha.locator('.run-text')).toHaveText('Running');

    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What should we work on?' })).toBeVisible();
    await sendPrompt(page, 'hello concurrent beta');
    await expect(page.locator('.msg-assistant').last()).toContainText('Here is a mock reply to: "hello concurrent beta"');
    await expectIdle(page);

    // Alpha is still running in the background; the project header counts it.
    await expect(alpha.locator('.run-text')).toHaveText('Running');
    await expect(page.locator('.proj-live').first()).toHaveText('1');
    await expect(page.locator('.sess', { hasText: 'hello concurrent beta' })).toHaveAttribute('aria-current', 'true');

    // Switching back shows alpha's conversation, still streaming.
    await alpha.click();
    await expect(page.locator('.msg-user-text', { hasText: 'slow concurrent alpha' })).toBeVisible();
    await expect(stop(page)).toBeVisible();
    await expect(page.locator('.msg-assistant').last()).toContainText('word119', { timeout: 30_000 });
    await expect(alpha.locator('.run-text')).toHaveCount(0);
    await expect(page.locator('.proj-live')).toHaveCount(0);
  });
});
