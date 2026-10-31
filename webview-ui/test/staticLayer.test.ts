/**
 * The town's static layer: items nothing can be drawn behind (most of the
 * forest around the map) are drawn once with the ground instead of z-sorted
 * every frame. An item a character could stand behind, or one something
 * still z-sorted is drawn before, stays in the z-sorted pass. The classic
 * office has no static layer.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import type { LayerRect } from '../src/office/engine/staticLayer.js';
import { staticLayerItems } from '../src/office/engine/staticLayer.js';
import { tileKey } from '../src/office/layout/areaRoles.js';
import type { OfficeLayout } from '../src/office/types.js';
import {
  CLASSIC_LAYOUT_PATH,
  loadBundledCatalog,
  readBundledLayout,
  TOWN_LAYOUT_PATH,
} from './worldFixtures.js';

const REACH = { halfW: 8, rise: 24, below: 4 };
const tree = (x: number, y: number): LayerRect & { candidate: boolean } => ({
  x,
  y,
  w: 32,
  h: 48,
  zY: y + 48,
  candidate: true,
});

test('an item no character can stand behind joins the layer; one they can does not', () => {
  // A character can stand on row 10 (y 160..176) only.
  const standable = [{ col: 0, row: 10 }];
  const far = tree(200, 0); // nowhere near
  const behind = tree(0, 150); // its bottom (198) is below row 10: it covers them
  const above = tree(0, 100); // ends at y 148: they stand in front of it
  const chosen = staticLayerItems({
    items: [far, behind, above],
    others: [],
    standable,
    reach: REACH,
  });
  assert.deepEqual([...chosen].sort(), [0, 2]);
});

test('an item drawn after something still z-sorted that overlaps it stays z-sorted', () => {
  const back = { ...tree(0, 0), candidate: false }; // animated: never in the layer
  const front = tree(8, 16); // overlaps it, sorts after it
  const chosen = staticLayerItems({
    items: [back, front],
    others: [],
    standable: [],
    reach: REACH,
  });
  assert.equal(chosen.size, 0, 'the front tree would otherwise be drawn under the back one');
  const wall: LayerRect = { x: 8, y: 0, w: 16, h: 32, zY: 32 };
  assert.equal(
    staticLayerItems({ items: [tree(0, 0)], others: [wall], standable: [], reach: REACH }).size,
    0,
    'nor under a wall it is drawn over',
  );
  // A chain: once one tree drops out, the tree it overlaps drops out too.
  const chain = staticLayerItems({
    items: [tree(0, 100), tree(20, 120), tree(40, 140)],
    others: [],
    standable: [{ col: 0, row: 6 }],
    reach: REACH,
  });
  assert.equal(chain.size, 0);
});

let town: OfficeLayout;

beforeAll(() => {
  loadBundledCatalog();
  town = readBundledLayout(TOWN_LAYOUT_PATH);
});

const forest = (type: string) => type === 'TALL_TREE' || type === 'PINE_TREE';

test('in the town, the forest no one can walk behind is drawn with the ground', () => {
  const os = new OfficeState(town);
  const trees = town.furniture.filter((f) => forest(f.type));
  const inLayer = os.staticFurniture.length;
  // The two rows across the top (behind the buildings) are all static.
  const top = trees.filter((f) => f.row <= 1);
  const staticTop = top.filter((f) =>
    os.staticFurniture.some((s) => s.x === f.col * 16 && s.y === f.row * 16),
  );
  assert.equal(staticTop.length, top.length, 'the top forest');
  assert.ok(inLayer >= trees.length / 2, `${inLayer} of ${trees.length} trees and more`);
  // Nothing is drawn twice, nothing is lost.
  assert.equal(os.furniture.length + os.staticFurniture.length, town.furniture.length);
});

test('a tree a character can stand behind stays z-sorted', () => {
  const os = new OfficeState(town);
  // The side forest beside the main street: its lower rows are walkable.
  const street = town.furniture.find((f) => forest(f.type) && f.col === 0 && f.row === 15)!;
  assert.ok(street, 'a side tree beside the street');
  assert.ok(
    !os.staticFurniture.some((s) => s.x === street.col * 16 && s.y === street.row * 16),
    'it is z-sorted',
  );
});

test('a character somewhere unexpected takes the trees it could stand behind out', () => {
  const os = new OfficeState(town);
  const before = os.staticLayerVersion;
  const topTree = town.furniture.find((f) => forest(f.type) && f.row === 0 && f.col === 1)!;
  const isStatic = () =>
    os.staticFurniture.some((s) => s.x === topTree.col * 16 && s.y === topTree.row * 16);
  assert.ok(isStatic());
  // Spawned into the pocket behind the top forest (as a far anchor could).
  os.addAgent(1, 0, 0, undefined, true);
  const ch = os.characters.get(1)!;
  Object.assign(ch, { tileCol: 2, tileRow: 0, x: 2 * 16 + 8, y: 8, seatId: null, path: [] });
  os.update(0.1);
  assert.ok(os.staticLayerVersion > before, 'the layer was worked out again');
  assert.ok(!isStatic(), 'the tree it stands behind is z-sorted again');
  assert.ok(os.furniture.length + os.staticFurniture.length === town.furniture.length);
  assert.ok(tileKey(ch.tileCol, ch.tileRow), 'still there');
});

test('the classic office has no static layer', () => {
  const os = new OfficeState(readBundledLayout(CLASSIC_LAYOUT_PATH));
  assert.equal(os.staticFurniture.length, 0);
  assert.equal(os.town, null);
});
