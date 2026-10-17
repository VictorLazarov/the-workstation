import type { WebSocket } from '@playwright/test';
import { expect, expectIdle, newSessionInProject, openApp, sendPrompt, test, toolCard } from '../../support/app.ts';

const permission = (page: import('@playwright/test').Page) => page.getByRole('group', { name: 'Permission request' });

test.describe('permission decisions', () => {
  test('deny with feedback sends the message back to the agent', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'bash that we will deny');
    await expect(permission(page)).toBeVisible();
    await permission(page).getByRole('button', { name: 'Deny…' }).click();
    await page.getByPlaceholder('Optional: tell Claude what to do instead').fill('Use vitest directly instead');
    await permission(page).getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(permission(page)).toHaveCount(0);
    await expect(page.locator('.msg-assistant').last()).toContainText('The command was denied: Use vitest directly instead');
    await expect(toolCard(page, 'bash').first()).toHaveClass(/st-(error|denied)/);
    await expectIdle(page);
  });

  test('deny without a message still resolves the request', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'bash deny silently');
    await permission(page).getByRole('button', { name: 'Deny…' }).click();
    await permission(page).getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(page.locator('.msg-assistant').last()).toContainText('The command was denied: The user denied this action.');
    await expectIdle(page);
  });

  test('Always allow sends remember:true with the decision', async ({ page }) => {
    const sent: string[] = [];
    page.on('websocket', (ws: WebSocket) => ws.on('framesent', (f) => sent.push(String(f.payload))));
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'bash remember this choice');
    await expect(permission(page)).toBeVisible();
    await permission(page).getByRole('button', { name: 'Always allow' }).click();
    await expect(page.locator('.msg-assistant').last()).toContainText('All 20 tests pass.');
    await expectIdle(page);
    const decisions = sent.filter((p) => p.includes('permission.respond'));
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.at(-1)).toContain('"remember":true');
    expect(decisions.at(-1)).toContain('"behavior":"allow"');
  });
});
