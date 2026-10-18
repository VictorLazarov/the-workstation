import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '../../support/app.ts';
import { makeRepo, newRealSession, openReal, REAL, realTurn, shot, startRealServer, type RealServer } from '../../support/real.ts';
import { repoRoot } from '../../support/env.ts';

/** REAL SDK (REAL_SDK=1): MCP servers (good + failing), tool cards, permission handling, and subagents with Stop. */
test.skip(!REAL, 'set REAL_SDK=1 to run against the real Claude Agent SDK');
test.describe.configure({ mode: 'serial', timeout: 240_000 });

let srv: RealServer;
test.beforeAll(async () => {
  const repo = makeRepo('mcp', (dir) => {
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {
      mini: { command: 'node', args: [path.join(repoRoot, 'packages/server/scripts/mini-mcp.mjs')] },
      broken: { command: 'node', args: ['-e', 'process.exit(3)'] },
      missing: { command: '/nonexistent/binary-xyz' },
    } }));
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude/settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
  });
  srv = await startRealServer(repo, { defaultPermissionMode: 'default' });
});
test.afterAll(async () => { await srv?.stop(); });

test('MCP: connected / failed with the real error, a tool call renders as a card, permission prompt + Always allow', async ({ page }) => {
  await openReal(page, srv);
  await newRealSession(page);
  // a draft has not started a session yet, so it does not pretend to know its servers
  await page.locator('.itab[data-panel="context"]').click();
  await expect(page.locator('.ctxp')).toContainText('MCP servers connect when the session starts');
  // the tool call: permission card, then a proper tool card with the result
  const box = page.getByRole('textbox', { name: 'Message Claude' });
  await box.fill('Call the ping tool of the mini MCP server and tell me its output.');
  await box.press('Enter');
  await expect(page.locator('[data-perm-allow]').first()).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('.perm')).toContainText('mcp__mini__ping');
  await shot(page, 'mcp-permission');
  await page.getByRole('button', { name: 'Always allow' }).click();
  await expect(page.locator('.result-line')).toHaveCount(1, { timeout: 90_000 });
  const card = page.locator('.tool', { hasText: 'ping' }).first();
  await expect(card).toContainText('mini');
  await card.locator('.tool-head').click();
  await expect(card).toContainText('pong-42');
  await expect(page.locator('.msg-assistant').last()).toContainText('pong-42');
  // once started, the panel shows each server's real state
  const list = page.locator('.mcp-list');
  await expect(list.locator('.mcp', { hasText: 'mini' })).toContainText('connected');
  await expect(list.locator('.mcp', { hasText: 'broken' })).toContainText(/failed: .*closed/i);
  await expect(list.locator('.mcp', { hasText: 'missing' })).toContainText(/failed: ENOENT/);
  await shot(page, 'mcp-panel');
  // second call: remembered, no prompt
  const prompts = await realTurn(page, 'Call the ping tool of the mini MCP server again and tell me its output.');
  expect(prompts).toBe(0);
  expect(fs.readFileSync(path.join(srv.repo, '.claude/settings.local.json'), 'utf8')).toContain('mcp__mini__ping');
  await shot(page, 'mcp-thread');
});

test('subagent: Task card, Tasks panel (running -> nested progress), Stop ends it and the main agent carries on', async ({ page }) => {
  // its own server in bypass mode: the subagent's Bash would otherwise ask for permission and this test is about the task UI
  const srv2 = await startRealServer(makeRepo('task'), { defaultPermissionMode: 'bypassPermissions' });
  try { await subagentFlow(page, srv2); } finally { await srv2.stop(); }
});

async function subagentFlow(page: import('@playwright/test').Page, srv: RealServer) {
  await openReal(page, srv);
  await newRealSession(page);
  await page.getByRole('textbox', { name: 'Message Claude' }).fill('Use the Task tool (subagent_type general-purpose) to spawn a subagent whose only job is to run exactly this bash command: python3 -c "import time; time.sleep(90)" and then report slept. Wait for it.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.locator('.itab[data-panel="tasks"]').click();
  const agentRow = page.locator('.task-row', { hasText: 'general-purpose' });
  await expect(agentRow).toContainText('Running', { timeout: 90_000 });
  await expect(page.locator('.task-row', { hasText: 'Background task' })).toContainText('Running', { timeout: 60_000 }); // its Bash, started in the background
  // nested progress inside the conversation card
  await page.locator('.tool').filter({ hasText: 'general-purpose' }).first().locator('.tool-head').first().click();
  await expect(page.locator('.tool').filter({ hasText: 'general-purpose' }).first()).toContainText(/Sleep|sleep/);
  await shot(page, 'subagent-running');
  await page.getByRole('button', { name: 'Stop general-purpose' }).click();
  await expect(agentRow).toContainText('Stopped', { timeout: 30_000 });
  await expect(page.locator('.task-row', { hasText: 'Background task' })).toContainText('Stopped');
  await expect(page.locator('.result-line').first()).toBeVisible({ timeout: 90_000 }); // the main agent finished its turn
  await expect(page.locator('.banner.error')).toHaveCount(0);
  await shot(page, 'subagent-stopped');
}
