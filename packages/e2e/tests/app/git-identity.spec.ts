import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composer, expect, newSessionInProject, openInspector, test, TOKEN } from '../../support/app.ts';
import { startPrivateServer } from '../../support/server.ts';

test('Commit in a repo without a git identity says what to do instead of waiting silently', async ({ page }) => {
  // its own repo AND server (no leftovers in the shared fixtures): an EMPTY local user.name wins over any global identity
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-e2e-noident-')));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('-c', 'user.name=seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', 'seed');
  git('config', 'user.name', ''); git('config', 'user.email', '');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const srv = await startPrivateServer({ cwd: repo });
  try {
    await page.goto(`${srv.base}/?token=${TOKEN}`);
    await expect(page.getByRole('complementary', { name: 'Sessions' })).toBeVisible();
    await newSessionInProject(page);
    await openInspector(page, 'changes');
    await expect(page.locator('.cfile', { hasText: 'a.txt' })).toHaveCount(1);
    await page.getByRole('textbox', { name: 'Commit message' }).fill('change a');
    await page.getByRole('button', { name: 'Commit', exact: true }).click();
    const alert = page.locator('.ccommit-err');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('name and email');
    await expect(alert).toContainText('git config');
    await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeEnabled(); // not stuck busy
    expect(execFileSync('git', ['log', '--oneline'], { cwd: repo }).toString().trim().split('\n')).toHaveLength(1);
    await expect(composer(page)).toBeVisible();
  } finally { srv.stop(); fs.rmSync(repo, { recursive: true, force: true }); }
});
