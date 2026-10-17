import { expandTool, expect, expectIdle, newSessionInProject, openApp, sendPrompt, test, toolCard } from '../../support/app.ts';

const permission = (page: import('@playwright/test').Page) => page.getByRole('group', { name: 'Permission request' });

test.describe('mock scenarios render their cards', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
  });

  test('bash: command card waits for permission, then shows the output after Allow once', async ({ page }) => {
    await sendPrompt(page, 'please run bash');
    const card = toolCard(page, 'bash');
    await expect(card).toContainText('Run the test suite');
    await expect(permission(page)).toContainText('Claude wants to run this command');
    await permission(page).getByRole('button', { name: 'Allow once' }).click();
    await expect(permission(page)).toHaveCount(0);
    await expandTool(card);
    await expect(card.locator('.output')).toContainText(/Tests\s+20 passed/);
    await expect(page.locator('.msg-assistant').last()).toContainText('All 20 tests pass.');
    await expectIdle(page);
  });

  test('edit: the diff card shows the added lines once allowed', async ({ page }) => {
    await sendPrompt(page, 'please edit the greeting');
    await expect(permission(page)).toContainText('Claude wants to edit');
    await permission(page).getByRole('button', { name: 'Allow once' }).click();
    const card = toolCard(page, 'edit');
    await expect(card).toContainText('example.ts');
    await expandTool(card);
    await expect(card).toContainText('farewell');
    await expect(page.locator('.msg-assistant').last()).toContainText('Edited src/example.ts (+2 -1).');
    await expectIdle(page);
  });

  test('write: the new file card reports the created file', async ({ page }) => {
    await sendPrompt(page, 'please write notes');
    await expect(permission(page)).toContainText('Claude wants to create');
    await permission(page).getByRole('button', { name: 'Allow once' }).click();
    const card = toolCard(page, 'write');
    await expect(card).toContainText('NOTES.md');
    await expandTool(card);
    await expect(card).toContainText('Created by the mock agent.');
    await expect(page.locator('.msg-assistant').last()).toContainText('Created NOTES.md.');
    await expectIdle(page);
  });

  test('todo: the checklist progresses to 3/3 done', async ({ page }) => {
    await sendPrompt(page, 'track this todo list');
    // Each TodoWrite step renders its own card; the newest one is the current checklist.
    const card = toolCard(page, 'todo').last();
    await expect(card).toContainText('Read the codebase');
    await expect(card).toContainText('Implement the change');
    await expect(card).toContainText('Run the tests');
    await expect(card).toContainText('3/3 done');
    await expectIdle(page);
  });

  test('task: the subagent group shows the agent, its description and the nested result', async ({ page }) => {
    await sendPrompt(page, 'run a task for the greeting');
    const card = toolCard(page, 'task');
    await expect(card).toContainText('Explore');
    await expect(card).toContainText('Explore the repo');
    await expect(card).toHaveClass(/st-done/);
    await expandTool(card);
    await expect(card).toContainText('The greeting is defined in src/example.ts line 1.');
    await expect(page.locator('.msg-assistant').last()).toContainText('The subagent located the greeting');
    await expectIdle(page);
  });

  test('web: search card, then a permissioned fetch', async ({ page }) => {
    await sendPrompt(page, 'do a web search for vitest');
    const search = toolCard(page, 'web').filter({ hasText: 'Searched the web' });
    await expect(search).toContainText('vitest mock timers');
    await expect(permission(page)).toContainText('Claude wants to fetch vitest.dev');
    await permission(page).getByRole('button', { name: 'Allow once' }).click();
    await expect(toolCard(page, 'web').filter({ hasText: 'Fetched' })).toContainText('vitest.dev');
    await expect(page.locator('.msg-assistant').last()).toContainText('Use vi.useFakeTimers() to control time in tests.');
    await expectIdle(page);
  });

  test('error: a failed turn shows the error banner', async ({ page }) => {
    await sendPrompt(page, 'trigger an error now');
    const banner = page.locator('.banner.error');
    await expect(banner).toContainText('Something went wrong');
    await expect(banner).toContainText('Mock error: something went wrong');
    await expectIdle(page);
  });
});

test.describe('ask and plan review cards', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await newSessionInProject(page);
  });

  test('question card: answer both questions and the agent receives them', async ({ page }) => {
    await sendPrompt(page, 'ask me something');
    const asked = toolCard(page, 'ask');
    await expect(asked.locator('.tool-title')).toHaveText('Claude has a question');
    await expect(asked.getByText('Which test runner should I use?')).toBeVisible();
    const submit = page.getByRole('button', { name: /Submit answers?/ });
    await expect(submit).toBeDisabled();
    await page.getByRole('radio', { name: /^vitest/ }).click();
    await expect(page.getByRole('radio', { name: /^vitest/ })).toHaveAttribute('aria-checked', 'true');
    await expect(submit).toBeDisabled();
    await page.getByRole('radio', { name: /^vitest/ }).click();
    await expect(submit).toBeDisabled();
    await page.getByRole('checkbox', { name: /^lint/ }).click();
    await expect(submit).toBeEnabled();
    await page.getByRole('checkbox', { name: /^types/ }).click();
    await page.getByRole('checkbox', { name: /^e2e/ }).click();
    await expect(page.getByRole('checkbox', { name: /^e2e/ })).toHaveAttribute('aria-checked', 'true');
    await submit.click();
    await expect(page.locator('.msg-assistant').last()).toContainText('Thanks! Your answers:');
    await expect(page.locator('.msg-assistant').last()).toContainText('vitest');
    await expect(page.locator('.msg-assistant').last()).toContainText('lint, types, e2e');
    await expectIdle(page);
  });

  test('question card: skipping tells the agent the question was dismissed', async ({ page }) => {
    await sendPrompt(page, 'ask me to skip');
    await expect(toolCard(page, 'ask').locator('.tool-title')).toHaveText('Claude has a question');
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(page.locator('.msg-assistant').last()).toContainText('Question was dismissed.');
    await expectIdle(page);
  });

  test('plan card: approve the plan and the agent continues', async ({ page }) => {
    await sendPrompt(page, 'make a plan for it');
    const card = toolCard(page, 'plan');
    await expect(card).toContainText('awaiting your review');
    await expect(card).toContainText('Add farewell export');
    await page.getByRole('button', { name: 'Approve plan' }).click();
    await expect(page.locator('.msg-assistant').last()).toContainText('Plan approved, starting work.');
    await expectIdle(page);
  });

  test('plan card: keep planning with feedback sends the rejection back', async ({ page }) => {
    await sendPrompt(page, 'make a plan first');
    await page.getByRole('button', { name: 'Keep planning…' }).click();
    await page.getByPlaceholder('What should change in the plan?').fill('Split the test into its own step');
    await page.getByRole('button', { name: 'Send feedback' }).click();
    await expect(page.locator('.msg-assistant').last()).toContainText('Plan rejected; staying in plan mode.');
    await expectIdle(page);
  });
});
