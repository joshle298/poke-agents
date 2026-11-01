/**
 * The ground is cached in chunks of about GROUND_CHUNK_PX device px, and only
 * the chunks in view are drawn: a town larger than the window costs what the
 * window shows, at any zoom.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { GROUND_CHUNK_PX } from '../src/constants.js';
import { groundChunkTiles, visibleGroundChunks } from '../src/office/engine/renderer.js';
import { TILE_SIZE } from '../src/office/types.js';

test('a chunk is about GROUND_CHUNK_PX a side at every zoom', () => {
  for (let zoom = 1; zoom <= 10; zoom++) {
    const px = groundChunkTiles(zoom) * TILE_SIZE * zoom;
    assert.ok(px >= GROUND_CHUNK_PX * 0.8 && px <= GROUND_CHUNK_PX * 1.2, `zoom ${zoom}: ${px}`);
  }
});

test('only the chunks in view are drawn, clipped to the map', () => {
  // The 56×38 town at zoom 4 (16-tile chunks of 1024 px) in a 2400×1800 view.
  const zoom = 4;
  const size = groundChunkTiles(zoom);
  assert.equal(size, 16);
  // Panned to its top-left corner: chunks 0..2 across, 0..1 down.
  assert.deepEqual(visibleGroundChunks(0, 0, 2400, 1800, 56, 38, zoom, size), {
    c0: 0,
    r0: 0,
    c1: 2,
    r1: 1,
  });
  // Panned to its bottom-right (632 px of the map above the view): the last
  // chunks, never past the map.
  const mapW = 56 * TILE_SIZE * zoom;
  const mapH = 38 * TILE_SIZE * zoom;
  assert.deepEqual(visibleGroundChunks(2400 - mapW, 1800 - mapH, 2400, 1800, 56, 38, zoom, size), {
    c0: 1,
    r0: 0,
    c1: 3,
    r1: 2,
  });
  // A map smaller than the view, centred: all of it.
  assert.deepEqual(visibleGroundChunks(300, 200, 2400, 1800, 20, 10, 2, groundChunkTiles(2)), {
    c0: 0,
    r0: 0,
    c1: 0,
    r1: 0,
  });
  // Panned right off the view: nothing.
  assert.equal(visibleGroundChunks(5000, 0, 2400, 1800, 20, 10, 2, groundChunkTiles(2)), null);
});
