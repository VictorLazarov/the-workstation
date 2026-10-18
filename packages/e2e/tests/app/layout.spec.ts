import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { closeDrawers, composer, expect, expectIdle, newSessionInProject, openApp, openInspector, openSidebar, sendPrompt, setAppearance, test } from '../../support/app.ts';
import { readState } from '../../support/env.ts';
import { errorsOf, formatIssues, lintPage } from '../../support/layout-lint.ts';

/**
 * Layout lint (scrutiniser pass 2): every key UI state is checked for overlap, touching controls, horizontal overflow,
 * clipped / spilling text, hit targets under 24px, AA contrast, forbidden (orange) hues in the Horizon brand, controls
 * without an accessible name, and console errors. Zero errors are allowed.
 *
 * Matrix (a full cross product would take too long):
 *  - the main conversation state at ALL widths x BOTH themes (horizon, compact)
 *  - every state (each mock scenario, pending permissions, each inspector tab, dialogs, menus) at four sampled
 *    combinations that together cover both themes, both brands, both densities and all four widths
 */
type Theme = 'light' | 'dark'; type Brand = 'horizon' | 'warm'; type Density = 'compact' | 'comfortable';
interface Combo { width: number; theme: Theme; brand: Brand; density: Density }
const tag = (c: Combo) => `${c.width} ${c.theme} ${c.brand} ${c.density}`;

/** Console errors, page errors and failed requests are test failures too. */
function watch(page: Page): string[] {
  const log: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') log.push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => log.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => log.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/fonts/')) log.push(`http ${r.status()}: ${r.url()}`); });
  return log;
}

class Linter {
  failures: string[] = [];
  count = 0;
  constructor(private page: Page, private combo: Combo) {}
  async check(state: string) {
    await this.page.waitForTimeout(120); // let transitions / animations settle
    const issues = await lintPage(this.page, { brand: this.combo.brand });
    const errs = errorsOf(issues);
    this.count++;
    if (errs.length) this.failures.push(`── ${state} @ ${tag(this.combo)}\n${formatIssues(errs)}`);
  }
}

async function boot(page: Page, combo: Combo) {
  await page.setViewportSize({ width: combo.width, height: 900 });
  await setAppearance(page, combo);
  const log = watch(page);
  await openApp(page);
  return { log, lint: new Linter(page, combo) };
}

const allowAll = async (page: Page) => {
  for (let i = 0; i < 30; i++) {
    const a = page.locator('[data-perm-allow]').first();
    if (await a.isVisible().catch(() => false)) await a.click();
    else if (!(await page.locator('.working, .composer .send.stop').count())) break;
    await page.waitForTimeout(80);
  }
  await expectIdle(page);
};

/** Prompts the mock agent and leaves a pending permission / question on screen (or the finished turn when `settle`). */
async function scenario(page: Page, prompt: string, settle: 'pending' | 'idle') {
  await sendPrompt(page, prompt);
  if (settle === 'pending') await expect(page.locator('.tool.st-waiting, .tool-plan, .tool-ask').first()).toBeVisible();
  else await allowAll(page);
}

const mainState = async (page: Page, lint: Linter) => {
  await newSessionInProject(page);
  await sendPrompt(page, 'demo everything');
  await allowAll(page);
  await expect(page.getByText('Everything is done')).toBeVisible();
  await closeDrawers(page);
  await lint.check('conversation (demo everything)');
  await page.locator('.conv-scroll').evaluate((e) => e.scrollTo(0, 0));
  await lint.check('conversation top');
  // S4 minor: a long unbreakable token (URL, hash) in prose wraps instead of scrolling the conversation sideways
  await sendPrompt(page, `token ${'abcdef0123456789'.repeat(11)}`);
  await expectIdle(page);
  await expect(page.locator('.msg-assistant').last()).toContainText('abcdef0123456789');
  await lint.check('long token in prose');
  const [csw, ccw] = await page.locator('.conv-scroll').evaluate((e) => [e.scrollWidth, e.clientWidth]);
  expect(csw, 'conversation scrolls sideways').toBeLessThanOrEqual(ccw + 1);
};

test.describe('layout lint: main conversation at every width, both themes', () => {
  for (const width of [1480, 1100, 800, 560]) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${width}px ${theme}`, async ({ page }) => {
        const combo: Combo = { width, theme, brand: 'horizon', density: 'compact' };
        const { log, lint } = await boot(page, combo);
        await lint.check('home');
        await mainState(page, lint);
        await openInspector(page, 'overview');
        await lint.check('conversation + inspector overview');
        expect(lint.failures.join('\n\n')).toBe('');
        expect(log).toEqual([]);
      });
    }
  }
});

const SAMPLED: Combo[] = [
  { width: 1480, theme: 'light', brand: 'horizon', density: 'compact' },
  { width: 1100, theme: 'dark', brand: 'horizon', density: 'comfortable' },
  { width: 800, theme: 'light', brand: 'warm', density: 'compact' },
  { width: 560, theme: 'dark', brand: 'warm', density: 'comfortable' },
];

test.describe('layout lint: every state at sampled combinations', () => {
  test.describe.configure({ timeout: 120_000 });
  for (const combo of SAMPLED) {
    test(`scenarios, pending permissions, inspector tabs, dialogs: ${tag(combo)}`, async ({ page }) => {
      const { log, lint } = await boot(page, combo);
      await lint.check('home');
      await newSessionInProject(page);
      await closeDrawers(page);
      await lint.check('draft session');
      await scenario(page, 'error please', 'idle');
      await lint.check('error result');
      await newSessionInProject(page);
      await closeDrawers(page);
      await scenario(page, 'hello there', 'idle');
      await lint.check('plain reply');

      for (const [prompt, name] of [['bash please', 'bash'], ['edit please', 'edit'], ['write please', 'write'], ['web please', 'web']] as const) {
        await scenario(page, prompt, 'pending');
        await lint.check(`${name}: permission pending`);
        await allowAll(page);
        await lint.check(`${name}: done`);
      }
      await scenario(page, 'todo list please', 'idle');
      await lint.check('todo');
      await scenario(page, 'task please', 'idle');
      await lint.check('subagent task');
      await scenario(page, 'ask me something', 'pending');
      await lint.check('question pending');
      await page.getByRole('button', { name: 'Skip' }).click();
      await expectIdle(page);
      await scenario(page, 'make a plan', 'pending');
      await lint.check('plan pending');
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await lint.check('plan editing');
      await page.getByRole('button', { name: 'Keep planning…' }).click();
      await page.getByRole('button', { name: 'Send feedback' }).click();
      await expectIdle(page);
      // composer menus and popups
      for (const [i, name] of ['mode', 'model', 'effort'].entries()) {
        await page.locator('.composer-chips .chip-btn').nth(i).click();
        await lint.check(`${name} menu open`);
        await page.keyboard.press('Escape');
      }
      await composer(page).fill('/');
      await expect(page.getByRole('listbox', { name: 'Commands' })).toBeVisible();
      await lint.check('slash popup');
      await composer(page).fill('');
      await openSidebar(page);
      await page.getByRole('button', { name: 'Appearance' }).click();
      await lint.check('appearance popover');
      await page.keyboard.press('Escape');
      await closeDrawers(page);

      // every inspector tab
      await openInspector(page);
      for (const id of await page.locator('.itab').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.panel!))) {
        await page.locator(`.itab[data-panel="${id}"]`).click();
        await page.waitForTimeout(250);
        await lint.check(`inspector: ${id}`);
      }
      await page.locator('.itab[data-panel="changes"]').click();
      await lint.check('inspector: changes (unified)');
      await page.locator('.itab[data-panel="overview"]').click();

      // dialogs
      await closeDrawers(page);
      await page.keyboard.press('ControlOrMeta+,');
      await expect(page.getByRole('dialog')).toBeVisible();
      await lint.check('settings');
      await page.keyboard.press('Escape');
      // S4 M2: a very long remembered rule (what "Always allow" writes after a long command) must not break the dialog
      const rulesFile = path.join(readState().project, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
      fs.writeFileSync(rulesFile, JSON.stringify({ permissions: { allow: [`Bash(git commit -m "${'a really long message '.repeat(20)}":*)`, `Bash(${'x'.repeat(300)})`, 'Bash(ls:*)'] } }));
      try {
        await page.keyboard.press('ControlOrMeta+,');
        await expect(page.getByTestId('remembered-rules')).toContainText('git commit -m');
        await lint.check('settings with very long rules');
        const [sw, cw] = await page.locator('.dialog-body').evaluate((e) => [e.scrollWidth, e.clientWidth]);
        expect(sw, 'settings body scrolls sideways').toBeLessThanOrEqual(cw + 1);
        await page.keyboard.press('Escape');
      } finally { fs.rmSync(path.dirname(rulesFile), { recursive: true, force: true }); }
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
      await lint.check('command palette');
      await page.keyboard.press('Escape');
      await page.keyboard.press('ControlOrMeta+/');
      await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
      await lint.check('shortcuts');
      await page.keyboard.press('Escape');
      await page.locator('.msg-user').first().hover();
      await page.getByRole('button', { name: 'Rewind…' }).first().click();
      await page.getByRole('menuitem', { name: /^Restore code(?! and)/ }).click();
      await expect(page.getByRole('dialog', { name: 'Restore files to before this message?' })).toBeVisible();
      await lint.check('rewind dialog');
      await page.keyboard.press('Escape');
      await openSidebar(page);
      await page.getByRole('button', { name: 'Open project' }).click();
      await expect(page.getByRole('dialog', { name: 'Open a project' })).toBeVisible();
      await lint.check('project picker');
      await page.keyboard.press('Escape');

      expect(lint.count).toBeGreaterThan(30);
      expect(lint.failures.join('\n\n')).toBe('');
      expect(log).toEqual([]);
    });
  }
});
