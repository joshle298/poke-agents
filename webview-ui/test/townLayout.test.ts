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
