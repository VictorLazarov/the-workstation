import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { expect, test } from '../../support/app.ts';
import { makeRepo, newRealSession, openReal, REAL, realTurn, shot, startRealServer, trackResults, type RealServer } from '../../support/real.ts';

/** REAL SDK (REAL_SDK=1): image attachments, switching to sonnet mid-session, and several sessions at once. */
test.skip(!REAL, 'set REAL_SDK=1 to run against the real Claude Agent SDK');
test.describe.configure({ mode: 'serial', timeout: 300_000 });

let srv: RealServer;
let repo: string;
test.beforeAll(async () => { repo = makeRepo('misc'); srv = await startRealServer(repo); });
test.afterAll(async () => { await srv?.stop(); });

function bluePng(): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let x = 0xffffffff; for (const v of b) x = table[(x ^ v) & 255]! ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(96, 0); ihdr.writeUInt32BE(96, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 96 }, () => [30, 60, 220]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: 96 }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

test('images: attach by file and by paste/drop, the vision model answers, the thread shows the image, also after a reload', async ({ page }, info) => {
  const file = path.join(info.outputPath(), 'blue.png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bluePng());
  await openReal(page, srv);
  await newRealSession(page);
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.locator('.attach img')).toHaveCount(1);
  await realTurn(page, 'What single color dominates this image? Answer with one word.');
  await expect(page.locator('.msg-assistant').last()).toContainText(/blue/i);
  const img = page.locator('.msg-user img.msg-img').first();
  await expect(img).toBeVisible();
  expect(await img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(96);
  // paste and drop go through the same attach path
  await page.evaluate(() => {
    const bin = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
    const f = new File([Uint8Array.from(bin, (c) => c.charCodeAt(0))], 'pasted.png', { type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(f);
    document.querySelector('textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    document.querySelector('.composer')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.attach img')).toHaveCount(2);
  await shot(page, 'images-attached');
  await page.reload();
  await expect(page.locator('.msg-user img.msg-img').first()).toBeVisible();
});

test('model: switch to Sonnet mid-session, the API bills sonnet for that turn, and switch back', async ({ page }) => {
  await openReal(page, srv);
  const results = trackResults(page);
  await page.reload(); // attach the tracker before the socket opens
  await newRealSession(page);
  await realTurn(page, 'Reply with exactly: one');
  const model = page.locator('.composer-chips .chip-btn').nth(1);
  await expect(model).toContainText('Haiku 5.5');
  await model.click();
  await page.locator('.menu-item').filter({ hasText: /^Sonnet/ }).first().click();
  await expect(model).toContainText('Sonnet');
  await realTurn(page, 'Reply with exactly: two');
  expect(results.at(-1)!.models).toContain('claude-sonnet-5-5');
  await shot(page, 'model-sonnet');
  await model.click();
  await page.locator('.menu-item').filter({ hasText: /^Haiku/ }).first().click();
  await expect(model).toContainText('Haiku');
  await realTurn(page, 'Reply with exactly: three');
  await expect(page.locator('.msg-assistant').last()).toContainText('three');
});

test('parallel: five sessions at once keep their own status, no cross-talk, attention rows are right', async ({ page }) => {
  await openReal(page, srv);
  const prompts: Array<[string, string]> = [
    ['ALPHA', 'Reply with exactly the single word ALPHA and nothing else.'],
    ['BRAVO', 'Run the bash command `echo BRAVO > bravo.txt` with the Bash tool. Then reply BRAVO-DONE.'],
    ['CHARLIE', 'Count from 1 to 40 separated by single spaces, then write CHARLIE at the end.'],
    ['DELTA', 'Reply with exactly the single word DELTA and nothing else.'],
    ['ECHO', 'Run the bash command `echo ECHO > echo.txt` with the Bash tool. Then reply ECHO-DONE.'],
  ];
  await newRealSession(page);
  for (let i = 0; i < prompts.length; i++) {
    if (i > 0) await page.getByRole('button', { name: /^New session in/ }).first().click();
    await expect(page.getByRole('heading', { name: 'What should we work on?' })).toBeVisible();
    const box = page.getByRole('textbox', { name: 'Message Claude' });
    await box.fill(prompts[i]![1]);
    await box.press('Enter');
  }
  const row = (t: string) => page.locator('.sess', { hasText: t });
  await expect(page.locator('.sess.attn')).toHaveCount(2, { timeout: 90_000 });
  await expect(row('echo BRAVO')).toHaveClass(/attn/);
  await expect(row('echo ECHO')).toHaveClass(/attn/);
  await expect(row('word ALPHA').locator('.sess-st')).toHaveAttribute('title', /Finished, unread|^$/);
  await expect(page.locator('.sess.run')).toHaveCount(0, { timeout: 60_000 });
  await shot(page, 'parallel-attention');
  // answer both requests; nothing else changes state
  for (let k = 0; k < 2; k++) {
    await page.locator('.sess.attn').first().click();
    await page.locator('[data-perm-allow]').first().click();
    await page.waitForTimeout(1500);
  }
  await expect(page.locator('.sess.attn')).toHaveCount(0, { timeout: 60_000 });
  // every thread holds only its own marker
  const markers = prompts.map((p) => p[0]);
  const n = await page.locator('.sess').count();
  expect(n).toBeGreaterThanOrEqual(5);
  for (let i = 0; i < n; i++) {
    await page.locator('.sess').nth(i).click();
    const txt = await page.locator('.conv').innerText();
    const own = markers.filter((m) => txt.includes(m));
    expect(own, `thread ${i}`).toHaveLength(1);
  }
});
