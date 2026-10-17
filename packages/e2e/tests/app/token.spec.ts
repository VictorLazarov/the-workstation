import { expect, openApp, test, TOKEN } from '../../support/app.ts';

test.describe('token handling', () => {
  test('without a token the app shows the access screen and never contacts the server', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => { if (/\/(api|ws)\b/.test(new URL(r.url()).pathname)) requests.push(r.url()); });
    page.on('websocket', (ws) => requests.push(ws.url()));
    await openApp(page, { token: null });
    await expect(page.getByRole('heading', { name: 'Access token missing or invalid' })).toBeVisible();
    await expect(page.getByText(/opened without an access token/)).toBeVisible();
    await expect(page.getByText(/Open the link it printed/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    // nothing that needs the token is rendered, and no "Connecting…" spinner pretends otherwise
    await expect(page.getByRole('textbox', { name: 'Message Claude' })).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toHaveCount(0);
    await expect(page.getByText(/Connecting/)).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('ws.token'))).toBeNull();
    await page.waitForTimeout(1_000);
    expect(requests).toEqual([]);
  });

  test('a wrong token is detected through /api/health: clear screen, a Retry button, and the retrying stops', async ({ page }) => {
    const sockets: string[] = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));
    await openApp(page, { token: 'definitely-wrong-token-value' });
    await expect(page.getByRole('heading', { name: 'Access token missing or invalid' })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/did not accept the access token/)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message Claude' })).toHaveCount(0);
    await expect(page.getByText(/Connecting to the server/)).toHaveCount(0);
    // BUG-001: it used to retry the WebSocket forever. Now it stops after the token was refused.
    const settled = sockets.length;
    await page.waitForTimeout(4_000);
    expect(sockets.length).toBe(settled);
    expect(settled).toBeLessThanOrEqual(2);
    // Retry re-checks the token, which is still wrong
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('heading', { name: 'Access token missing or invalid' })).toBeVisible();
  });

  test('the token is moved out of the URL and kept in sessionStorage', async ({ page }) => {
    await openApp(page);
    await expect(page).toHaveURL((u) => !u.search.includes('token'));
    expect(page.url()).not.toContain(TOKEN);
    expect(await page.evaluate(() => sessionStorage.getItem('ws.token'))).toBe(TOKEN);
    await expect(page.getByRole('alert').filter({ hasText: 'Connecting to the server' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Access token missing or invalid' })).toHaveCount(0);
  });

  test('the server refuses REST calls without the bearer token', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/api/sessions`);
    expect(res.status()).toBe(401);
    const ok = await request.get(`${baseURL}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(ok.status()).toBe(200);
  });
});
