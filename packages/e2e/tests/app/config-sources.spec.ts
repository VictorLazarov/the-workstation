import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { closeDrawers, expect, expectIdle, newSessionInProject, openApp, openInspector, sendPrompt, setAppearance, test, TOKEN } from '../../support/app.ts';
import { errorsOf, formatIssues, lintPage } from '../../support/layout-lint.ts';
import { startPrivateServer } from '../../support/server.ts';

/**
 * Config sources (Settings) and the Loaded configuration card. Everything runs on a private mock server whose "user Claude dir"
 * (CLAUDE_CONFIG_DIR) and project are throwaway fixtures: the real ~/.claude is never touched. The mock agent reads those files
 * like the CLI would, so toggling a source really changes what a NEW session loads.
 */
const put = (f: string, body: string | object) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body)); };

function makeFixtures() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-e2e-src-')));
  const userDir = path.join(base, 'claude-user');
  const project = path.join(base, 'project');
  put(path.join(userDir, 'CLAUDE.md'), '# my private memory\nSECRET-USER-MEMORY-BODY\n');
  put(path.join(userDir, 'skills', 'commit-helper', 'SKILL.md'), '---\nname: commit-helper\n---\nhelp');
  put(path.join(userDir, 'commands', 'standup.md'), 'standup');
  put(path.join(userDir, 'agents', 'reviewer.md'), 'review');
  put(path.join(userDir, 'settings.json'), { permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 audit-log --quiet' }] }] } });
  put(path.join(userDir, 'plugins', 'acme-tools', '.claude-plugin', 'plugin.json'), { name: 'acme-tools', version: '1.2.0' });
  put(path.join(userDir, 'plugins', 'acme-tools', 'hooks', 'hooks.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/hello' }] }] } });
  put(path.join(project, 'README.md'), '# p\n');
  put(path.join(project, 'CLAUDE.md'), 'project memory SECRET-PROJECT-MEMORY-BODY');
  put(path.join(project, 'CLAUDE.local.md'), 'local memory');
  put(path.join(project, '.claude', 'commands', 'ship.md'), 'ship');
  put(path.join(project, '.claude', 'skills', 'release-notes', 'SKILL.md'), 'notes');
  put(path.join(project, '.claude', 'settings.json'), { permissions: { allow: ['Bash(npm test:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: './scripts/after-turn.sh' }] }] } });
  put(path.join(project, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(git status)'] }, hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'prettier --write "$CLAUDE_FILE"' }] }] } });
  return { base, userDir, project };
}

const settingsDialog = (page: Page) => page.getByRole('dialog', { name: 'Settings' });
const sw = (page: Page, source: string) => page.locator(`[data-source="${source}"] [role=switch]`);
async function openSettings(page: Page) {
  await page.keyboard.press('ControlOrMeta+,');
  await expect(settingsDialog(page)).toBeVisible();
  await expect(page.getByTestId('config-sources')).toBeVisible();
}
async function saveSettings(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settingsDialog(page)).toHaveCount(0);
}
const configOf = async (base: string) => (await (await fetch(`${base}/api/config`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { settingSources?: string[] };
const group = (page: Page, origin: string) => page.getByTestId('loaded-config').locator(`[data-origin="${origin}"]`);

async function startFirstSession(page: Page) {
  await newSessionInProject(page);
  await sendPrompt(page, 'hello there');
  await expectIdle(page);
  await closeDrawers(page);
}

test.describe('config sources', () => {
  test.describe.configure({ mode: 'serial' });
  let fx: ReturnType<typeof makeFixtures>;
  let srv: Awaited<ReturnType<typeof startPrivateServer>>;
  test.beforeAll(async () => { fx = makeFixtures(); srv = await startPrivateServer({ cwd: fx.project, env: { CLAUDE_CONFIG_DIR: fx.userDir } }); });
  test.afterAll(() => { srv?.stop(); if (fx) fs.rmSync(fx.base, { recursive: true, force: true }); });

  test('Settings: three toggles, all on by default, honest copy; the choice persists across a reload', async ({ page }) => {
    await page.goto(`${srv.base}/?token=${TOKEN}`);
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
    await openSettings(page);
    for (const id of ['user', 'project', 'local']) await expect(sw(page, id)).toHaveAttribute('aria-checked', 'true');
    const section = page.getByTestId('config-sources');
    await expect(section).toContainText('Applies to new sessions');
    await expect(section.locator('[data-source="user"]')).toContainText('Hooks in your settings run commands as you');
    await expect(section.locator('[data-source="project"]')).toContainText('hooks');
    await expect(section.locator('[data-source="local"]')).toContainText('Always allow');
    await expect(page.getByTestId('local-off-note')).toHaveCount(0);

    await sw(page, 'local').click();
    await expect(sw(page, 'local')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('local-off-note')).toContainText('Always allow');
    await expect(page.getByTestId('local-off-note')).toContainText('current session only');
    await saveSettings(page);
    expect((await configOf(srv.base)).settingSources).toEqual(['user', 'project']);

    await page.reload();
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
    await openSettings(page);
    await expect(sw(page, 'user')).toHaveAttribute('aria-checked', 'true');
    await expect(sw(page, 'project')).toHaveAttribute('aria-checked', 'true');
    await expect(sw(page, 'local')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('local-off-note')).toBeVisible();
    // cancelling leaves the saved value alone
    await sw(page, 'user').click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect((await configOf(srv.base)).settingSources).toEqual(['user', 'project']);

    // back to the default: the server stores nothing for "all three"
    await openSettings(page);
    await sw(page, 'local').click();
    await saveSettings(page);
    expect((await configOf(srv.base)).settingSources).toBeUndefined();
  });

  test('the card lists what was loaded by origin; hooks warn; bodies and secrets never show', async ({ page }) => {
    await page.goto(`${srv.base}/?token=${TOKEN}`);
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
    await startFirstSession(page);
    await openInspector(page, 'overview');
    const card = page.getByTestId('loaded-config');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('lc-sources')).toContainText('fixed at session start');

    const user = group(page, 'user');
    await expect(user).toContainText('CLAUDE.md');
    await expect(user.locator('[data-kind=skill]')).toContainText('commit-helper');
    await expect(user.locator('[data-kind=command]')).toContainText('standup');
    await expect(user.locator('[data-kind=agent]')).toContainText('reviewer');
    await expect(user.locator('[data-kind=hook]')).toContainText('PreToolUse · Bash');
    await expect(user.locator('[data-kind=hook]')).toContainText('audit-log --quiet');
    const project = group(page, 'project');
    await expect(project.locator('[data-kind=memory]')).toContainText('CLAUDE.md');
    await expect(project.locator('[data-kind=skill]')).toContainText('release-notes');
    await expect(project.locator('[data-kind=command]')).toContainText('ship');
    await expect(project.locator('[data-kind=hook]')).toContainText('Stop');
    const local = group(page, 'local');
    await expect(local.locator('[data-kind=memory]')).toContainText('CLAUDE.local.md');
    await expect(local.locator('[data-kind=hook]')).toContainText('PostToolUse · Edit|Write');
    const plugin = group(page, 'plugin');
    await expect(plugin).toContainText('acme-tools');
    await expect(plugin).toContainText('1.2.0');
    await expect(plugin.locator('[data-kind=hook]')).toContainText('SessionStart');
    await expect(group(page, 'builtin')).toContainText('commands');
    await expect(page.getByTestId('lc-rules')).toContainText('1 user');
    await expect(page.getByTestId('lc-rules')).toContainText('1 project');
    await expect(page.getByTestId('lc-rules')).toContainText('1 local');

    const text = (await card.innerText()) + (await card.innerHTML());
    expect(text).not.toContain('SECRET-USER-MEMORY-BODY');
    expect(text).not.toContain('SECRET-PROJECT-MEMORY-BODY');
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');

    const badge = page.getByTestId('lc-hooks-badge');
    await expect(badge).toContainText('Hooks run commands on your machine');
    await badge.getByRole('button', { name: 'Change in Settings' }).click();
    await expect(settingsDialog(page)).toBeVisible();
    await expect(sw(page, 'user')).toBeFocused();
    await page.keyboard.press('Escape');
  });

  test('changing the sources applies to new sessions; an open session keeps its own and says so', async ({ page }) => {
    await page.goto(`${srv.base}/?token=${TOKEN}`);
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
    await startFirstSession(page);
    await openSettings(page);
    await sw(page, 'user').click();
    await sw(page, 'local').click();
    await saveSettings(page);
    expect((await configOf(srv.base)).settingSources).toEqual(['project']);

    // the open session is unchanged, and the card explains the difference
    await openInspector(page, 'overview');
    await expect(page.getByTestId('lc-differs')).toContainText('applies to new sessions');
    await expect(group(page, 'user').locator('[data-kind=memory]')).toHaveCount(1);
    await closeDrawers(page);

    // a new session follows the new value
    await newSessionInProject(page);
    await sendPrompt(page, 'hello again');
    await expectIdle(page);
    await openInspector(page, 'overview');
    await expect(page.getByTestId('lc-sources')).toContainText('User off');
    await expect(page.getByTestId('lc-sources')).toContainText('Local off');
    await expect(group(page, 'user')).toContainText('off for this session');
    await expect(group(page, 'user').locator('[data-kind=memory]')).toHaveCount(0);
    await expect(group(page, 'local').locator('[data-kind=memory]')).toHaveCount(0);
    await expect(group(page, 'project').locator('[data-kind=memory]')).toHaveCount(1);
    await expect(page.getByTestId('lc-differs')).toHaveCount(0);
    await expect(page.getByTestId('lc-rules')).toContainText('1 project');
    await expect(page.getByTestId('lc-rules')).not.toContainText('user');
    // the Context tab shows the same fixed value
    await page.locator('.itab[data-panel="context"]').click();
    await expect(page.getByText('Config sources', { exact: true })).toBeVisible();

    // Remembered permissions: the rule saved in the (now off) Local source is listed as not applied
    await closeDrawers(page);
    await openSettings(page);
    await expect(page.getByTestId('ignored-rules').filter({ hasText: 'local source' })).toContainText('not applied');
    await expect(page.getByTestId('ignored-rules').filter({ hasText: 'user source' })).toContainText('not applied');
    await page.keyboard.press('Escape');
  });

  test('with Local off "Always allow" becomes "Allow for this session" and writes no rule', async ({ page }) => {
    const rulesFile = path.join(fx.project, '.claude', 'settings.local.json');
    const before = fs.readFileSync(rulesFile, 'utf8');
    await page.goto(`${srv.base}/?token=${TOKEN}`);
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
    expect((await configOf(srv.base)).settingSources).toEqual(['project']);
    await newSessionInProject(page);
    await sendPrompt(page, 'bash');
    await expect(page.getByTestId('allow-session')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Always allow' })).toHaveCount(0);
    await page.getByTestId('allow-session').click();
    await expectIdle(page);
    expect(fs.readFileSync(rulesFile, 'utf8')).toBe(before);

    // Local back on: a NEW session offers Always allow again
    await openSettings(page);
    await sw(page, 'local').click();
    await saveSettings(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'bash');
    await expect(page.getByRole('button', { name: 'Always allow' })).toBeVisible();
    await expect(page.getByTestId('allow-session')).toHaveCount(0);
    await page.getByRole('button', { name: 'Allow once' }).click();
    await expectIdle(page);
    // restore the default for whatever runs next
    await openSettings(page);
    await sw(page, 'user').click();
    await saveSettings(page);
    expect((await configOf(srv.base)).settingSources).toBeUndefined();
  });
});

test.describe('layout lint: Config sources and Loaded configuration', () => {
  test.describe.configure({ timeout: 90_000, mode: 'serial' });
  let fx: ReturnType<typeof makeFixtures>;
  let srv: Awaited<ReturnType<typeof startPrivateServer>>;
  test.beforeAll(async () => { fx = makeFixtures(); srv = await startPrivateServer({ cwd: fx.project, env: { CLAUDE_CONFIG_DIR: fx.userDir } }); });
  test.afterAll(() => { srv?.stop(); if (fx) fs.rmSync(fx.base, { recursive: true, force: true }); });

  for (const width of [1480, 1100, 800, 560]) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${width}px ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await setAppearance(page, { theme, brand: 'horizon', density: 'compact' });
        const log: string[] = [];
        page.on('console', (m) => { if (m.type() === 'error') log.push(`console.error: ${m.text()}`); });
        page.on('pageerror', (e) => log.push(`pageerror: ${e.message}`));
        const fails: string[] = [];
        const check = async (state: string) => {
          await page.waitForTimeout(150);
          const errs = errorsOf(await lintPage(page, { brand: 'horizon' }));
          if (errs.length) fails.push(`── ${state} @ ${width} ${theme}\n${formatIssues(errs)}`);
        };
        await page.goto(`${srv.base}/?token=${TOKEN}`);
        await expect(page.locator('.topbar')).toBeVisible();
        await startFirstSession(page);
        await openInspector(page, 'overview');
        await expect(page.getByTestId('lc-hooks-badge')).toBeVisible();
        await check('overview with the loaded configuration card');
        const [sw0, cw0] = await page.getByRole('complementary', { name: 'Inspector' }).locator('.panel-body, .ov').first().evaluate((e) => [e.scrollWidth, e.clientWidth]).catch(() => [0, 0]);
        expect(sw0, 'overview scrolls sideways').toBeLessThanOrEqual(cw0 + 1);
        await page.locator('.itab[data-panel="context"]').click();
        await check('context tab with config sources');
        await closeDrawers(page);
        await openSettings(page);
        await sw(page, 'local').click();
        await expect(page.getByTestId('local-off-note')).toBeVisible();
        await check('settings: config sources, Local off');
        await sw(page, 'user').click();
        await sw(page, 'project').click();
        await check('settings: config sources, all off');
        await page.keyboard.press('Escape');
        expect(fails.join('\n\n')).toBe('');
        expect(log).toEqual([]);
      });
    }
  }
});
