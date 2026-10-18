import { composer, expect, expectIdle, newSessionInProject, openApp, sendPrompt, test } from '../../support/app.ts';

test('after Stop the composer has keyboard focus (not <body>), so typing continues', async ({ page }) => {
  await openApp(page);
  await newSessionInProject(page);
  await sendPrompt(page, 'slow stop me');
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await expect(stop).toBeVisible();
  await expect(page.locator('.msg-assistant').last()).toContainText('word1 ');
  await stop.click();
  await expectIdle(page);
  await expect(composer(page)).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await page.keyboard.type('next');
  await expect(composer(page)).toHaveValue('next');
});
