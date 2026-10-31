/**
 * The bundled Pokémon Town: it parses, every placed item exists in the real
 * furniture catalog and could have been placed with the editor, the Lab seats
 * enough working sessions, and every seat and every Meadow / Center tile can
 * be walked to from the Meadow — through the buildings' doors, which exist
 * and are the only way in.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';

import { beforeAll, test } from 'vitest';

import { canPlaceFurniture, getSurfaceRiders } from '../src/office/editor/editorActions.js';
import { areaRoleTiles, tileKey } from '../src/office/layout/areaRoles.js';
import { getCatalogEntry } from '../src/office/layout/furnitureCatalog.js';
import {
  deserializeLayout,
  getBlockedTiles,
  layoutToSeats,
  layoutToTileMap,
} from '../src/office/layout/layoutSerializer.js';
import { isWalkable } from '../src/office/layout/tileMap.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';
import { loadBundledCatalog, readBundledLayout, TOWN_LAYOUT_PATH } from './worldFixtures.js';

/** Party bar and margins at 1400×900: the office canvas is about 1200 × 900. */
const CANVAS_AT_1400 = { width: 1200, height: 900 };
/** Default zoom at devicePixelRatio 1 (ZOOM_DEFAULT_DPR_FACTOR). */
const DEFAULT_ZOOM = 2;

let town: OfficeLayout;

beforeAll(() => {
  loadBundledCatalog();
  town = readBundledLayout(TOWN_LAYOUT_PATH);
});

/** Every walkable tile reachable from `start` (4-connected). */
function reachableFrom(layout: OfficeLayout, start: { col: number; row: number }): Set<string> {
  const tileMap = layoutToTileMap(layout);
  const blocked = getBlockedTiles(layout.furniture);
  const seen = new Set([tileKey(start.col, start.row)]);
  const queue = [start];
  while (queue.length > 0) {
    const { col, row } = queue.shift()!;
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const next = { col: col + dc, row: row + dr };
      const key = tileKey(next.col, next.row);
      if (seen.has(key) || !isWalkable(next.col, next.row, tileMap, blocked)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return seen;
}

function walkableMeadowTile(layout: OfficeLayout): { col: number; row: number } {
  const roles = areaRoleTiles(layout)!;
  const tileMap = layoutToTileMap(layout);
  const blocked = getBlockedTiles(layout.furniture);
  for (const key of roles.meadow) {
    const [col, row] = key.split(',').map(Number);
    if (isWalkable(col, row, tileMap, blocked)) return { col, row };
  }
  throw new Error('no walkable Meadow tile');
}

test('the town parses as a layout and fits the default zoom next to the party bar', () => {
  const raw = fs.readFileSync(TOWN_LAYOUT_PATH, 'utf-8');
  const parsed = deserializeLayout(raw);
  assert.ok(parsed, 'deserializeLayout accepts it');
  assert.equal(town.tiles.length, town.cols * town.rows);
  assert.equal(town.tileColors?.length, town.tiles.length);
  assert.equal(town.areaTiles?.length, town.tiles.length);
  assert.equal(town.carpetTiles?.length, town.tiles.length);
  assert.ok(town.cols >= 36 && town.cols <= 44, `cols ${town.cols}`);
  assert.ok(town.rows >= 24 && town.rows <= 30, `rows ${town.rows}`);
  assert.ok(town.cols * 16 * DEFAULT_ZOOM <= CANVAS_AT_1400.width, 'fits the width');
  assert.ok(town.rows * 16 * DEFAULT_ZOOM <= CANVAS_AT_1400.height, 'fits the height');
  // Shares the classic default's revision, so neither ever resets the other.
  assert.equal(town.layoutRevision, 1);
});

test('every placed item exists in the furniture catalog and is where the editor allows it', () => {
  for (const item of town.furniture) {
    assert.ok(getCatalogEntry(item.type), `${item.type} is in the catalog`);
    // As the editor moves it: a desk together with what stands on it.
    const moving = new Set([item.uid, ...getSurfaceRiders(town, item.uid).map((r) => r.uid)]);
    assert.ok(
      canPlaceFurniture(town, item.type, item.col, item.row, moving),
      `${item.type} at (${item.col},${item.row}) is a valid placement`,
    );
  }
  const uids = new Set(town.furniture.map((f) => f.uid));
  assert.equal(uids.size, town.furniture.length, 'furniture uids are unique');
});

test('the Lab seats at least 16 working sessions, all outside the Meadow and the Center', () => {
  const seats = [...layoutToSeats(town.furniture).values()];
  assert.ok(seats.length >= 16, `${seats.length} seats`);
  const roles = areaRoleTiles(town)!;
  for (const seat of seats) {
    const key = tileKey(seat.seatCol, seat.seatRow);
    assert.ok(!roles.meadow.has(key) && !roles.center.has(key), `seat ${key} is in the Lab`);
  }
});

test('the Lab keeps two lectern seats for Leads; the Center has a bed per side wall slot', () => {
  const roles = areaRoleTiles(town)!;
  const seats = [...layoutToSeats(town.furniture).values()];
  const lectern = seats.filter((s) => roles.lectern.has(tileKey(s.seatCol, s.seatRow)));
  assert.equal(lectern.length, 2, 'two lectern seats');
  assert.ok(seats.length - lectern.length >= 16, `${seats.length - lectern.length} desks`);
  const beds = town.furniture.filter((f) => f.type.startsWith('CENTER_BED_'));
  assert.equal(beds.length, 4);
  for (const bed of beds) {
    assert.ok(
      roles.center.has(tileKey(bed.col, bed.row)),
      `bed at (${bed.col},${bed.row}) is in the Center`,
    );
  }
});

test('the town has a Meadow and a Pokémon Center, as Area roles', () => {
  const roles = areaRoleTiles(town);
  assert.ok(roles, 'the layout has role areas');
  assert.ok(roles.meadow.size >= 60, `meadow ${roles.meadow.size} tiles`);
  assert.ok(roles.center.size >= 12, `center ${roles.center.size} tiles`);
  const labels = new Map(town.areas!.map((a) => [a.role, a.label]));
  assert.equal(labels.get('meadow'), 'Meadow');
  assert.equal(labels.get('center'), 'Pokémon Center');
});

test('every seat and every walkable Meadow and Center tile is reachable from the Meadow', () => {
  const reached = reachableFrom(town, walkableMeadowTile(town));
  const tileMap = layoutToTileMap(town);
  const blocked = getBlockedTiles(town.furniture);
  for (const seat of layoutToSeats(town.furniture).values()) {
    // A seat's chair blocks everyone but its owner, who steps on from a neighbor.
    const neighbors = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].map(([dc, dr]) => tileKey(seat.seatCol + dc, seat.seatRow + dr));
    assert.ok(
      neighbors.some((k) => reached.has(k)),
      `seat (${seat.seatCol},${seat.seatRow}) is reachable`,
    );
  }
  const roles = areaRoleTiles(town)!;
  for (const key of [...roles.meadow, ...roles.center]) {
    const [col, row] = key.split(',').map(Number);
    if (!isWalkable(col, row, tileMap, blocked)) continue;
    assert.ok(reached.has(key), `area tile ${key} is reachable`);
  }
});

test('the Lab and the Pokémon Center have doors, and only doors lead in', () => {
  const tileMap = layoutToTileMap(town);
  const blocked = getBlockedTiles(town.furniture);
  const seat = layoutToSeats(town.furniture).values().next().value!;
  const center = [...areaRoleTiles(town)!.center][0].split(',').map(Number);
  const buildings = [
    { name: 'Lab', floor: tileMap[seat.seatRow][seat.seatCol] },
    { name: 'Pokémon Center', floor: tileMap[center[1]][center[0]] },
  ];
  for (const { name, floor } of buildings) {
    assert.notEqual(floor, TileType.WALL);
    // A door: a walkable building tile with a walkable outside tile next to it.
    const doors: string[] = [];
    for (let row = 0; row < town.rows; row++) {
      for (let col = 0; col < town.cols; col++) {
        if (tileMap[row][col] !== floor || !isWalkable(col, row, tileMap, blocked)) continue;
        const opens = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dc, dr]) => {
          const c = col + dc;
          const r = row + dr;
          return (
            r >= 0 &&
            r < town.rows &&
            c >= 0 &&
            c < town.cols &&
            tileMap[r][c] !== floor &&
            isWalkable(c, r, tileMap, blocked)
          );
        });
        if (opens) doors.push(tileKey(col, row));
      }
    }
    assert.ok(doors.length >= 1 && doors.length <= 3, `${name} doors: ${doors.join(' ')}`);
  }
});

test('the Meadow keeps a tile clear of the forest on either side', () => {
  const roles = areaRoleTiles(town)!;
  const forest = new Set<string>();
  for (const f of town.furniture) {
    if (f.type !== 'TALL_TREE' && f.type !== 'PINE_TREE') continue;
    const entry = getCatalogEntry(f.type)!;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) forest.add(tileKey(f.col + dc, f.row + dr));
    }
  }
  for (const key of roles.meadow) {
    const [col, row] = key.split(',').map(Number);
    for (const dc of [-1, 1]) {
      assert.ok(!forest.has(tileKey(col + dc, row)), `Meadow tile ${key} is beside a forest tree`);
    }
  }
});

test('the pond garden is fenced: a gate on the street, an opening by the signpost', () => {
  const tileMap = layoutToTileMap(town);
  const blocked = getBlockedTiles(town.furniture);
  const open = (col: number, row: number) => isWalkable(col, row, tileMap, blocked);
  const street = [26, 27, 28, 29, 30, 31, 32, 33, 34].filter((c) => open(c, 17));
  assert.deepEqual(street, [29, 30], 'the gate, in line with the Center door');
  const pathSide = [18, 19, 20, 21, 22].filter((r) => open(25, r));
  assert.deepEqual(pathSide, [19], 'one opening, just under the signpost');
  const sign = town.furniture.find((f) => f.type === 'SIGNPOST')!;
  assert.deepEqual([sign.col, sign.row + 1], [25, 18], 'the signpost stands beside it');
});

test('tall-grass patches have ragged edges, coloured like the grass, and a shadow below', () => {
  const TALL = [12, 16, 17]; // floor_11, floor_15, floor_16
  const TOP = 18; // floor_17
  const SHADOW = 19; // floor_18
  const LEFT = 20; // floor_19
  const RIGHT = 21; // floor_20
  const TOP_LEFT = 22; // floor_21
  const TOP_RIGHT = 23; // floor_22
  const EDGES = [TOP, LEFT, RIGHT, TOP_LEFT, TOP_RIGHT];
  const PLAIN_GRASS = [10, 11]; // floor_9, floor_10
  const tile = (c: number, r: number): number => town.tiles[r * town.cols + c];
  const tall = (c: number, r: number) => r >= 0 && [...TALL, ...EDGES].includes(tile(c, r));
  const lawn = town.tileColors![16 * town.cols + 5]!; // under the main street, plain grass
  const counts = new Map<number, number>();
  let shadows = 0;
  for (let r = 0; r < town.rows; r++) {
    for (let c = 0; c < town.cols; c++) {
      if (tall(c, r)) {
        const top = !tall(c, r - 1);
        const side = !tall(c - 1, r) ? 'left' : !tall(c + 1, r) ? 'right' : null;
        const want = top
          ? side === 'left'
            ? TOP_LEFT
            : side === 'right'
              ? TOP_RIGHT
              : TOP
          : side === 'left'
            ? LEFT
            : side === 'right'
              ? RIGHT
              : null;
        if (want === null) assert.ok(TALL.includes(tile(c, r)), `(${c},${r}) inside a patch`);
        else assert.equal(tile(c, r), want, `(${c},${r}) on the patch's edge`);
        if (want !== null) {
          counts.set(want, (counts.get(want) ?? 0) + 1);
          const color = town.tileColors![r * town.cols + c];
          assert.deepEqual(color, lawn, `(${c},${r}): an edge tile is coloured like the grass`);
        }
      } else if (tall(c, r - 1) && town.carpetTiles?.[r * town.cols + c] === null) {
        assert.ok(!PLAIN_GRASS.includes(tile(c, r)), `(${c},${r}) under a patch is shadowed`);
        if (tile(c, r) === SHADOW) shadows++;
      }
    }
  }
  for (const edge of EDGES) assert.ok((counts.get(edge) ?? 0) > 0, `edge tile ${edge} is used`);
  assert.ok((counts.get(TOP) ?? 0) >= 6, `${counts.get(TOP)} top-row tiles`);
  assert.ok(shadows >= 4, `${shadows} shadowed tiles`);
  // The patch and the grass share a hue: an edge tile can match both.
  const patch = town.tileColors![18 * town.cols + 5]!;
  assert.ok(TALL.includes(tile(5, 18)), 'inside the patch');
  assert.notDeepEqual(patch, lawn);
  assert.deepEqual([patch.h, patch.s], [lawn.h, lawn.s]);
});

test('the Center has its own back wall and four beds, each three tiles by two', () => {
  const at = (type: string) => town.furniture.filter((f) => f.type === type);
  assert.equal(at('WALL_WINDOW').length, 4, 'two pairs of windows');
  assert.equal(at('CENTER_POSTER').length, 1, 'a poster');
  const wainscot = at('WAINSCOT').map((f) => f.col);
  assert.deepEqual(wainscot, [26, 27, 28, 29, 30, 31, 32, 33], 'a wainscot the width of the room');
  for (const bed of town.furniture.filter((f) => f.type.startsWith('CENTER_BED_'))) {
    const entry = getCatalogEntry(bed.type)!;
    assert.deepEqual([entry.footprintW, entry.footprintH, entry.backgroundTiles], [3, 2, 2]);
  }
  for (const type of ['SPECIMEN_CABINET', 'MICROSCOPE', 'PAPER_STACK']) {
    assert.ok(at(type).length > 0, `the Lab has a ${type}`);
  }
});
