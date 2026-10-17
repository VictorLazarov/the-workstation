import { closeDrawers, composer, expect, expectIdle, newSessionInProject, openApp, openInspector, openSidebar, sendPrompt, test, TOKEN } from '../../support/app.ts';
import type { Page } from '@playwright/test';

/** Regression tests for the majors and minors of scrutiniser pass 2 (docs/reviews/2026-10-scrutiniser-2-visual.md). */

test.describe('M1: plan editing', () => {
  test('Edit opens the final plan, an empty plan cannot be approved, an edited one can', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'make a plan');
    await expect(page.getByRole('button', { name: 'Approve plan', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const area = page.getByRole('textbox', { name: 'Edit plan' });
    await expect(area).toHaveValue(/Add `farewell` export to `src\/example.ts`/);
    await area.fill('  \n ');
    await expect(page.getByRole('button', { name: 'Approve edited plan' })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Approve & auto-accept edits/ })).toBeDisabled();
    await expect(page.getByText(/The plan is empty/)).toBeVisible();
    await area.fill('## Plan\n\n1. Only the edited step');
    await page.getByRole('button', { name: 'Approve edited plan' }).click();
    await expectIdle(page);
    await expect(page.getByText('Plan approved, starting work.')).toBeVisible();
  });
});

test.describe('M3: rewind dialog is honest', () => {
  test('says that Bash changes are not restored and lists what the dry run will restore', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'edit please');
    await page.locator('[data-perm-allow]').click();
    await expectIdle(page);
    await page.locator('.msg-user').first().hover();
    await page.getByRole('button', { name: 'Rewind files to here' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Rewind files to this message?' });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText(/not restored/i);
    await expect(dlg).toContainText(/Bash/);
    await expect(dlg).toContainText(/subagents/i);
    await expect(dlg.locator('.dlg-summary')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
  });
});

test.describe('M4: one live checklist', () => {
  test('several TodoWrite calls produce ONE plan card; earlier snapshots are quiet one-line steps', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'todo list please');
    await expectIdle(page);
    await expect(page.locator('.tool-todo')).toHaveCount(1);
    await expect(page.locator('.tool-todo-step')).toHaveCount(2);
    await expect(page.locator('.tool-todo-step').first()).toContainText('Updated plan');
    await expect(page.locator('.tool-todo .todos li')).toHaveCount(3);
    await expect(page.locator('.todos .spinner')).toHaveCount(0);
  });
});

test.describe('M5: the open session is the selected one, attention is only a dot and a label', () => {
  test('a waiting session row has no fill or bar; the open row does', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'bash please');
    await expect(page.locator('[data-perm-allow]')).toBeVisible();
    await newSessionInProject(page); // the first session now waits in the background
    const waiting = page.locator('.sess.attn').first();
    const open = page.locator('.sess.active');
    await expect(waiting).toBeVisible();
    await expect(waiting).toContainText('Needs input');
    const style = (l: ReturnType<Page['locator']>) => l.evaluate((e) => { const c = getComputedStyle(e); return { bg: c.backgroundColor, shadow: c.boxShadow, before: getComputedStyle(e, '::before').content }; });
    const w = await style(waiting), o = await style(open);
    expect(w.bg).toBe('rgba(0, 0, 0, 0)');
    expect(w.shadow).toBe('none');
    expect(w.before === 'none' || w.before === 'normal').toBe(true);
    expect(o.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(o.shadow).not.toBe('none');
  });
});

test.describe('M6: one branch everywhere', () => {
  test('topbar, Overview > Environment and Changes show the same git branch, also after a reload', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'hello branch');
    await expectIdle(page);
    const topbar = page.locator('.topbar .crumb.branch');
    await expect(topbar).toHaveText('develop'); // the checkout's real branch; the mock's session metadata says "main"
    await openInspector(page, 'overview');
    await expect(page.locator('[data-card="env"] .ov-row', { hasText: 'Branch' })).toContainText('develop');
    await openInspector(page, 'changes');
    await expect(page.locator('.chip-branch')).toHaveText('develop');
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Message Claude' })).toBeVisible({ timeout: 15_000 }); // the open session is restored
    await expect(page.locator('.topbar .crumb.branch')).toHaveText('develop');
    await expect(page.locator('.topbar .crumb.branch')).not.toHaveText('main');
  });
});

test.describe('M7: split diff', () => {
  test('falls back to unified in a narrow inspector; when wide both panes are populated, aligned and scroll together', async ({ page }) => {
    await page.setViewportSize({ width: 1480, height: 900 });
    await openApp(page);
    await newSessionInProject(page);
    await openInspector(page, 'changes');
    const split = page.getByRole('radio', { name: 'Split' });
    await expect(split).toBeDisabled();
    await expect(page.getByRole('radio', { name: 'Unified' })).toHaveAttribute('aria-checked', 'true');
    // widen the inspector with its keyboard-operable resizer (each arrow press is 16px)
    await page.getByRole('separator', { name: 'Resize inspector' }).focus();
    for (let i = 0; i < 26; i++) await page.keyboard.press('ArrowLeft');
    await expect(split).toBeEnabled();
    await split.click();
    const card = page.locator('.cfile', { hasText: 'long.txt' });
    const oldPane = card.locator('.split-pane.old'), newPane = card.locator('.split-pane.new');
    await expect(oldPane).toBeVisible(); await expect(newPane).toBeVisible();
    await expect(oldPane).toContainText('line 3:'); await expect(newPane).toContainText('EDITED');
    await expect(oldPane).not.toContainText('EDITED');
    // aligned: same rows, same heights, side by side
    expect(await oldPane.locator('tr').count()).toBe(await newPane.locator('tr').count());
    const [ob, nb] = [await oldPane.boundingBox(), await newPane.boundingBox()];
    expect(Math.abs(ob!.y - nb!.y)).toBeLessThanOrEqual(1); expect(Math.abs(ob!.height - nb!.height)).toBeLessThanOrEqual(1);
    expect(ob!.width).toBeGreaterThan(200); expect(nb!.width).toBeGreaterThan(200);
    // a modified file shows removed lines on the left and added lines on the right
    const ex = page.locator('.cfile', { hasText: 'example.ts' });
    await expect(ex.locator('.split-pane.old')).toContainText('hello');
    await expect(ex.locator('.split-pane.new')).toContainText('answer = 42');
    // scroll-synced both ways
    await newPane.evaluate((e) => { e.scrollTop = 120; e.scrollLeft = 60; });
    await expect.poll(() => oldPane.evaluate((e) => [e.scrollTop, e.scrollLeft])).toEqual([120, 60]);
    await oldPane.evaluate((e) => { e.scrollTop = 40; });
    await expect.poll(() => newPane.evaluate((e) => e.scrollTop)).toBe(40);
  });
});

test.describe('minors', () => {
  test('a pending WebFetch says "Fetching…", not "Fetched"', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'web please');
    const card = page.locator('.tool-web.st-waiting');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Fetching…');
    await expect(card).not.toContainText('Fetched');
    await page.locator('[data-perm-allow]').click();
    await expectIdle(page);
    await expect(page.locator('.tool-web').filter({ hasText: 'Fetched' })).toHaveCount(1);
  });

  test('the Bash permission card shows the command once, with one explanatory line', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'bash please');
    const card = page.locator('.tool-bash.st-waiting');
    await expect(card).toBeVisible();
    expect(await card.getByText('npm test -- --reporter=dot').count()).toBe(1);
    await expect(card.locator('.perm-title')).toHaveText('Claude wants to run this command');
    await page.locator('[data-perm-allow]').click();
    await expectIdle(page);
  });

  test('reload reopens the session that was open', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'remember me please');
    await expectIdle(page);
    await page.reload();
    await expect(page.locator('.msg-user').filter({ hasText: 'remember me please' })).toBeVisible({ timeout: 15_000 });
  });

  test('Alt+N starts a new session (Ctrl+N is reserved by Chrome) and the shortcut list says so', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'first one');
    await expectIdle(page);
    await page.keyboard.press('Alt+n');
    await expect(page.getByRole('heading', { name: 'What should we work on?' })).toBeVisible();
    await page.keyboard.press('Control+/');
    const dlg = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dlg.locator('div', { hasText: /^AltNNew session$/ })).toBeVisible();
    await expect(dlg).not.toContainText('Ctrl N');
  });

  test('session actions are reachable by keyboard (Tab to the actions button, or the context-menu key)', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'keyboard please');
    await expectIdle(page);
    const row = page.locator('.sess.active');
    await row.focus();
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveAttribute('aria-label', /^Actions for /);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: /Rename/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await row.focus();
    await page.keyboard.press('ContextMenu');
    await expect(page.getByRole('menuitem', { name: /Fork session/ })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('Settings traps focus and Escape closes it; the palette dialog has an accessible name', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+,');
    const dlg = page.getByRole('dialog', { name: /Settings|Welcome/ });
    await expect(dlg).toBeVisible();
    for (let i = 0; i < 45; i++) {
      await page.keyboard.press(i % 2 ? 'Tab' : 'Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), `focus escaped the dialog on Tab ${i}`).toBe(true);
    }
    for (let i = 0; i < 45; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), `focus escaped on Shift+Tab ${i}`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('inspector tabs are one tab stop with arrow-key navigation', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await openInspector(page, 'overview');
    const tabs = page.getByRole('tab');
    expect(await tabs.evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).length)).toBe(1);
    await page.locator('.itab[aria-selected="true"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.itab[aria-selected="true"]')).toHaveAttribute('data-panel', 'plan');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.itab[aria-selected="true"]')).toHaveAttribute('data-panel', 'overview');
  });

  test('copy names the product The Workstation, not Claude Code', async ({ page }) => {
    await openApp(page);
    await expect(page.getByText(/Run Claude Code/)).toHaveCount(0);
    await expect(page.getByText(/Run coding agents side by side/)).toBeVisible();
    await page.keyboard.press('Control+,');
    const dlg = page.getByRole('dialog', { name: /Settings|Welcome/ });
    await expect(dlg).not.toContainText('Claude Code');
    await expect(dlg).toContainText('Claude Agent SDK');
  });
});

void TOKEN; void composer; void closeDrawers; void openSidebar;
