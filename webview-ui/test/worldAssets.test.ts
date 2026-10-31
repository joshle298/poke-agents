/**
 * The world's furniture in the real catalog (the Outdoor palette, the fence's
 * rotation, the pond's ambient animation) and the bundled maps the editor's
 * Maps panel loads.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import { BUNDLED_LAYOUTS, prepareBundledLayout } from '../src/office/layout/bundledLayouts.js';
import {
  getActiveCategories,
  getAmbientAnimationFrames,
  getCatalogByCategory,
  getCatalogEntry,
  getRotatedType,
} from '../src/office/layout/furnitureCatalog.js';
import { TILE_SIZE } from '../src/office/types.js';
import { loadBundledCatalog, readBundledLayout, TOWN_LAYOUT_PATH } from './worldFixtures.js';

beforeAll(() => {
  loadBundledCatalog();
});

test('the editor palette has an Outdoor category with the town’s outdoor items', () => {
  const categories = getActiveCategories().map((c) => c.label);
  assert.ok(categories.includes('Outdoor'), categories.join(', '));
  const outdoor = getCatalogByCategory('outdoor').map((e) => e.type);
  for (const type of [
    'TREE',
    'BUSH',
    'FLOWERS',
    'FENCE_FRONT',
    'POND_1',
    'SIGNPOST',
    'LAMP_POST',
  ]) {
    assert.ok(outdoor.includes(type), `${type} in Outdoor`);
  }
  assert.ok(!outdoor.includes('POND_2') && !outdoor.includes('POND_3'), 'one pond, not its frames');
  assert.ok(!outdoor.includes('FENCE_SIDE'), 'one fence; R turns it');
  assert.equal(getCatalogEntry('COUNTER')?.isDesk, true, 'the counter is a desk');
  assert.equal(getCatalogEntry('HEALING_MACHINE')?.canPlaceOnSurfaces, true);
  assert.equal(getCatalogEntry('CENTER_SIGN')?.canPlaceOnWalls, true);
});

test('the fence turns between its horizontal and vertical runs', () => {
  assert.equal(getRotatedType('FENCE_FRONT', 'cw'), 'FENCE_SIDE');
  assert.equal(getRotatedType('FENCE_SIDE', 'cw'), 'FENCE_FRONT');
});

test('the pond is an ambient animation; a PC screen (on/off state) is not', () => {
  assert.deepEqual(getAmbientAnimationFrames('POND_1'), ['POND_1', 'POND_2', 'POND_3']);
  assert.deepEqual(getAmbientAnimationFrames('POND_3'), ['POND_1', 'POND_2', 'POND_3']);
  assert.equal(getAmbientAnimationFrames('PC_FRONT_ON_1'), null);
  assert.equal(getAmbientAnimationFrames('TREE'), null);
});

test('the pond shimmers in the office whether or not anyone is near', () => {
  const town = readBundledLayout(TOWN_LAYOUT_PATH);
  const pond = town.furniture.find((f) => f.type === 'POND_1')!;
  const os = new OfficeState(town);
  const pondSprite = () =>
    os.furniture.find((f) => f.x === pond.col * TILE_SIZE && f.y === pond.row * TILE_SIZE)!.sprite;
  const seen = new Set<unknown>();
  for (let t = 0; t < 2; t += 0.1) {
    os.update(0.1);
    seen.add(pondSprite());
  }
  assert.equal(seen.size, 3, 'all three frames show');
  assert.equal(town.furniture.find((f) => f.uid === pond.uid)?.type, 'POND_1', 'layout untouched');
});

test('both bundled maps load, and loading one keeps the pets already placed', async () => {
  const ids = BUNDLED_LAYOUTS.map((l) => l.id);
  assert.deepEqual(ids, ['town', 'classic']);
  const [town, classic] = await Promise.all(BUNDLED_LAYOUTS.map((l) => l.load()));
  assert.equal(town.cols, 36);
  assert.ok(town.areas?.some((a) => a.role === 'meadow'));
  assert.equal(classic.areas, undefined, 'the classic office has no roles');

  const current = { ...readBundledLayout(TOWN_LAYOUT_PATH), pets: [{ id: 'p1', petType: 0 }] };
  const next = prepareBundledLayout(classic, current);
  assert.deepEqual(next.pets, [{ id: 'p1', petType: 0 }]);
  assert.notEqual(next.tiles, classic.tiles, 'a private copy');
  assert.equal(next.tileColors?.length, next.tiles.length, 'migrated');
  next.tiles[0] = 1;
  const again = prepareBundledLayout(classic, current);
  assert.notEqual(again.tiles[0], 1, 'the bundled layout is never mutated');
});
