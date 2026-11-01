/**
 * Following a character in the town never shows empty canvas the map could
 * fill: per axis, a map that fits stays centred and a larger one stops at its
 * edges. A zoom keeps the point under the cursor (or the view's centre) where
 * it is, and a town larger than the window starts on its home view.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  clampManualPan,
  clampPanAxis,
  mapOffset,
  panForZoom,
  panToCentre,
} from '../src/office/projection.js';
import { TILE_SIZE } from '../src/office/types.js';

/** Where world point (x, y) lands on the canvas (device px). */
function onScreen(
  view: { w: number; h: number },
  layout: { cols: number; rows: number },
  zoom: number,
  pan: { x: number; y: number },
  point: { x: number; y: number },
): { x: number; y: number } {
  const { offsetX, offsetY } = mapOffset(
    view.w,
    view.h,
    layout.cols,
    layout.rows,
    zoom,
    pan.x,
    pan.y,
  );
  return { x: offsetX + point.x * zoom, y: offsetY + point.y * zoom };
}

test('an axis the map fits stays centred, whatever the target', () => {
  // The town at zoom 2 is 864 px tall in a 900 px canvas.
  assert.equal(clampPanAxis(300, 864, 900), 0);
  assert.equal(clampPanAxis(-300, 864, 900), 0);
});

test('an axis the map overflows follows the target up to the map edge', () => {
  const map = 1184;
  const view = 700;
  assert.equal(clampPanAxis(100, map, view), 100, 'inside the slack: follows');
  assert.equal(clampPanAxis(1000, map, view), 242);
  assert.equal(clampPanAxis(-1000, map, view), -242);
  // At the limit, the map's edges sit exactly on the canvas edges.
  const left = mapOffset(view, 900, 37, 27, 2, clampPanAxis(1000, map, view), 0).offsetX;
  assert.equal(left, 0, 'left edge on the canvas edge');
  const right = mapOffset(view, 900, 37, 27, 2, clampPanAxis(-1000, map, view), 0).offsetX;
  assert.equal(right + map, view, 'right edge on the canvas edge');
});

test('a manual pan in the town is clamped per axis too; elsewhere it keeps the edit margin', () => {
  const map = { w: 1184, h: 864 };
  const view = { w: 700, h: 900 };
  const town = { tight: true, marginFraction: 0.25 };
  // Wheel far to the right: stops where the map's left edge meets the canvas.
  assert.deepEqual(clampManualPan({ x: 5000, y: 300 }, map, view, town), { x: 242, y: 0 });
  assert.deepEqual(clampManualPan({ x: -5000, y: -300 }, map, view, town), { x: -242, y: 0 });
  // The classic office (or the editor) may still pull the map partly away.
  const loose = clampManualPan({ x: 5000, y: 5000 }, map, view, { ...town, tight: false });
  assert.deepEqual(loose, { x: 1184 / 2 + 350 - 175, y: 864 / 2 + 450 - 225 });
});

test('a zoom keeps the point under the cursor in place; the buttons keep the centre', () => {
  const view = { w: 1200, h: 900 };
  const layout = { cols: 56, rows: 38 };
  const pan = { x: 400, y: -120 };
  const cursor = { x: 300, y: 650 }; // canvas px
  const anchor = { x: cursor.x - view.w / 2, y: cursor.y - view.h / 2 };
  // The world point under the cursor at zoom 2…
  const before = onScreen(view, layout, 2, pan, { x: 0, y: 0 });
  const world = { x: (cursor.x - before.x) / 2, y: (cursor.y - before.y) / 2 };
  // …is still under it at zoom 3 (within the renderer's whole-pixel rounding).
  const after = onScreen(view, layout, 3, panForZoom(pan, 2, 3, anchor), world);
  assert.ok(
    Math.abs(after.x - cursor.x) <= 1 && Math.abs(after.y - cursor.y) <= 1,
    `${after.x},${after.y}`,
  );
  // The centre anchor: the view's middle stays on the same world point.
  const mid = { x: view.w / 2, y: view.h / 2 };
  const o2 = onScreen(view, layout, 2, pan, { x: 0, y: 0 });
  const centre = { x: (mid.x - o2.x) / 2, y: (mid.y - o2.y) / 2 };
  const back = onScreen(view, layout, 4, panForZoom(pan, 2, 4), centre);
  assert.ok(Math.abs(back.x - mid.x) <= 1 && Math.abs(back.y - mid.y) <= 1);
  assert.deepEqual(panForZoom({ x: 0, y: 0 }, 2, 5), { x: 0, y: 0 }, 'a centred map stays centred');
});

test("the home view centres its point, clamped to the map's edges", () => {
  const view = { w: 1200, h: 900 };
  const layout = { cols: 56, rows: 38 };
  // Mid-map: the point lands in the middle of the view.
  const point = { x: 30 * TILE_SIZE, y: 20 * TILE_SIZE };
  const at = onScreen(view, layout, 2, panToCentre(point, layout, 2, view), point);
  assert.ok(Math.abs(at.x - view.w / 2) <= 1 && Math.abs(at.y - view.h / 2) <= 1);
  // Near the top: the map's top edge stays on the canvas's top edge.
  const top = panToCentre({ x: 30 * TILE_SIZE, y: 2 * TILE_SIZE }, layout, 2, view);
  assert.equal(onScreen(view, layout, 2, top, { x: 0, y: 0 }).y, 0);
  // A map that fits stays centred.
  assert.deepEqual(panToCentre(point, { cols: 20, rows: 10 }, 2, view), { x: 0, y: 0 });
});
