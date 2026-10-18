import { expect, expectIdle, newSessionInProject, openApp, openInspector, sendPrompt, test } from '../../support/app.ts';

/** Alpha features against the mock SDK: diff line comments batched into one prompt, rewind menu, rules viewer and the worktree chip. */

test.describe('diff line comments', () => {
  test('click a line, comment, comment again, send: ONE prompt with both; discard drops them', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await openInspector(page, 'changes');
    const file = page.locator('.cfile', { hasText: 'example.ts' });
    await expect(file).toBeVisible();
    const row = file.locator('.diff-row.diff-add').first();
    await row.hover();
    await row.getByRole('button', { name: /^Comment on line \d+/ }).click();
    await page.getByRole('textbox', { name: 'Comment' }).fill('Use a const enum here');
    await page.getByRole('button', { name: 'Add comment' }).click();
    await expect(file.locator('.cmt-text')).toHaveText('Use a const enum here');
    const row2 = file.locator('.diff-row.diff-add').nth(1);
    await row2.hover();
    await row2.getByRole('button', { name: /^Comment on line \d+/ }).click();
    await page.getByRole('textbox', { name: 'Comment' }).fill('Add a docstring\nexplaining the unit');
    await page.keyboard.press('Control+Enter');
    await expect(file.locator('.cmt-text')).toHaveCount(2);
    const bar = page.getByRole('group', { name: 'Review comments' });
    await expect(bar).toContainText('2 comments');
    // delete one, add it back through discard/send flow
    await file.getByRole('button', { name: /^Delete comment on line/ }).first().click();
    await expect(bar).toContainText('1 comment');
    await bar.getByRole('button', { name: 'Discard' }).click();
    await expect(bar).toHaveCount(0);
    // again, two comments, send
    for (const [i, t] of [[0, 'first thing'], [1, 'second thing']] as const) {
      const r = file.locator('.diff-row.diff-add').nth(i);
      await r.hover();
      await r.getByRole('button', { name: /^Comment on line \d+/ }).click();
      await page.getByRole('textbox', { name: 'Comment' }).fill(t);
      await page.getByRole('button', { name: 'Add comment' }).click();
    }
    await page.getByRole('button', { name: 'Send to agent' }).click();
    await expect(page.locator('.msg-user')).toHaveCount(1);
    const sent = page.locator('.msg-user').first();
    await expect(sent).toContainText('I reviewed your changes and left 2 comments');
    await expect(sent).toContainText('src/example.ts');
    await expect(sent).toContainText('first thing');
    await expect(sent).toContainText('second thing');
    await expect(bar).toHaveCount(0);
    await expectIdle(page);
  });
});

test.describe('rewind menu', () => {
  test('offers code / conversation / both; the first message cannot rewind the conversation; conversation rewind branches a shorter session', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await sendPrompt(page, 'hello first');
    await expectIdle(page);
    await sendPrompt(page, 'and a second one');
    await expectIdle(page);
    const msgs = page.locator('.msg-user');
    await expect(msgs).toHaveCount(2);
    await msgs.nth(0).hover();
    await msgs.nth(0).getByRole('button', { name: 'Rewind…' }).click();
    await expect(page.getByRole('menuitem', { name: /^Restore code(?! and)/ })).toBeEnabled();
    await expect(page.getByRole('menuitem', { name: /^Restore conversation/ })).toBeDisabled();
    await page.keyboard.press('Escape');
    // code: dialog names what is not covered
    await msgs.nth(1).hover();
    await msgs.nth(1).getByRole('button', { name: 'Rewind…' }).click();
    await page.getByRole('menuitem', { name: /^Restore code(?! and)/ }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('Not restored: changes made through Bash');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    // conversation: new session with only the first turn
    await msgs.nth(1).hover();
    await msgs.nth(1).getByRole('button', { name: 'Rewind…' }).click();
    await page.getByRole('menuitem', { name: /^Restore conversation/ }).click();
    await page.getByRole('button', { name: 'Rewind conversation' }).click();
    await expect(page.locator('.topbar-session')).toContainText('Rewound:');
    await expect(page.locator('.msg-user')).toHaveCount(1);
    await expect(page.locator('.msg-user').first()).toContainText('hello first');
    await sendPrompt(page, 'carry on from here');
    await expect(page.locator('.msg-assistant').last()).toContainText('carry on from here');
  });
});

test.describe('settings: remembered permissions', () => {
  test('the viewer opens with a project selector and an honest empty state', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    await page.keyboard.press('Control+,');
    const rules = page.getByTestId('remembered-rules');
    await expect(rules).toBeVisible();
    await expect(rules.getByRole('combobox', { name: 'Project' })).toBeVisible();
    await expect(rules).toContainText(/No saved rules|Allow|Deny|Ask/);
  });
});

test.describe('new session: worktree option', () => {
  test('the chip appears for a git project, toggles, and is hidden once the session started', async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
    const chip = page.locator('.chip-wt .chip-btn');
    await expect(chip).toContainText('Project folder');
    await chip.click();
    await page.getByRole('menuitem', { name: /New git worktree/ }).click();
    await expect(chip).toContainText('New worktree');
    await sendPrompt(page, 'hello from a worktree');
    await expectIdle(page);
    await expect(page.locator('.chip-wt')).toHaveCount(0);
  });
});
