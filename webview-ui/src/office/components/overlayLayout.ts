/**
 * Keeping the town's small overlays apart: FNT chips and one-line labels are
 * nudged up until none overlaps another. Pure and DOM-free (Node-tested).
 */

/** An overlay box in screen px, hanging from (cx, bottom). */
export interface OverlayBox {
  id: number;
  cx: number;
  bottom: number;
  w: number;
  h: number;
}

/**
 * How far (px, upward) to lift each box so no two overlap: the lowest box on
 * screen stays put and every box above it that would overlap one already
 * placed moves up to sit just over it, `gap` px apart. Greedy, lowest first,
 * so the nearest overlay to its character moves least.
 */
export function liftOverlapping(boxes: readonly OverlayBox[], gap = 1): Map<number, number> {
  const order = [...boxes].sort((a, b) => b.bottom - a.bottom || a.cx - b.cx || a.id - b.id);
  const placed: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  const lifts = new Map<number, number>();
  for (const box of order) {
    const left = box.cx - box.w / 2;
    const right = box.cx + box.w / 2;
    let bottom = box.bottom;
    for (let moved = true; moved;) {
      moved = false;
      for (const p of placed) {
        const top = bottom - box.h;
        if (left < p.right && p.left < right && top < p.bottom && p.top < bottom) {
          bottom = p.top - gap;
          moved = true;
        }
      }
    }
    placed.push({ left, right, top: bottom - box.h, bottom });
    lifts.set(box.id, box.bottom - bottom);
  }
  return lifts;
}
