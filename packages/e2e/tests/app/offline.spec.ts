import type { WebSocketRoute } from '@playwright/test';
import { expect, expectIdle, newSessionInProject, openApp, sendPrompt, test } from '../../support/app.ts';

test.describe('M8: messages sent while disconnected', () => {
  test('are kept as "Not sent", sent automatically when the connection is back, and can be retried', async ({ page }) => {
    let down = false;
    const open: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      if (down) { ws.close(); return; }
      open.push(ws);
      ws.connectToServer();
    });
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'hello before the outage');
    await expectIdle(page);

    down = true;
    for (const ws of open.splice(0)) ws.close(); // the server "goes away"
    await expect(page.getByRole('alert').filter({ hasText: /Connection lost|Connecting to the server/ })).toBeVisible();
    await sendPrompt(page, 'typed while offline');
    const item = page.locator('.queue-item.failed', { hasText: 'typed while offline' });
    await expect(item).toBeVisible();
    await expect(item).toContainText('Not sent');
    await expect(item.getByRole('button', { name: 'Retry' })).toBeVisible();
    // Retry while still offline keeps it (and does not lose the text)
    await item.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('.queue-item', { hasText: 'typed while offline' })).toBeVisible();

    down = false; // back online: the automatic reconnect re-sends it, nothing stays "queued" forever
    await expect(page.locator('.msg-user', { hasText: 'typed while offline' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.msg-assistant', { hasText: 'typed while offline' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.queue-item')).toHaveCount(0);
    await expectIdle(page);
  });
});
