import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page, WebSocketRoute } from '@playwright/test';
import { closeDrawers, expect, expectIdle, newSessionInProject, openApp, openInspector, openSidebar, sendPrompt, test } from '../../support/app.ts';
import { readState } from '../../support/env.ts';

/**
 * Scrutiniser 4 fixes, exercised against the HONEST mock (WORKSTATION_MOCK_FS=1): the agent's Edit/Write really change a
 * throwaway repo, "Always allow" is written to .claude/settings.local.json and applied to the next matching call.
 */
const S = readState();
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...a], { cwd: S.fsProject, stdio: 'pipe' }).toString();
const BASE = git('rev-parse', 'HEAD').trim();
const onDisk = (rel: string) => path.join(S.fsProject, rel);
const allow = (page: Page) => page.locator('[data-perm-allow]').first().click();
const watch = (page: Page) => {
  const bad: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') bad.push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => bad.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`http ${r.status()}: ${r.url()}`); });
  return bad;
};

test.describe.configure({ mode: 'serial' });
test.beforeEach(() => {
  git('reset', '-q', '--hard', BASE); git('clean', '-fdq');
  fs.rmSync(onDisk('.claude'), { recursive: true, force: true });
});

test.describe('M1: a folder the agent creates is reviewable', () => {
  test('one card per new file, a real diff (never an endless spinner), correct counts, Commit list == visible list, delete works', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'write newdir please');
    await allow(page);
    await expectIdle(page);
    expect(fs.existsSync(onDisk('src/lib/util.ts'))).toBe(true); // the mock really wrote it
    await openInspector(page, 'changes');
    const card = page.locator('.cfile', { hasText: 'util.ts' });
    await expect(card).toHaveCount(1);
    await expect(card.locator('.cfile-dir')).toContainText('src/lib');
    await expect(page.locator('.cfile', { hasText: /^\s*U\s*src\s*$/ })).toHaveCount(0); // not one opaque "src" card
    await expect(card.locator('.diff-add').first()).toBeVisible();
    await expect(page.getByText('Loading diff…')).toHaveCount(0);
    await expect(page.locator('.changes-sum')).toContainText('1 file');
    await expect(page.locator('.ccommit')).toContainText('these 1 file');
    // commit exactly what is listed
    await page.getByRole('textbox', { name: 'Commit message' }).fill('add util');
    await page.getByRole('button', { name: 'Commit', exact: true }).click();
    await expect(page.getByText('No changes')).toBeVisible();
    expect(git('show', '--name-only', '--format=', 'HEAD').trim()).toBe('src/lib/util.ts');
  });

  test('deleting a file of a new folder works and leaves a clean tree', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'write newdir please');
    await allow(page);
    await expectIdle(page);
    await openInspector(page, 'changes');
    const card = page.locator('.cfile', { hasText: 'util.ts' });
    await card.getByRole('button', { name: 'Delete file…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete file' }).click();
    await expect(page.getByText('No changes')).toBeVisible();
    expect(fs.existsSync(onDisk('src/lib/util.ts'))).toBe(false);
    await expect(page.getByText(/Could not revert/)).toHaveCount(0);
  });

  test('Edit really changes a file: it shows in Changes with a diff, and the tree is dirty on disk', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'edit the greeting');
    await allow(page);
    await expectIdle(page);
    expect(fs.readFileSync(onDisk('src/example.ts'), 'utf8')).toContain('farewell');
    await openInspector(page, 'changes');
    const card = page.locator('.cfile', { hasText: 'example.ts' });
    await expect(card.locator('.diff-add').first()).toBeVisible();
    expect(git('status', '--porcelain')).toContain('src/');
  });
});

test.describe('mock honesty: Always allow persists and applies', () => {
  test('rule is written, the same command no longer asks, Forget makes it ask again', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'bash please');
    await page.getByRole('button', { name: 'Always allow' }).click();
    await expectIdle(page);
    const file = onDisk('.claude/settings.local.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).permissions.allow).toContain('Bash(npm test:*)');
    await sendPrompt(page, 'bash again please');
    await expect(page.locator('.msg-assistant').last()).toContainText('20 tests', { timeout: 10_000 });
    await expect(page.locator('[data-perm-allow]')).toHaveCount(0); // never asked
    // the rules viewer shows it; Forget removes it from the file
    await page.keyboard.press('Control+,');
    const rules = page.getByTestId('remembered-rules');
    await expect(rules).toContainText('Bash(npm test:*)');
    await rules.getByRole('button', { name: /^Forget Bash/ }).click();
    await page.getByRole('button', { name: 'Forget rule' }).click();
    await expect(rules).not.toContainText('Bash(npm test:*)');
    await page.keyboard.press('Escape');
    await sendPrompt(page, 'bash third please');
    await expect(page.locator('[data-perm-allow]').first()).toBeVisible();
    await page.getByRole('button', { name: 'Deny' }).first().click();
  });
});

test.describe('M2: a long remembered rule does not break Settings', () => {
  const LONG = `Bash(git commit -m "${'a really long commit message that never ends '.repeat(8)}":*)`;
  for (const width of [1280, 800, 560]) {
    test(`Settings stays usable with a ${LONG.length}-char rule at ${width}px`, async ({ page }) => {
      fs.mkdirSync(onDisk('.claude'), { recursive: true });
      fs.writeFileSync(onDisk('.claude/settings.local.json'), JSON.stringify({ permissions: { allow: [LONG, 'Bash(ls:*)'] } }));
      await page.setViewportSize({ width, height: 900 });
      await openApp(page);
      await newSessionInProject(page);
      await closeDrawers(page);
      await page.keyboard.press('Control+,');
      const dlg = page.getByRole('dialog');
      await expect(dlg.getByTestId('remembered-rules')).toContainText('git commit -m');
      const body = dlg.locator('.dialog-body');
      const [sw, cw] = await body.evaluate((e) => [e.scrollWidth, e.clientWidth]);
      expect(sw, 'dialog body scrolls sideways').toBeLessThanOrEqual(cw + 1);
      // every control stays inside the viewport
      for (const name of [/Server URL/i]) {
        const box = await dlg.getByLabel(name).first().boundingBox();
        if (box) expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      const forget = dlg.getByRole('button', { name: /^Forget Bash\(git commit/ });
      const fb = await forget.boundingBox();
      expect(fb!.x + fb!.width).toBeLessThanOrEqual(width);
      expect(fb!.x).toBeGreaterThanOrEqual(0);
      const doc = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(doc).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('M3: a rejected API key is reported once', () => {
  test('one notice with a Settings action, no CLI wording, no stale retrying card', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'say 401 please');
    const conv = page.locator('.conv-scroll');
    const notice = conv.locator('.banner, .notice, [role=alert]').filter({ hasText: /API key/i });
    await expect(notice.first()).toBeVisible();
    await expectIdle(page);
    await expect(conv.getByText(/API key/i)).toHaveCount(1); // said exactly once
    await expect(conv).not.toContainText(/external API key/i);
    await expect(conv).not.toContainText(/Authentication failed/i);
    await expect(conv).not.toContainText(/retrying/i);
    await expect(conv.locator('.spinner')).toHaveCount(0);
    await expect(conv.getByRole('button', { name: /Open Settings/i })).toHaveCount(1);
    await conv.getByRole('button', { name: /Open Settings/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
  test('the mock error scenario prints its message once', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'trigger an error please');
    await expectIdle(page);
    const text = await page.locator('.conv-scroll').innerText();
    expect(text.split('Mock error: something went wrong').length - 1).toBe(1);
  });
});

test.describe('minors', () => {
  const TOKEN = 'x'.repeat(180);
  for (const width of [1280, 800, 560]) {
    test(`a long unbreakable token in prose never scrolls the conversation sideways (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openApp(page);
      await newSessionInProject(page);
      await sendPrompt(page, `please echo ${TOKEN}`);
      await expectIdle(page);
      await expect(page.locator('.msg-assistant').last()).toContainText('xxxxxxxxxx');
      const [sw, cw] = await page.locator('.conv-scroll').evaluate((e) => [e.scrollWidth, e.clientWidth]);
      expect(sw).toBeLessThanOrEqual(cw + 1);
      const right = await page.locator('.msg-assistant').last().evaluate((e) => e.getBoundingClientRect().right);
      expect(right).toBeLessThanOrEqual(width);
    });
  }

  test('no 404 / console error after Remove worktree (the Changes poll stops)', async ({ page }) => {
    const bad = watch(page);
    await openApp(page);
    await newSessionInProject(page);
    await page.locator('.chip-wt .chip-btn').click();
    await page.getByRole('menuitem', { name: /New git worktree/ }).click();
    await sendPrompt(page, 'hello from a worktree');
    await expectIdle(page);
    await openInspector(page, 'changes');
    await openInspector(page, 'overview');
    await page.getByRole('button', { name: /Remove worktree/ }).click();
    await page.getByRole('button', { name: 'Remove worktree', exact: true }).click();
    await expect(page.getByText(/Session ended \(worktree removed\)|worktree removed/i).first()).toBeVisible();
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await openInspector(page, 'changes');
    await page.waitForTimeout(1000);
    expect(bad).toEqual([]);
  });

  test('a session that needs input is never hidden behind "Show N more"', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'bash needs-input-first');
    await expect(page.locator('[data-perm-allow]').first()).toBeVisible();
    for (let i = 0; i < 8; i++) {
      await newSessionInProject(page);
      await sendPrompt(page, `idle filler ${i}`);
      await expectIdle(page);
    }
    await openSidebar(page);
    const row = page.locator('.sess', { hasText: 'needs-input-first' });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/Needs input/);
    await expect(page.locator('.sess-showall')).toBeVisible(); // idle ones are still folded
  });

  test('toasts: they end by themselves, do not survive an outage, and at 560px do not cover the conversation', async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 900 });
    let down = false;
    const open: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/ws(\?|$)/, (ws) => { if (down) { ws.close(); return; } open.push(ws); ws.connectToServer(); });
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'hello toast');
    await expectIdle(page);
    const toast = (t: object) => page.evaluate((x) => (window as unknown as { __ws: { toast: (t: unknown) => string } }).__ws.toast(x), t);
    while (await page.locator('.toast').count()) await page.locator('.toast').first().getByRole('button', { name: 'Dismiss' }).click();
    await toast({ kind: 'attention', tag: 'nar', title: 'Approval needed', body: 'something: waiting for you' });
    const t = page.locator('.toast', { hasText: 'Approval needed' });
    await expect(t).toBeVisible();
    const tb = await t.boundingBox();
    const first = await page.locator('.conv-scroll').boundingBox();
    expect(tb!.y + tb!.height).toBeLessThanOrEqual(first!.y + 1); // the strip is reserved: nothing underneath
    // an outage removes stale session toasts at once
    down = true;
    for (const ws of open.splice(0)) ws.close();
    await expect(t).toHaveCount(0, { timeout: 5000 });
    down = false;
  });

  test('an attention toast dismisses itself', async ({ page }) => {
    test.setTimeout(30_000);
    await openApp(page);
    const toast = (t: object) => page.evaluate((x) => (window as unknown as { __ws: { toast: (t: unknown) => string } }).__ws.toast(x), t);
    while (await page.locator('.toast').count()) await page.locator('.toast').first().getByRole('button', { name: 'Dismiss' }).click();
    await toast({ kind: 'attention', tag: 'self', title: 'Self dismissing', ttl: 2500 });
    await expect(page.locator('.toast', { hasText: 'Self dismissing' })).toBeVisible();
    await expect(page.locator('.toast', { hasText: 'Self dismissing' })).toHaveCount(0, { timeout: 8000 });
  });

  test('diff comments survive a reload', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'write newdir please');
    await allow(page);
    await expectIdle(page);
    await openInspector(page, 'changes');
    const file = page.locator('.cfile', { hasText: 'util.ts' });
    const row = file.locator('.diff-row.diff-add').first();
    await row.hover();
    await row.getByRole('button', { name: /^Comment on line \d+/ }).click();
    await page.getByRole('textbox', { name: 'Comment' }).fill('keep me across reloads');
    await page.getByRole('button', { name: 'Add comment' }).click();
    await expect(file.locator('.cmt-text')).toHaveText('keep me across reloads');
    await page.reload();
    await expect(page.locator('.msg-user', { hasText: 'write newdir' })).toBeVisible({ timeout: 15_000 }); // the open session came back
    await page.waitForTimeout(400);
    await openInspector(page, 'changes');
    await expect(page.getByRole('group', { name: 'Review comments' })).toContainText('1 comment', { timeout: 15_000 });
    await expect(page.locator('.cmt-text')).toHaveText('keep me across reloads');
    await page.getByRole('button', { name: 'Discard' }).click();
    await page.reload();
    await expect(page.locator('.msg-user', { hasText: 'write newdir' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('group', { name: 'Review comments' })).toHaveCount(0);
  });

  test('topbar at 560px keeps the session title and the status', async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 900 });
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'a distinctive session title');
    await expectIdle(page);
    await expect(page.locator('.topbar-session')).toBeVisible();
    await expect(page.locator('.topbar-session')).toContainText('a distinctive');
    const pill = page.locator('.status-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('Idle');
    const [sw, cw] = await page.locator('.topbar').evaluate((e) => [e.scrollWidth, e.clientWidth]);
    expect(sw).toBeLessThanOrEqual(cw + 1);
  });

  test('a markdown link whose href was stripped renders as plain text, not a new-tab link', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'echo [click me](javascript:alert(1)) and [ok](https://example.com/x)');
    await expectIdle(page);
    const msg = page.locator('.msg-assistant').last();
    await expect(msg).toContainText('click me');
    await expect(msg.getByRole('link', { name: 'click me' })).toHaveCount(0);
    await expect(msg.locator('a[href=""]')).toHaveCount(0);
    await expect(msg.getByRole('link', { name: 'ok' })).toHaveAttribute('target', '_blank');
  });
});
