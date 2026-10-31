/**
 * Tall grass: floor pixels marked foreground (alpha 254) are drawn again in
 * front of whoever stands in them. Which pixels, split how, and which tiles
 * get drawn for a set of characters and pets. Plus the bundled tall-grass
 * pattern really carries the marker and plain grass does not.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { test } from 'vitest';

import { rgbaToHex } from '../../core/src/assets/colorUtils.ts';
import { decodeFloorPng } from '../../core/src/assets/pngDecoder.ts';
import { FLOOR_FOREGROUND_BELOW_ROW } from '../src/constants.js';
import {
  foregroundPieces,
  hasForegroundPixels,
  isForegroundPixel,
  splitFloorForeground,
} from '../src/office/floorForeground.js';
import type { SpriteData } from '../src/office/types.js';
import { ASSETS_DIR } from './worldFixtures.js';

const GRAY = rgbaToHex(128, 128, 128, 255);
const GRAY_FOREGROUND = rgbaToHex(128, 128, 128, 254);

/** A 16×16 gray sprite, foreground at the given rows. */
function tile(foregroundRows: number[]): SpriteData {
  return Array.from({ length: 16 }, (_, r) =>
    Array.from({ length: 16 }, () => (foregroundRows.includes(r) ? GRAY_FOREGROUND : GRAY)),
  );
}

test('only alpha-254 pixels are foreground', () => {
  assert.equal(isForegroundPixel(rgbaToHex(18, 171, 52, 254)), true);
  assert.equal(isForegroundPixel(rgbaToHex(18, 171, 52, 254).toLowerCase()), true);
  assert.equal(isForegroundPixel(rgbaToHex(18, 171, 52, 255)), false);
  assert.equal(isForegroundPixel(rgbaToHex(18, 171, 52, 128)), false);
  assert.equal(isForegroundPixel(''), false);
  assert.equal(hasForegroundPixels(tile([])), false);
  assert.equal(hasForegroundPixels(tile([3])), true);
});

test('the foreground splits at FLOOR_FOREGROUND_BELOW_ROW and comes out opaque', () => {
  const { own, below } = splitFloorForeground(tile([0, 9, FLOOR_FOREGROUND_BELOW_ROW, 15]));
  assert.ok(own && below);
  assert.equal(own[0][0], GRAY);
  assert.equal(own[9][5], GRAY);
  assert.equal(own[FLOOR_FOREGROUND_BELOW_ROW][0], '', 'tips belong to the tile below');
  assert.equal(own[5][0], '', 'unmarked rows stay empty');
  assert.equal(below[FLOOR_FOREGROUND_BELOW_ROW][3], GRAY);
  assert.equal(below[15][3], GRAY);
  assert.equal(below[0][0], '');
  const none = splitFloorForeground(tile([2]));
  assert.equal(none.below, null, 'an empty half is null');
});

test('pieces: an entity in tall grass gets its tile, its side neighbors and the tips above', () => {
  // Tall grass everywhere in columns 2..6, rows 2..6.
  const grass = (c: number, r: number) => c >= 2 && c <= 6 && r >= 2 && r <= 6;
  const pieces = foregroundPieces([{ tileCol: 4, tileRow: 4, path: [] }], grass);
  const keys = pieces.map((p) => `${p.part}:${p.col},${p.row}@${p.zRow}`).sort();
  assert.deepEqual(keys, [
    'below:3,3@4',
    'below:4,3@4',
    'below:5,3@4',
    'own:3,4@4',
    'own:4,4@4',
    'own:5,4@4',
  ]);
});

test('pieces: nothing for an entity outside tall grass, edges clip to grass tiles', () => {
  const grass = (c: number, r: number) => c === 4 && r === 4;
  assert.deepEqual(foregroundPieces([{ tileCol: 1, tileRow: 1, path: [] }], grass), []);
  const alone = foregroundPieces([{ tileCol: 4, tileRow: 4, path: [] }], grass);
  assert.deepEqual(
    alone.map((p) => `${p.part}:${p.col},${p.row}`),
    ['own:4,4'],
  );
});

test('pieces: a walker stepping into the grass is covered by its next tile, once per piece', () => {
  const grass = (c: number, r: number) => c === 4 && (r === 4 || r === 5);
  const walker = { tileCol: 4, tileRow: 3, path: [{ col: 4, row: 4 }] };
  const stander = { tileCol: 4, tileRow: 4, path: [] };
  const pieces = foregroundPieces([walker, stander], grass);
  assert.deepEqual(
    pieces.map((p) => `${p.part}:${p.col},${p.row}@${p.zRow}`),
    ['own:4,4@4'],
  );
  const below = foregroundPieces([{ tileCol: 4, tileRow: 5, path: [] }], grass);
  assert.deepEqual(
    below.map((p) => `${p.part}:${p.col},${p.row}@${p.zRow}`),
    ['own:4,5@5', 'below:4,4@5'],
  );
});

test('the bundled tall grass marks its blades as foreground; plain grass does not', () => {
  const read = (file: string) =>
    decodeFloorPng(fs.readFileSync(path.join(ASSETS_DIR, 'floors', file)));
  const tall = splitFloorForeground(read('floor_11.png'));
  assert.ok(tall.own, 'blade bodies cover the tile’s own occupant');
  assert.ok(tall.below, 'blade tips cover the occupant of the tile below');
  for (const file of ['floor_0.png', 'floor_9.png', 'floor_10.png', 'floor_12.png']) {
    assert.equal(hasForegroundPixels(read(file)), false, `${file} has no foreground`);
  }
});
