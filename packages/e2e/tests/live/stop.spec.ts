import { composer, expect, expectIdle, newSessionInProject, openApp, sendPrompt, test, toolCard } from '../../support/app.ts';

/**
 * N1 regression: a user Stop is neutral. The (slowed) mock emits the real SDK result for an interrupt: subtype
 * error_during_execution whose only error is "[ede_diagnostic] ...", with terminal_reason aborted_* (see
 * packages/server/test/fixtures/real-interrupt-*.json), which the old text-matching code showed as a red error banner.
 */
const stop = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Stop', exact: true });
const noErrorAnywhere = async (page: import('@playwright/test').Page) => {
  await expect(page.locator('.banner.error')).toHaveCount(0);
  await expect(page.locator('.conv')).not.toContainText('Something went wrong');
  await expect(page.locator('.conv')).not.toContainText('ede_diagnostic');
  await expect(page.locator('.conv')).not.toContainText('Interrupted by user');
  await expect(page.locator('.status-pill')).not.toContainText(/Error/);
  await expect(page.locator('.sess-st .st-error, .st-dot.st-error')).toHaveCount(0);
  await expect(page.locator('.toast-error')).toHaveCount(0);
};

test.describe('Stop is neutral', () => {
  test('Stop mid-stream: a neutral "Stopped" marker, idle session, no error anywhere', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'slow stop me');
    await expect(stop(page)).toBeVisible();
    await expect(page.locator('.msg-assistant').last()).toContainText('word1 ');
    await stop(page).click();
    const marker = page.locator('.result-line.stopped');
    await expect(marker).toBeVisible();
    await expect(marker).toContainText('Stopped');
    await expectIdle(page);
    await noErrorAnywhere(page);
    await expect(page.locator('.status-pill')).toContainText(/Idle/);
    // neutral colour, not red
    const color = await marker.evaluate((e) => getComputedStyle(e).color);
    expect(color).not.toMatch(/rgb\((1[6-9]\d|2\d\d), ?\d{1,2}, ?\d{1,2}\)/);
    // and the session is fine afterwards
    await sendPrompt(page, 'hello after stop');
    await expect(page.locator('.msg-assistant').last()).toContainText('Here is a mock reply to: "hello after stop"');
    await noErrorAnywhere(page);
  });

  test('Stop while a permission prompt is open: the step is a neutral stopped step, not a red error', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'bash please');
    await expect(page.locator('[data-perm-allow]').first()).toBeVisible();
    await composer(page).focus();
    await stop(page).click();
    await expect(page.locator('.result-line.stopped')).toBeVisible();
    await expectIdle(page);
    await expect(toolCard(page, 'bash').first()).toHaveClass(/st-stopped/);
    await expect(page.locator('.tool.st-error')).toHaveCount(0);
    await noErrorAnywhere(page);
    // the step's own text is not an error either (the real rejection text is not shown as a failure)
    await expect(page.locator('[data-perm-allow]')).toHaveCount(0);
  });
});
