import { describe, expect, it } from 'vitest';
import { placePopover } from './popover';

const vp = { w: 1480, h: 900 };
const rect = (left: number, top: number, w = 90, h = 24) => ({ left, top, right: left + w, bottom: top + h });

describe('placePopover (B1: menus anchor to their trigger at every width)', () => {
  it('opens above a chip near the bottom, left-aligned with it (not at the window edge)', () => {
    const p = placePopover(rect(326, 870), { w: 300, h: 240 }, vp);
    expect(p.placement).toBe('above');
    expect(p.left).toBe(326);
    expect(p.top).toBe(870 - 6 - 240);
  });
  it('opens below a trigger near the top', () => {
    const p = placePopover(rect(40, 10), { w: 200, h: 200 }, vp);
    expect(p.placement).toBe('below');
    expect(p.top).toBe(10 + 24 + 6);
  });
  it('clamps to the right edge of the viewport and never goes left of the margin', () => {
    expect(placePopover(rect(1400, 100), { w: 300, h: 100 }, vp).left).toBe(1480 - 300 - 8);
    expect(placePopover(rect(-30, 100), { w: 300, h: 100 }, vp).left).toBe(8);
  });
  it('aligns the right edges with align=end', () => {
    expect(placePopover(rect(500, 100), { w: 250, h: 100 }, vp, 'end').left).toBe(590 - 250);
  });
  it('a popover wider than a phone viewport stays inside it', () => {
    const p = placePopover(rect(200, 800), { w: 330, h: 300 }, { w: 360, h: 640 });
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + 330).toBeLessThanOrEqual(360 - 8 + 0.001);
  });
  it('keeps tall menus on screen by clamping the top', () => {
    const p = placePopover(rect(10, 300), { w: 200, h: 700 }, { w: 800, h: 640 });
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
});
