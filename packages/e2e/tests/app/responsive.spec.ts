import { closeDrawers, composer, expect, expectIdle, newSessionInProject, openApp, openInspector, openSidebar, sendPrompt, test } from '../../support/app.ts';
import type { Locator, Page } from '@playwright/test';

/**
 * Scrutiniser pass 2, B1 / B2 / B3: popovers anchor to their trigger, toasts never cover the composer, and the layout
 * has real breakpoints (inspector overlay <= 1100px, sidebar drawer <= 800px) with nothing overlapping at any width.
 */
const box = async (l: Locator) => { const b = await l.boundingBox(); if (!b) throw new Error('element has no box'); return b; };
const intersects = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1;

async function start(page: Page, width: number, height = 860) {
  await page.setViewportSize({ width, height });
  await openApp(page);
  await newSessionInProject(page);
  await closeDrawers(page);
}

test.describe('B1: popovers anchor to their trigger', () => {
  for (const width of [1480, 1100, 800, 560, 360]) {
    test(`composer mode / model / effort menus open at their chip, ${width}px`, async ({ page }) => {
      await start(page, width);
      const chips = page.locator('.composer-chips .chip-btn');
      for (let i = 0; i < 3; i++) {
        const chip = await box(chips.nth(i));
        await chips.nth(i).click();
        const menu = page.getByRole('menu');
        await expect(menu).toBeVisible();
        const m = await box(page.locator('.popover').last());
        // left-aligned with the chip, or clamped inside the window when the menu is wider than the room to its right
        const expectedLeft = Math.max(8, Math.min(chip.x, width - m.width - 8));
        expect(Math.abs(m.x - expectedLeft), `menu ${i} left ${m.x} vs ${expectedLeft}`).toBeLessThanOrEqual(2);
        expect(m.x).toBeGreaterThanOrEqual(8 - 0.5);
        expect(m.x + m.width).toBeLessThanOrEqual(width - 8 + 0.5);
        // directly above (composer is at the bottom) or below the chip, never far away
        const gapAbove = chip.y - (m.y + m.height), gapBelow = m.y - (chip.y + chip.height);
        expect(Math.min(Math.abs(gapAbove), Math.abs(gapBelow)), `menu ${i} vertical gap`).toBeLessThanOrEqual(14);
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
      }
    });
  }

  for (const width of [1480, 800, 560]) {
    test(`the Appearance popover opens at its button, ${width}px`, async ({ page }) => {
      await start(page, width);
      await openSidebar(page);
      const btn = page.getByRole('button', { name: 'Appearance' });
      const b = await box(btn);
      await btn.click();
      const pop = page.locator('.popover.appearance');
      await expect(pop).toBeVisible();
      const m = await box(pop);
      expect(m.x).toBeGreaterThanOrEqual(7.5);
      expect(m.x + m.width).toBeLessThanOrEqual(width - 7.5);
      expect(Math.abs(m.x - Math.max(8, Math.min(b.x, width - m.width - 8)))).toBeLessThanOrEqual(2);
      expect(Math.min(Math.abs(b.y - (m.y + m.height)), Math.abs(m.y - (b.y + b.height)))).toBeLessThanOrEqual(14);
      // the trigger toggles (it is not an "outside click" that closes and instantly reopens)
      await btn.click();
      await expect(pop).toHaveCount(0);
    });
  }
});

test.describe('B2: toasts never cover the composer, inspector tabs or commit box', () => {
  for (const width of [1480, 1100, 800]) {
    for (const sidebar of ['shown', 'hidden'] as const) {
      test(`${width}px, sidebar ${sidebar}`, async ({ page }) => {
        await start(page, width);
        await openInspector(page, 'changes');
        if (width > 1100) await expect(page.locator('.ccommit')).toBeVisible();
        if (sidebar === 'hidden') { await closeDrawers(page); if (await page.getByRole('complementary', { name: 'Sessions' }).isVisible()) await page.keyboard.press('Control+b'); }
        if (width > 1100) await expect(page.getByRole('complementary', { name: 'Sessions' })).toHaveCount(sidebar === 'shown' ? 1 : 0);
        for (let i = 0; i < 3; i++) {
          await page.keyboard.press('Control+,');
          await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
          await expect(page.getByRole('dialog')).toHaveCount(0);
        }
        const toasts = page.locator('.toast');
        await expect(toasts).toHaveCount(3);
        const protectedBoxes: [string, Locator][] = [['composer', page.locator('.composer')], ['inspector tabs', page.locator('.itabs')], ['commit box', page.locator('.ccommit')]];
        for (let i = 0; i < 3; i++) {
          const t = await box(toasts.nth(i));
          expect(t.x).toBeGreaterThanOrEqual(0); expect(t.x + t.width).toBeLessThanOrEqual(width + 0.5); expect(t.y + t.height).toBeLessThanOrEqual(860 + 0.5);
          for (const [name, loc] of protectedBoxes) {
            if (!(await loc.count()) || !(await loc.first().isVisible())) continue;
            expect(intersects(t, await box(loc.first())), `toast ${i} covers the ${name}`).toBe(false);
          }
          if (sidebar === 'shown' && width > 800) {
            // stays inside the sidebar column: it must not stick out into the conversation
            const s = await box(page.getByRole('complementary', { name: 'Sessions' }));
            expect(t.x + t.width, 'toast overhangs the sidebar').toBeLessThanOrEqual(s.x + s.width + 0.5);
          }
        }
      });
    }
  }
});

test.describe('B3: responsive layout', () => {
  for (const width of [1480, 1100, 800, 560, 360]) {
    test(`${width}px: no horizontal scroll, drawers, ellipsized steps, usable composer and permission buttons`, async ({ page }) => {
      await start(page, width);
      const noHScroll = () => page.evaluate(() => { const s = document.scrollingElement!; const shell = document.querySelector('.shell')!; return s.scrollWidth <= s.clientWidth + 1 && shell.scrollWidth <= shell.clientWidth + 1; });
      expect(await noHScroll()).toBe(true);

      // panes: sidebar docked above 800px, inspector docked above 1100px, overlays below
      const sidebarDrawer = width <= 800, inspectorDrawer = width <= 1100;
      const side = page.getByRole('complementary', { name: 'Sessions' });
      if (sidebarDrawer) {
        await expect(side).toHaveCount(0);
        await page.getByRole('button', { name: 'Open sessions menu' }).click();
        await expect(side).toBeVisible();
        expect(await side.evaluate((e) => getComputedStyle(e).position)).toBe('absolute');
        await page.getByTestId('sidebar-scrim').click({ position: { x: width - 4, y: 300 } });
        await expect(side).toHaveCount(0);
      } else {
        expect(await side.evaluate((e) => getComputedStyle(e).position)).not.toBe('absolute');
      }
      const mainW = (await box(page.locator('main.main'))).width;
      await openInspector(page);
      const insp = page.getByRole('complementary', { name: 'Inspector' });
      expect(await insp.evaluate((e) => getComputedStyle(e).position)).toBe(inspectorDrawer ? 'absolute' : 'static');
      // the conversation keeps its width when the inspector is an overlay; docked it keeps at least ~480px
      const mainWithInsp = (await box(page.locator('main.main'))).width;
      if (inspectorDrawer) expect(Math.abs(mainWithInsp - mainW)).toBeLessThanOrEqual(1); else expect(mainWithInsp).toBeGreaterThanOrEqual(480);
      expect(await noHScroll()).toBe(true);
      await page.getByRole('button', { name: 'Close inspector' }).click();
      await expect(insp).toHaveCount(0);

      // tool steps ellipsize instead of painting over each other; the permission buttons are on screen and work
      await sendPrompt(page, 'web please');
      const allow = page.locator('[data-perm-allow]');
      await expect(allow).toBeVisible();
      const ab = await box(allow);
      expect(ab.x).toBeGreaterThanOrEqual(0); expect(ab.x + ab.width).toBeLessThanOrEqual(width + 0.5);
      const heads = page.locator('.steps > * ');
      const n = await heads.count();
      const boxes = [];
      for (let i = 0; i < n; i++) boxes.push(await box(heads.nth(i)));
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(intersects(boxes[i], boxes[j]), `step ${i} overlaps step ${j}`).toBe(false);
      const titles = await page.locator('.tool-title').evaluateAll((els) => els.map((e) => { const cs = getComputedStyle(e); return { spill: e.scrollWidth > e.clientWidth + 1 && !(cs.overflow === 'hidden' && cs.textOverflow === 'ellipsis') }; }));
      expect(titles.filter((t) => t.spill)).toEqual([]);
      await allow.click();
      await expectIdle(page);

      // composer: a real text area (not an 8px sliver), chips reachable, Send works
      const ta = composer(page);
      expect((await box(ta)).width).toBeGreaterThanOrEqual(width <= 360 ? 160 : 220);
      await ta.fill('hello at this width');
      const send = page.getByRole('button', { name: 'Send message' });
      expect(intersects(await box(send), await box(ta))).toBe(false);
      await send.click();
      await expect(page.locator('.msg-user').filter({ hasText: 'hello at this width' })).toBeVisible();
      expect(await noHScroll()).toBe(true);
    });
  }
});
