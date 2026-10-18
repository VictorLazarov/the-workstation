import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { composer, expect, expectIdle, newSessionInProject, openInspector, openSidebar, sendPrompt, test, TOKEN } from '../../support/app.ts';
import { startPrivateServer } from '../../support/server.ts';

/** Pass 5 M2 + M3: cancelling the "discard changes" dialog must not end the session; a removed worktree's session stays listed after a reload. */
test('cancel at "Discard uncommitted changes?" keeps session and worktree; a forced removal leaves a read-only session that survives a reload', async ({ page }) => {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-e2e-wt-')));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...a], { cwd: repo, stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'README.md'), '# wt fixture\n');
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'seed');
  const srv = await startPrivateServer({ cwd: repo });
  try {
  await page.goto(`${srv.base}/?token=${TOKEN}`);
  await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
  await newSessionInProject(page);
  await page.locator('.chip-wt .chip-btn').click();
  await page.getByRole('menuitem', { name: /New git worktree/ }).click();
  await sendPrompt(page, 'worktree removal check');
  await expectIdle(page);
  await openInspector(page, 'overview');
  const wtPath = (await page.locator('.ov-row[title*="worktrees"]').first().getAttribute('title'))!;
  expect(fs.existsSync(wtPath)).toBe(true);
  fs.writeFileSync(`${wtPath}/dirty.txt`, 'uncommitted\n');

  const remove = page.getByRole('button', { name: /Remove worktree/ });
  await remove.click();
  await page.getByRole('dialog', { name: 'Remove this worktree?' }).getByRole('button', { name: 'Remove worktree' }).click();
  const second = page.getByRole('dialog', { name: 'Discard uncommitted changes?' });
  await expect(second).toBeVisible();
  await second.getByRole('button', { name: 'Cancel' }).click();
  await expect(second).toHaveCount(0);
  // untouched: still a live, usable session in an existing worktree
  await page.waitForTimeout(400);
  await expect(page.getByText('Session ended')).toHaveCount(0);
  await expect(composer(page)).toBeEnabled();
  expect(fs.existsSync(`${wtPath}/dirty.txt`)).toBe(true);
  await sendPrompt(page, 'still alive after cancel');
  await expectIdle(page);
  await expect(page.locator('.msg-user', { hasText: 'still alive after cancel' })).toHaveCount(1);

  // now really remove it
  await remove.click();
  await page.getByRole('dialog', { name: 'Remove this worktree?' }).getByRole('button', { name: 'Remove worktree' }).click();
  await page.getByRole('dialog', { name: 'Discard uncommitted changes?' }).getByRole('button', { name: 'Discard changes and remove' }).click();
  await expect(composer(page)).toBeDisabled();
  expect(fs.existsSync(wtPath)).toBe(false);

  // M3: after a reload it is still reachable: sidebar (marked), palette, and read-only history
  await page.reload();
  await openSidebar(page);
  const row = page.locator('.sess', { hasText: 'worktree removal check' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('worktree removed');
  await row.click();
  await expect(page.locator('.msg-user', { hasText: 'worktree removal check' })).toBeVisible();
  await expect(composer(page)).toBeDisabled();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').or(page.getByRole('textbox', { name: /command|search/i })).first().fill('worktree removal check');
  await expect(page.getByRole('option', { name: /worktree removal check/ })).toHaveCount(1);
  } finally { srv.stop(); fs.rmSync(repo, { recursive: true, force: true }); }
});
