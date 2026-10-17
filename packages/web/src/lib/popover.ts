/** Pure placement for anchored popovers (see components/ui.tsx Popover). */
export interface Placement { left: number; top: number; placement: 'below' | 'above' }

/**
 * Anchored to `anchor` (left edge, or right edge with align 'end'), clamped to the viewport with `margin`, and flipped to
 * whichever side has room: below if it fits, else above if it fits, else the roomier side.
 */
export function placePopover(
  anchor: { left: number; right: number; top: number; bottom: number },
  size: { w: number; h: number }, vp: { w: number; h: number }, align: 'start' | 'end' = 'start', gap = 6, margin = 8,
): Placement {
  const left = Math.max(margin, Math.min(align === 'end' ? anchor.right - size.w : anchor.left, vp.w - size.w - margin));
  const roomBelow = vp.h - anchor.bottom - gap - margin;
  const roomAbove = anchor.top - gap - margin;
  const below = size.h <= roomBelow || (size.h > roomAbove && roomBelow >= roomAbove);
  const top = below ? anchor.bottom + gap : anchor.top - gap - size.h;
  return { left, top: Math.max(margin, Math.min(top, vp.h - size.h - margin)), placement: below ? 'below' : 'above' };
}
