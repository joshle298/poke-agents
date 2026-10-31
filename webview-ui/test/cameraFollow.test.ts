/**
 * Following a character in the town never shows empty canvas the map could
 * fill: per axis, a map that fits stays centred and a larger one stops at its
 * edges.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { clampPanAxis, mapOffset } from '../src/office/projection.js';

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
