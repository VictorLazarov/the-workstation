import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDrawers, composer, expect, expectIdle, newSessionInProject, sendPrompt, setAppearance, test, TOKEN } from '../../support/app.ts';
import { errorsOf, formatIssues, lintPage } from '../../support/layout-lint.ts';
import { startFakeGateway, type FakeGateway } from '../../support/fake-gateway.ts';
import { startPrivateServer } from '../../support/server.ts';

/**
 * First real third-party gateway: the mock agent talks to a tiny local fake gateway (WORKSTATION_MOCK_GATEWAY=1), which serves
 * GET /v1/models and rejects unknown models with the Anthropic not_found_error shape.
 */
const KEY = 'sk-e2e-gateway-key';
let gw: FakeGateway;
let srv: { base: string; stop: () => void };
let cwd: string;

test.beforeAll(async () => {
  gw = await startFakeGateway({ key: KEY, models: ['gw-fast', 'gw-smart'] });
  cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-e2e-gw-')));
  fs.writeFileSync(path.join(cwd, 'README.md'), '# gateway fixture\n');
  srv = await startPrivateServer({ cwd, env: { WORKSTATION_MOCK_GATEWAY: '1' } });
});
test.afterAll(async () => { srv?.stop(); await gw?.stop(); fs.rmSync(cwd, { recursive: true, force: true }); });

const put = (body: unknown) => fetch(`${srv.base}/api/config`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const getConfig = async () => (await fetch(`${srv.base}/api/config`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as Promise<{ env?: Record<string, string>; defaultModel?: string; anthropicBaseUrl?: string }>;
const settings = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: 'Settings' });

test('Settings: hint without a model, Test connection reports the provider text, discovered models are listed, aliases persist', async ({ page }) => {
  await put({ anthropicBaseUrl: '', apiKey: '', defaultModel: '', env: {} });
  await page.goto(`${srv.base}/?token=${TOKEN}`);
  await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings (Ctrl+,)' }).click();
  const dlg = settings(page);
  await expect(dlg).toBeVisible();
  // no base URL: nothing gateway-specific is offered
  await expect(dlg.getByRole('button', { name: 'Test connection' })).toHaveCount(0);
  await expect(dlg.getByText('Gateway model aliases')).toHaveCount(0);

  await dlg.getByLabel('Anthropic base URL').fill(gw.url);
  await dlg.getByLabel(/^API key/).fill(KEY);
  await expect(dlg.getByRole('note')).toContainText('A gateway usually needs an explicit model id');
  await expect(dlg.getByText('Gateway model aliases')).toBeVisible();

  // no model chosen: an honest refusal that still lists what the gateway serves
  await dlg.getByRole('button', { name: 'Test connection' }).click();
  await expect(dlg.locator('.gw-result')).toContainText('No model is chosen');
  await expect(dlg.locator('.gw-result')).toContainText('Gateway lists 2 models');
  const opts = await dlg.locator('#model-opts option').evaluateAll((os) => os.map((o) => [(o as HTMLOptionElement).value, o.textContent]));
  expect(opts.slice(0, 2)).toEqual([['gw-fast', 'gw-fast (from gateway)'], ['gw-smart', 'gw-smart (from gateway)']]);

  // an id the gateway does not serve: its own error text, nothing invented
  const model = dlg.getByLabel('Model', { exact: true });
  await model.fill('claude-sonnet-4-5');
  await dlg.getByRole('button', { name: 'Test connection' }).click();
  await expect(dlg.locator('.gw-result.bad')).toContainText('Failed. 404');
  await expect(dlg.locator('.gw-result')).toContainText('model: claude-sonnet-4-5');
  await expect(dlg.getByRole('note')).toHaveCount(0);

  await model.fill('gw-smart');
  await dlg.getByRole('button', { name: 'Test connection' }).click();
  await expect(dlg.locator('.gw-result.ok')).toContainText('Works. OK.');
  expect(gw.modelsAsked().at(-1)).toBe('gw-smart');

  // a wrong key shows the gateway's 401 text and the key is never echoed
  await dlg.getByLabel(/^API key/).fill('sk-wrong-key-000');
  await dlg.getByRole('button', { name: 'Test connection' }).click();
  await expect(dlg.locator('.gw-result.bad')).toContainText('invalid x-api-key');
  await expect(dlg).not.toContainText('sk-wrong-key-000');
  await dlg.getByLabel(/^API key/).fill(KEY);

  // alias mapping: Sonnet/Haiku/small-fast -> gateway ids, saved into the agent's env
  await dlg.getByLabel('Sonnet', { exact: true }).fill('gw-smart');
  await dlg.getByLabel('Haiku', { exact: true }).fill('gw-fast');
  await dlg.getByLabel('Small / fast', { exact: true }).fill('gw-fast');
  await dlg.getByLabel('Subagents', { exact: true }).fill('gw-fast');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  const cfg = await getConfig();
  expect(cfg.env).toEqual({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'gw-smart', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gw-fast', ANTHROPIC_SMALL_FAST_MODEL: 'gw-fast', CLAUDE_CODE_SUBAGENT_MODEL: 'gw-fast' });
  expect(cfg.defaultModel).toBe('gw-smart');

  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings (Ctrl+,)' }).click();
  await expect(dlg.getByLabel('Sonnet', { exact: true })).toHaveValue('gw-smart');
  await expect(dlg.getByLabel('Small / fast', { exact: true })).toHaveValue('gw-fast');
  await expect(dlg.getByLabel('Opus', { exact: true })).toHaveValue('');
  // clearing a mapping removes it
  await dlg.getByLabel('Haiku', { exact: true }).fill('');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  expect((await getConfig()).env).not.toHaveProperty('ANTHROPIC_DEFAULT_HAIKU_MODEL');
});

test('a model the gateway does not serve: the banner names it, the picker lists gateway models and one click fixes the turn', async ({ page }) => {
  await put({ anthropicBaseUrl: gw.url, apiKey: KEY, defaultModel: '', env: {} });
  await page.goto(`${srv.base}/?token=${TOKEN}`);
  await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
  await newSessionInProject(page);
  // the model chip lists the gateway's models, marked as such
  await page.locator('.chip-btn[title="Model"]').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /gw-smart/ })).toContainText('From gateway');
  await page.keyboard.press('Escape');

  await sendPrompt(page, 'hello gateway');
  const banner = page.locator('.banner.error');
  await expect(banner).toContainText('The provider does not know the model "claude-sonnet-4-5"');
  await expect(banner.getByRole('button', { name: 'Model settings' })).toBeVisible();
  await expect(page.locator('.banner.error')).toHaveCount(1);

  await banner.getByRole('button', { name: /Choose model/ }).click();
  const pick = page.getByRole('menu');
  await expect(pick.getByRole('menuitem', { name: /gw-fast/ })).toBeVisible();
  await pick.getByRole('menuitem', { name: /gw-smart/ }).click();
  await expect(page.locator('.msg-assistant').last()).toContainText('mock');
  await expectIdle(page);
  expect(gw.modelsAsked().slice(-1)).toEqual(['gw-smart']);
  await expect(page.locator('.chip-btn[title="Model"]')).toContainText('gw-smart');
  await expect(composer(page)).toBeEnabled();
});

test('"Model settings" in the banner opens Settings on the Model field', async ({ page }) => {
  await put({ anthropicBaseUrl: gw.url, apiKey: KEY, defaultModel: 'not-served-here', env: {} });
  await page.goto(`${srv.base}/?token=${TOKEN}`);
  await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
  await newSessionInProject(page);
  await sendPrompt(page, 'hello again');
  const banner = page.locator('.banner.error');
  await expect(banner).toContainText('"not-served-here"');
  await banner.getByRole('button', { name: 'Model settings' }).click();
  await expect(settings(page)).toBeVisible();
  await expect(settings(page).getByLabel('Model', { exact: true })).toBeFocused();
  await expect(settings(page).getByLabel('Model', { exact: true })).toHaveValue('not-served-here');
});

/** The new Settings fields (hint, test result incl. very long provider text, alias grid) and the banner picker, at 4 widths x both themes/brands/densities. */
const COMBOS = [
  { width: 1480, theme: 'light', brand: 'horizon', density: 'compact' },
  { width: 1100, theme: 'dark', brand: 'horizon', density: 'comfortable' },
  { width: 800, theme: 'light', brand: 'warm', density: 'compact' },
  { width: 560, theme: 'dark', brand: 'warm', density: 'comfortable' },
] as const;
for (const combo of COMBOS) {
  test(`layout lint: gateway Settings fields and model banner at ${combo.width} ${combo.theme} ${combo.brand} ${combo.density}`, async ({ page }) => {
    test.setTimeout(90_000);
    const failures: string[] = [];
    const check = async (state: string) => {
      await page.waitForTimeout(150);
      const errs = errorsOf(await lintPage(page, { brand: combo.brand }));
      if (errs.length) failures.push(`── ${state}\n${formatIssues(errs)}`);
    };
    await put({ anthropicBaseUrl: gw.url, apiKey: KEY, defaultModel: '', env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'gw-smart', ANTHROPIC_SMALL_FAST_MODEL: 'a-rather-long-gateway-model-identifier/with-provider-prefix-v1.2.3' } });
    await page.setViewportSize({ width: combo.width, height: 900 });
    await setAppearance(page, combo);
    await page.goto(`${srv.base}/?token=${TOKEN}`);
    await expect(page.locator('.topbar')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+,');
    const dlg = settings(page);
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('note')).toBeVisible();
    await check('settings: hint + aliases');
    await dlg.getByRole('button', { name: 'Test connection' }).click();
    await expect(dlg.locator('.gw-result')).toContainText('No model is chosen');
    await check('settings: no model result');
    await dlg.getByLabel('Model', { exact: true }).fill('m'.repeat(260));
    await dlg.getByRole('button', { name: 'Test connection' }).click();
    await expect(dlg.locator('.gw-result.bad')).toContainText('Failed. 404');
    await check('settings: very long provider error');
    const [sw, cw] = await page.locator('.dialog-body').evaluate((e) => [e.scrollWidth, e.clientWidth]);
    expect(sw, 'settings body scrolls sideways').toBeLessThanOrEqual(cw + 1);
    await dlg.getByLabel('Model', { exact: true }).fill('gw-smart');
    await dlg.getByRole('button', { name: 'Test connection' }).click();
    await expect(dlg.locator('.gw-result.ok')).toBeVisible();
    await check('settings: ok result');
    await page.keyboard.press('Escape');
    await closeDrawers(page);
    await newSessionInProject(page);
    await closeDrawers(page);
    await sendPrompt(page, 'banner layout check');
    await expect(page.locator('.banner.error')).toContainText('does not know the model');
    await check('model_not_found banner');
    await page.locator('.banner.error').getByRole('button', { name: /Choose model/ }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await check('model picker menu');
    await page.keyboard.press('Escape');
    expect(failures.join('\n\n')).toBe('');
  });
}
