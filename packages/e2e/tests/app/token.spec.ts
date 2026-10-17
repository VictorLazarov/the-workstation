import { expect, openApp, test, TOKEN } from '../../support/app.ts';

test.describe('token handling', () => {
  test('without a token the app is blocked and never reaches the server', async ({ page }) => {
    await openApp(page, { token: null });
    const banner = page.getByRole('alert').filter({ hasText: /Connecting to the server|access token|Connection lost/ });
    await expect(banner).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message Claude' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open project' })).toBeVisible();
    // Nothing that needs the token may be rendered.
    await expect(page.getByText('No projects yet.')).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('ws.token'))).toBeNull();
  });

  test('a wrong token is rejected and the access error is shown', async ({ page }) => {
    await openApp(page, { token: 'definitely-wrong-token-value' });
    await expect(page.getByRole('alert').filter({ hasText: /Connecting to the server|access token|Connection lost/ })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message Claude' })).toHaveCount(0);
  });

  test('BUG-001: a rejected token is named as an access problem, not an endless connecting state', async ({ page }) => {
    test.fail(true, 'BUG-001: wrong token shows "Connecting to the server…" forever; see BUGS.md');
    await openApp(page, { token: 'definitely-wrong-token-value' });
    await expect(page.getByRole('alert').filter({ hasText: /access token|token was rejected|Unauthorized/i })).toBeVisible({ timeout: 5_000 });
  });

  test('the token is moved out of the URL and kept in sessionStorage', async ({ page }) => {
    await openApp(page);
    await expect(page).toHaveURL((u) => !u.search.includes('token'));
    expect(page.url()).not.toContain(TOKEN);
    expect(await page.evaluate(() => sessionStorage.getItem('ws.token'))).toBe(TOKEN);
    await expect(page.getByRole('alert').filter({ hasText: 'Connecting to the server' })).toHaveCount(0);
  });

  test('the server refuses REST calls without the bearer token', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/api/sessions`);
    expect(res.status()).toBe(401);
    const ok = await request.get(`${baseURL}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(ok.status()).toBe(200);
  });
});
