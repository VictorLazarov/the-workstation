import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, openApp, test, TOKEN } from '../../support/app.ts';

/**
 * B1 (scrutiniser pass 1): the client must talk only to its own origin unless the user confirmed another server in
 * Settings, and must never send the same-origin token anywhere else. A "foreign" server records every request and
 * WebSocket upgrade it sees.
 */
interface Hit { kind: 'http' | 'upgrade'; url: string; auth: string }
async function foreignServer() {
  const hits: Hit[] = [];
  const srv = http.createServer((req, res) => {
    hits.push({ kind: 'http', url: req.url ?? '', auth: req.headers.authorization ?? '' });
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.end('{}');
  });
  srv.on('upgrade', (req, socket) => { hits.push({ kind: 'upgrade', url: req.url ?? '', auth: req.headers.authorization ?? '' }); socket.destroy(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { origin, hits, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

const settingsDialog = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: /^(Settings|Welcome\. Set up your connection)$/ });

test.describe('server origin (B1)', () => {
  test('?server= in the URL is ignored and never receives the token', async ({ page }) => {
    const foreign = await foreignServer();
    try {
      const browserHits: string[] = [];
      page.on('request', (r) => { if (r.url().startsWith(foreign.origin)) browserHits.push(r.url()); });
      page.on('websocket', (w) => { if (w.url().includes(new URL(foreign.origin).host)) browserHits.push(w.url()); });
      // 1) the victim follows an attacker link
      await page.goto(`/?server=${encodeURIComponent(foreign.origin)}`);
      await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
      await expect(page).toHaveURL((u) => !u.search.includes('server'));
      // 2) later, the victim opens the genuine tokenized URL
      await openApp(page);
      await page.waitForTimeout(1500);
      expect(await page.evaluate(() => [localStorage.getItem('ws.serverUrl'), localStorage.getItem('ws.remoteServer')])).toEqual([null, null]);
      expect(browserHits).toEqual([]);
      expect(foreign.hits).toEqual([]);
      await expect(page.getByRole('textbox', { name: 'Message Claude' }).or(page.getByRole('button', { name: 'New session', exact: true })).first()).toBeVisible();
    } finally { await foreign.close(); }
  });

  test('a server URL persisted by an old client (ws.serverUrl) is discarded on load', async ({ page }) => {
    const foreign = await foreignServer();
    try {
      await openApp(page);
      await page.evaluate((o) => localStorage.setItem('ws.serverUrl', o), foreign.origin);
      await openApp(page);
      await page.waitForTimeout(1500);
      expect(await page.evaluate(() => localStorage.getItem('ws.serverUrl'))).toBeNull();
      expect(foreign.hits).toEqual([]);
    } finally { await foreign.close(); }
  });

  test('another server needs an explicit confirm and receives only its own token, never this origin\'s', async ({ page }) => {
    const foreign = await foreignServer();
    try {
      await openApp(page);
      await page.getByRole('button', { name: 'Settings (Ctrl+,)' }).click();
      const dialog = settingsDialog(page);
      await dialog.getByLabel('Server URL').fill(foreign.origin);
      await dialog.getByLabel('Access token for that server').fill('remote-only-token');
      await dialog.getByRole('button', { name: 'Save' }).click();
      const confirm = page.getByRole('dialog', { name: 'Connect to a different server?' });
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(foreign.origin);
      await expect(confirm).toContainText(/access token.*API keys/);
      // Cancel: nothing is stored, nothing is sent.
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => localStorage.getItem('ws.remoteServer'))).toBeNull();
      expect(foreign.hits).toEqual([]);
      // Confirm: the page reloads against the other server with ITS token only.
      await dialog.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('dialog', { name: 'Connect to a different server?' }).getByRole('button', { name: /^Send token to / }).click();
      await expect.poll(() => foreign.hits.length, { timeout: 10_000 }).toBeGreaterThan(0);
      await page.waitForTimeout(1000);
      const all = JSON.stringify(foreign.hits);
      expect(all).not.toContain(TOKEN);
      expect(all).toContain('remote-only-token');
      // Opening the genuine tokenized URL of THIS origin switches back and forgets the remote server.
      const before = foreign.hits.length;
      await openApp(page);
      expect(await page.evaluate(() => localStorage.getItem('ws.remoteServer'))).toBeNull();
      await page.waitForTimeout(1000);
      expect(foreign.hits.length).toBe(before);
    } finally {
      await page.evaluate(() => localStorage.removeItem('ws.remoteServer')).catch(() => {});
      await foreign.close();
    }
  });
});
