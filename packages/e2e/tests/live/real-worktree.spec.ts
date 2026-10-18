import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { expect, test } from '../../support/app.ts';
import { makeRepo, newRealSession, openReal, REAL, realTurn, shot, startRealServer, type RealServer } from '../../support/real.ts';

/** REAL SDK (REAL_SDK=1): a session in a new git worktree, from the new-session toggle to removal. */
test.skip(!REAL, 'set REAL_SDK=1 to run against the real Claude Agent SDK');
test.describe.configure({ mode: 'serial', timeout: 240_000 });

let srv: RealServer;
let repo: string;
test.beforeAll(async () => { repo = makeRepo('wt'); srv = await startRealServer(repo); });
test.afterAll(async () => { await srv?.stop(); });
const sh = (c: string, cwd = repo) => execSync(c, { cwd, encoding: 'utf8' });

test('worktree toggle -> edit in the worktree -> commit there -> sidebar/topbar honest -> remove (dirty asks to discard)', async ({ page }) => {
  await openReal(page, srv);
  await newRealSession(page);
  await expect(page.locator('.chip-wt .chip-btn')).toContainText('Project folder');
  await page.locator('.chip-wt .chip-btn').click();
  await page.getByRole('menuitem', { name: /New git worktree/ }).click();
  await expect(page.locator('.chip-wt .chip-btn')).toContainText('New worktree');
  await shot(page, 'worktree-toggle');
  await realTurn(page, 'Create a file named wt-note.txt containing the single word hi (use the Write tool). Then reply done.');

  const wtDir = sh('git worktree list --porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).find((p) => p.includes('.claude/worktrees'))!;
  expect(fs.readFileSync(path.join(wtDir, 'wt-note.txt'), 'utf8')).toContain('hi');
  expect(sh('git status --short')).toBe(''); // the main checkout is untouched
  // the sidebar files it under the PROJECT (not under the worktree directory) and says it is a worktree
  await expect(page.locator('.proj-name')).toHaveText([path.basename(repo)]);
  await expect(page.locator('.sess .sess-branch').first()).toHaveAttribute('title', /^Worktree workstation\//);
  await expect(page.locator('.topbar .crumb.branch')).toContainText('workstation/');
  await expect(page.locator('.topbar .crumb-name').first()).toHaveText(path.basename(repo));
  // Changes: the edit is there and commits onto the worktree branch
  await page.locator('.itab[data-panel="changes"]').click();
  await page.getByPlaceholder('Commit message').fill('Add wt-note');
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.getByText(/^Committed /)).toBeVisible();
  expect(sh('git log --oneline -1', wtDir)).toContain('Add wt-note');
  expect(sh('git log --oneline -1')).toContain('init'); // main branch did not move
  // a reload keeps it filed under the project, as a worktree
  await page.reload();
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('.proj-name')).toHaveText([path.basename(repo)]);
  await page.locator('.sess').first().click();
  await page.locator('.itab[data-panel="overview"]').click();
  await expect(page.locator('[data-card=env]')).toContainText('Worktree');
  // dirty it, then remove: refused first, then an explicit discard
  fs.writeFileSync(path.join(wtDir, 'scratch.txt'), 'x');
  await page.getByRole('button', { name: /Remove worktree/ }).click();
  await page.getByRole('button', { name: 'Remove worktree', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Discard uncommitted changes?');
  await page.getByRole('button', { name: /Discard changes and remove/ }).click();
  await expect(page.getByText('Worktree removed').first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Claude' })).toBeDisabled();
  expect(fs.existsSync(wtDir)).toBe(false);
  expect(sh('git worktree list').trim().split('\n')).toHaveLength(1);
  await shot(page, 'worktree-removed');
});
