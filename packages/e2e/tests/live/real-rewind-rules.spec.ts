import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '../../support/app.ts';
import { makeRepo, newRealSession, openReal, REAL, realTurn, shot, startRealServer, type RealServer } from '../../support/real.ts';

/** REAL SDK (REAL_SDK=1): rewind menu (code / conversation) and the remembered-rules viewer. */
test.skip(!REAL, 'set REAL_SDK=1 to run against the real Claude Agent SDK');
test.describe.configure({ mode: 'serial', timeout: 300_000 });

let srv: RealServer;
let repo: string;
test.beforeAll(async () => { repo = makeRepo('rw'); srv = await startRealServer(repo, { defaultPermissionMode: 'acceptEdits' }); });
test.afterAll(async () => { await srv?.stop(); });
const read = (f: string) => (fs.existsSync(path.join(repo, f)) ? fs.readFileSync(path.join(repo, f), 'utf8').trim() : null);

test('rewind: code restores file edits and says Bash is not covered; conversation branches a new session; first message cannot be rewound', async ({ page }) => {
  await openReal(page, srv);
  await newRealSession(page);
  await realTurn(page, 'Create a file a.txt containing exactly v1 using the Write tool. Reply done.');
  await realTurn(page, 'Change a.txt to contain exactly v2 using the Write or Edit tool, then run the bash command `echo bash > b.txt`. Reply done.');
  expect(read('a.txt')).toBe('v2');
  const msgs = page.locator('.msg-user');
  // first message: conversation rewind is unavailable
  await msgs.nth(0).hover();
  await msgs.nth(0).getByRole('button', { name: 'Rewind…' }).click();
  await expect(page.getByRole('menuitem', { name: /^Restore conversation/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  // code only
  await msgs.nth(1).hover();
  await msgs.nth(1).getByRole('button', { name: 'Rewind…' }).click();
  await page.getByRole('menuitem', { name: /^Restore code(?! and)/ }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Restore files to before this message?');
  await expect(dlg).toContainText('a.txt');
  await expect(dlg).toContainText('Not restored: changes made through Bash');
  await shot(page, 'rewind-code-confirm');
  await dlg.getByRole('button', { name: 'Restore files' }).click();
  await expect(page.getByText('Files restored')).toBeVisible();
  expect(read('a.txt')).toBe('v1');
  expect(read('b.txt')).toBe('bash'); // the Bash edit is exactly what the dialog said it cannot restore
  // conversation only: a new session that has only the first turn
  await msgs.nth(1).hover();
  await msgs.nth(1).getByRole('button', { name: 'Rewind…' }).click();
  await page.getByRole('menuitem', { name: /^Restore conversation/ }).click();
  await expect(page.getByRole('dialog')).toContainText('This session stays exactly as it is');
  await page.getByRole('button', { name: 'Rewind conversation' }).click();
  await expect(page.locator('.sess')).toHaveCount(2);
  await expect(page.locator('.msg-user')).toHaveCount(1);
  await expect(page.locator('.topbar-session')).toContainText('Rewound:');
  await realTurn(page, 'Do not use tools. In one sentence: how many requests did I send before this one, and what was the last about?');
  await expect(page.locator('.msg-assistant').last()).toContainText(/v1|a\.txt/);
  await shot(page, 'rewind-conversation');
});

test('Always allow persists; Settings lists it; forgetting it makes Claude ask again', async ({ page }) => {
  await openReal(page, srv);
  await newRealSession(page);
  await page.locator('.composer-chips .chip-btn').first().click();
  await page.getByRole('menuitem', { name: /Ask permissions/ }).click();
  expect(await realTurn(page, 'Run the bash command `touch f1.txt` with the Bash tool. Nothing else.', { answer: 'always' })).toBe(1);
  expect(fs.readFileSync(path.join(repo, '.claude/settings.local.json'), 'utf8')).toContain('Bash(touch f1.txt)');
  expect(await realTurn(page, 'Run the bash command `touch f1.txt` again with the Bash tool. Nothing else.')).toBe(0);
  await page.keyboard.press('Control+,');
  const rules = page.getByTestId('remembered-rules');
  await expect(rules).toContainText('Bash(touch f1.txt)');
  await expect(rules).toContainText('This project, private');
  await shot(page, 'rules-viewer');
  await rules.getByRole('button', { name: /^Forget Bash/ }).click();
  await page.getByRole('button', { name: 'Forget rule' }).click();
  await expect(rules).toContainText('No saved rules');
  await page.keyboard.press('Escape');
  expect(await realTurn(page, 'Run the bash command `touch f1.txt` once more with the Bash tool. Nothing else.')).toBe(1);
});
