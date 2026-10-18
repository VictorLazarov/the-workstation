import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, expectIdle, newSessionInProject, openApp, openInspector, sendPrompt, test, TOKEN } from '../../support/app.ts';
import { startPrivateServer } from '../../support/server.ts';
import { readState } from '../../support/env.ts';

const logs = (page: Page) => page.getByTestId('logs-view');
const rows = (page: Page) => logs(page).locator('.log-row');
const chip = (page: Page, name: string) => logs(page).getByRole('button', { name: new RegExp(`^${name}`) });

async function grantClipboard(page: Page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
}
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test.describe('Logs panel', () => {
  test('an error in the conversation links to its log entry; level and source are right', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'error please');
    await expectIdle(page);
    const banner = page.locator('.banner.error').last();
    await expect(banner).toContainText('Something went wrong');
    await banner.getByRole('button', { name: 'View details' }).click();

    await expect(logs(page)).toBeVisible();
    await expect(page.locator('.itab.on')).toHaveAttribute('data-panel', 'logs');
    // the entry the banner pointed at is open and highlighted
    const hit = rows(page).filter({ has: page.locator('.log-lvl.lv-error'), hasText: 'Turn ended with an error' });
    await expect(hit).toHaveCount(1);
    await expect(hit).toHaveAttribute('data-source', 'sdk');
    await expect(hit.locator('.log-head')).toHaveAttribute('aria-expanded', 'true');
    await expect(hit.locator('.log-json')).toContainText('error_during_execution');
    // filtered to this session by default
    await expect(page.getByRole('combobox', { name: 'Session' })).toHaveValue('__this');
  });

  test('401: retry warning, API error and the message shown to the user, with status and code', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'hit a 401 now');
    await expect(page.locator('.banner.error').first()).toBeVisible();
    // the banner links to the entry that says exactly what it said
    await page.locator('.banner.error').first().getByRole('button', { name: 'View details' }).click();
    const exact = rows(page).filter({ hasText: 'The API key was rejected (401)' });
    await expect(exact.locator('.log-head')).toHaveAttribute('aria-expanded', 'true');
    const warn = rows(page).filter({ hasText: 'API error 401: authentication_failed' });
    await expect(warn).toHaveCount(1);
    await expect(warn).toHaveAttribute('data-level', 'warn');
    await expect(warn).toHaveAttribute('data-source', 'sdk');
    await warn.locator('.log-head').click();
    await expect(warn.locator('.log-json')).toContainText('"status": 401');
    const shown = rows(page).filter({ hasText: 'The API key was rejected (401)' });
    await expect(shown).toHaveAttribute('data-source', 'session');
    await expect(shown).toHaveAttribute('data-level', 'error');
  });

  test('filters: level chips, source, session scope and search', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'error please');
    await expectIdle(page);
    await openInspector(page, 'logs');
    await expect(rows(page).first()).toBeVisible();

    // this session only: nothing from the server's own start-up
    await expect(rows(page).filter({ hasText: 'Server listening' })).toHaveCount(0);
    const mine = await rows(page).count();
    await page.getByRole('combobox', { name: 'Session' }).selectOption('all');
    await expect(rows(page).filter({ hasText: 'Server listening' })).toHaveCount(1);
    expect(await rows(page).count()).toBeGreaterThan(mine);
    await page.getByRole('combobox', { name: 'Session' }).selectOption('__this');
    await expect(rows(page).filter({ hasText: 'Server listening' })).toHaveCount(0);

    // level chips
    await chip(page, 'Info').click();
    await expect(chip(page, 'Info')).toHaveAttribute('aria-pressed', 'false');
    await expect(rows(page).locator('.log-lvl.lv-info')).toHaveCount(0);
    await expect(rows(page).locator('.log-lvl.lv-error')).not.toHaveCount(0);
    await chip(page, 'Errors').click();
    await chip(page, 'Warnings').click();
    await expect(logs(page)).toContainText('No entries match these filters');
    await logs(page).getByRole('button', { name: 'Reset filters' }).click();
    await expect(rows(page).first()).toBeVisible();
    await chip(page, 'Debug').click();
    await expect(rows(page).filter({ hasText: 'Turn finished' }).or(rows(page).filter({ hasText: 'Turn ended with an error' })).first()).toBeVisible();

    // source
    await page.getByRole('combobox', { name: 'Source' }).selectOption('sdk');
    const sources = await rows(page).evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLElement).dataset.source))]);
    expect(sources).toEqual(['sdk']);
    await page.getByRole('combobox', { name: 'Source' }).selectOption('all');

    // search (case-insensitive, also matches the detail JSON)
    await logs(page).getByRole('searchbox', { name: 'Search logs' }).fill('ERROR_DURING');
    await expect(rows(page).filter({ hasText: 'Turn ended with an error' })).toHaveCount(1);
    await expect(rows(page)).toHaveCount(1);
    await logs(page).getByRole('searchbox', { name: 'Search logs' }).fill('zzz-no-such-text');
    await expect(logs(page)).toContainText('No entries match these filters');
  });

  test('copy visible and download give redacted plain text of what is shown', async ({ page }) => {
    await grantClipboard(page);
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'error please');
    await expectIdle(page);
    await openInspector(page, 'logs');
    await expect(rows(page).filter({ hasText: 'Turn ended with an error' })).toHaveCount(1);
    await logs(page).getByRole('searchbox', { name: 'Search logs' }).fill('Turn ended with an error');

    await logs(page).getByRole('button', { name: 'Copy visible' }).click();
    await expect.poll(() => clipboard(page)).toContain('ERROR sdk');
    const copied = await clipboard(page);
    expect(copied).toContain('Turn ended with an error');
    expect(copied.split('\n').every((l) => /^\d{4}-\d\d-\d\dT/.test(l))).toBe(true);
    expect(copied).not.toContain(TOKEN);

    const [dl] = await Promise.all([page.waitForEvent('download'), logs(page).getByRole('button', { name: 'Download' }).click()]);
    expect(dl.suggestedFilename()).toMatch(/^workstation-logs-\d{8}-\d{6}\.log$/);
    const text = fs.readFileSync((await dl.path())!, 'utf8');
    expect(text).toContain('# The Workstation');
    expect(text).toContain('Turn ended with an error');
    expect(text).not.toContain(TOKEN);
  });

  test('a new error while another tab is open shows a red badge on the Logs tab until it is viewed', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await openInspector(page, 'overview');
    const badge = page.locator('.itab[data-panel="logs"] .itab-badge');
    await expect(badge).toHaveCount(0);
    await sendPrompt(page, 'error please');
    await expectIdle(page);
    await expect(badge).toHaveText(/^\d+$/);
    await expect(badge).toHaveCSS('background-color', /rgb\(/);
    await page.locator('.itab[data-panel="logs"]').click();
    await expect(logs(page)).toBeVisible();
    await expect(badge).toHaveCount(0);
    // while Logs is on screen, errors do not badge
    await sendPrompt(page, 'error again');
    await expect(rows(page).filter({ hasText: 'Turn ended with an error' })).toHaveCount(2);
    await page.locator('.itab[data-panel="overview"]').click();
    await expect(badge).toHaveCount(0);
  });

  test('the list follows new entries and offers "Jump to latest" once you scroll away', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'hello there'); // the draft becomes a real session (the panel remounts once); scroll behaviour is checked after that
    await expectIdle(page);
    await openInspector(page, 'logs');
    await page.getByRole('combobox', { name: 'Session' }).selectOption('all');
    await chip(page, 'Debug').click();
    const list = logs(page).locator('.logs-list');
    await expect.poll(() => list.evaluate((e) => e.scrollHeight > e.clientHeight + 100)).toBe(true);
    // at the tail
    await expect.poll(() => list.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight)).toBeLessThan(5);
    const jump = logs(page).getByRole('button', { name: 'Jump to latest' });
    await expect(jump).toHaveCount(0);
    await list.evaluate((e) => e.scrollTo(0, 0));
    await expect(jump).toBeVisible();
    // new entries arrive while scrolled up: the view stays put
    await sendPrompt(page, 'error please');
    await expectIdle(page);
    expect(await list.evaluate((e) => e.scrollTop)).toBeLessThan(5);
    await jump.click();
    await expect(jump).toHaveCount(0);
    await expect.poll(() => list.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight)).toBeLessThan(5);
    await expect(list.locator('.log-row').last()).toBeInViewport();
  });

  test('rows expand to show the detail as JSON; long lines wrap (no sideways scroll at 560px)', async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 800 });
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'error please');
    await expectIdle(page);
    await openInspector(page, 'logs');
    await page.getByRole('combobox', { name: 'Session' }).selectOption('all');
    const start = rows(page).filter({ hasText: 'Server listening' }).first();
    await start.locator('.log-head').click();
    await expect(start.locator('.log-json')).toContainText('"version"');
    await expect(start.locator('.log-facts')).toContainText('Time');
    const [sw, cw] = await logs(page).locator('.logs-list').evaluate((e) => [e.scrollWidth, e.clientWidth]);
    expect(sw).toBeLessThanOrEqual(cw + 1);
    // hover shows relative + absolute time
    await expect(start.locator('time.log-time')).toHaveAttribute('title', /ago.*\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}/);
  });
});

test.describe('opening the Logs', () => {
  test('from the command palette ("Open logs"), with or without a session', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('combobox', { name: 'Command palette' }).or(page.getByRole('textbox', { name: 'Command palette' })).fill('open logs');
    await page.getByRole('option', { name: /Open logs/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Logs' });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId('logs-view')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);

    await newSessionInProject(page);
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('textbox', { name: 'Command palette' }).fill('open logs');
    await page.getByRole('option', { name: /Open logs/ }).click();
    await expect(page.locator('.itab.on')).toHaveAttribute('data-panel', 'logs');
    await expect(logs(page)).toBeVisible();
  });

  test('from Settings ("View logs")', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('ControlOrMeta+,');
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'View logs' }).click();
    await expect(settings).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Logs' })).toBeVisible();
  });

  test('from an error toast ("View details")', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await page.evaluate(() => (window as unknown as { __ws: { toast: (t: unknown) => string } }).__ws.toast({ kind: 'error', title: 'Something failed', body: 'details are in the log' }));
    const toast = page.locator('.toast', { hasText: 'Something failed' });
    await toast.getByRole('button', { name: 'View details' }).click();
    await expect(page.locator('.itab.on')).toHaveAttribute('data-panel', 'logs');
    await expect(toast).toHaveCount(0);
  });

  test('the Overview card copies debug info for the session and opens the log', async ({ page }) => {
    await grantClipboard(page);
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'error please');
    await expectIdle(page);
    await openInspector(page, 'overview');
    const card = page.locator('[data-card="diagnostics"]');
    await card.getByRole('button', { name: 'Copy debug info' }).click();
    await expect(page.locator('.toast', { hasText: 'Debug info copied' })).toBeVisible();
    const text = await clipboard(page);
    expect(text).toContain('The Workstation debug info');
    expect(text).toMatch(/App version:\s+\S+/);
    expect(text).toMatch(/Platform:\s+\S+/);
    expect(text).toMatch(/Node:\s+v\d+/);
    expect(text).toMatch(/Agent SDK:\s+\d+/);
    expect(text).toContain('Base URL host:');
    expect(text).toMatch(/Permission mode:\s+\S+/);
    expect(text).toContain('Last ');
    expect(text).toContain('Turn ended with an error');
    expect(text).not.toContain(TOKEN);
    await card.getByRole('button', { name: 'View logs' }).click();
    await expect(logs(page)).toBeVisible();
  });
});

test.describe('secrets never show up', () => {
  test('with a fake API key configured, neither the panel, the copy, the download nor the REST answer contain it', async ({ page }) => {
    const KEY = 'e2e-fake-gateway-key-4815162342';
    const priv = await startPrivateServer({ cwd: readState().project });
    try {
      const put = await fetch(`${priv.base}/api/config`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: KEY, authToken: `${KEY}-token`, anthropicBaseUrl: `https://user:${KEY}@gw.example.com/v1?key=${KEY}` }) });
      expect(put.status).toBe(200);
      await grantClipboard(page);
      await page.addInitScript(() => { try { localStorage.setItem('ws.firstRunDone', '1'); } catch { /* */ } });
      await page.goto(`${priv.base}/?token=${TOKEN}`);
      await expect(page.locator('.topbar')).toBeVisible();
      await expect(page.getByRole('main').getByText('Connecting…')).toHaveCount(0);
      // text that echoes the key back: the server's "no live session <id>" error names the id it was sent, over a raw socket
      await page.evaluate(async ([key, token]) => {
        await new Promise<void>((resolve) => {
          const ws = new WebSocket(`ws://${location.host}/ws?token=${token}`);
          ws.onopen = () => ws.send(JSON.stringify({ type: 'interrupt', sessionId: key }));
          ws.onmessage = (m) => { if (JSON.parse(String(m.data)).type === 'error') { ws.close(); resolve(); } };
        });
      }, [KEY, TOKEN] as const);
      await newSessionInProject(page);
      await sendPrompt(page, `error please, my key is ${KEY}`);
      await expectIdle(page);
      await openInspector(page, 'logs');
      await page.getByRole('combobox', { name: 'Session' }).selectOption('all');
      const failed = rows(page).filter({ hasText: 'Request "interrupt" failed' }).first();
      await expect(failed).toBeVisible();
      await failed.locator('.log-head').click();
      await expect(failed).toContainText('[redacted]');
      await expect(rows(page).filter({ hasText: 'Config updated' }).first()).toBeVisible();

      // (the conversation shows the person's own prompt, key included: that is their text, not the log)
      const shown = await logs(page).innerText();
      expect(shown).not.toContain(KEY);
      expect(shown).not.toContain(TOKEN);
      expect(shown).not.toContain('user:');

      await logs(page).getByRole('button', { name: 'Copy visible' }).click();
      await expect.poll(() => clipboard(page)).toContain('Config updated');
      const copied = await clipboard(page);
      const [dl] = await Promise.all([page.waitForEvent('download'), logs(page).getByRole('button', { name: 'Download' }).click()]);
      const file = fs.readFileSync((await dl.path())!, 'utf8');
      const rest = await (await fetch(`${priv.base}/api/logs?limit=5000`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
      const debug = await (await fetch(`${priv.base}/api/logs/debug-info`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
      for (const [where, out] of Object.entries({ copied, file, rest, debug })) {
        for (const secret of [KEY, TOKEN, 'user:' + KEY]) expect(out, `${where} contains ${secret}`).not.toContain(secret);
      }
      expect(file).toContain('gw.example.com'); // the host is fine, the credentials are not
      expect(file).toContain('[redacted]');
    } finally { priv.stop(); }
  });

  test('every log endpoint refuses a request without the token', async ({ request }) => {
    const base = readState().mainUrl;
    for (const [method, path] of [['GET', '/api/logs'], ['GET', '/api/logs/download'], ['POST', '/api/logs/clear'], ['GET', '/api/logs/debug-info']] as const) {
      const res = await request.fetch(base + path, { method });
      expect(res.status(), `${method} ${path}`).toBe(401);
      const wrong = await request.fetch(base + path, { method, headers: { authorization: 'Bearer nope' } });
      expect(wrong.status(), `${method} ${path} wrong token`).toBe(401);
    }
  });
});
