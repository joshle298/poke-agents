/**
 * The town's small overlays (FNT chips, one-line labels) are nudged apart:
 * the lowest stays where it is, the ones above it move up just enough.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { liftOverlapping } from '../src/office/components/overlayLayout.js';

test('boxes apart stay put', () => {
  const lifts = liftOverlapping([
    { id: 1, cx: 0, bottom: 100, w: 20, h: 10 },
    { id: 2, cx: 40, bottom: 100, w: 20, h: 10 },
    { id: 3, cx: 0, bottom: 80, w: 20, h: 10 },
  ]);
  assert.deepEqual([...lifts.values()], [0, 0, 0]);
});

test('the lower box stays, the one above it moves up just over it', () => {
  const lifts = liftOverlapping(
    [
      { id: 1, cx: 10, bottom: 95, w: 30, h: 10 },
      { id: 2, cx: 0, bottom: 100, w: 30, h: 10 },
    ],
    1,
  );
  assert.equal(lifts.get(2), 0, 'the lowest stays');
  // Box 1 must end above box 2's top (90) with a 1 px gap: bottom 89.
  assert.equal(lifts.get(1), 95 - 89);
});

test('a pile of overlapping boxes ends as a stack with no overlaps', () => {
  const boxes = [1, 2, 3, 4].map((id) => ({ id, cx: id * 3, bottom: 100 - id, w: 40, h: 12 }));
  const lifts = liftOverlapping(boxes);
  const placed = boxes.map((b) => ({ ...b, bottom: b.bottom - lifts.get(b.id)! }));
  for (const a of placed) {
    for (const b of placed) {
      if (a.id >= b.id) continue;
      const apart = a.bottom <= b.bottom - b.h || b.bottom <= a.bottom - a.h;
      assert.ok(apart, `${a.id} and ${b.id} overlap`);
    }
  }
  for (const b of boxes) assert.ok(lifts.get(b.id)! >= 0, 'only ever up');
});
