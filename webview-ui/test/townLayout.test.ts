/**
 * The bundled Pokémon Town: it parses, it is about twice the old town's area
 * (larger than the window at the default zoom), every placed item exists in
 * the real furniture catalog and could have been placed with the editor, the
 * Lab seats a handful of Leads and the outdoor work areas everyone else, and
 * every seat and every Meadow, field and Center tile can be walked to from the
 * Meadow — through the buildings' doors, which exist and are the only way in.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';

import { beforeAll, test } from 'vitest';

import { canPlaceFurniture, getSurfaceRiders } from '../src/office/editor/editorActions.js';
import { areaRoleTiles, tileKey, townCameraHome } from '../src/office/layout/areaRoles.js';
import { getCatalogEntry } from '../src/office/layout/furnitureCatalog.js';
import {
  deserializeLayout,
  getBlockedTiles,
  layoutToSeats,
  layoutToTileMap,
} from '../src/office/layout/layoutSerializer.js';
import { isWalkable } from '../src/office/layout/tileMap.js';
import type { OfficeLayout, Seat } from '../src/office/types.js';
import { Direction, TileType } from '../src/office/types.js';
import {
  LEGACY_TOWN_LAYOUT_PATH,
  loadBundledCatalog,
  readBundledLayout,
  TOWN_LAYOUT_PATH,
} from './worldFixtures.js';

/** Party bar and margins at 1400×900: the office canvas is about 1200 × 900. */
const CANVAS_AT_1400 = { width: 1200, height: 900 };
/** Default zoom at devicePixelRatio 1 (ZOOM_DEFAULT_DPR_FACTOR). */
const DEFAULT_ZOOM = 2;
/** Tiles the default view shows at 1400×900. */
const VIEW_TILES = {
  cols: CANVAS_AT_1400.width / (16 * DEFAULT_ZOOM),
  rows: CANVAS_AT_1400.height / (16 * DEFAULT_ZOOM),
};

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

test('the town parses, is about twice the old one, and is larger than the default view', () => {
  const raw = fs.readFileSync(TOWN_LAYOUT_PATH, 'utf-8');
  const parsed = deserializeLayout(raw);
  assert.ok(parsed, 'deserializeLayout accepts it');
  assert.equal(town.tiles.length, town.cols * town.rows);
  assert.equal(town.tileColors?.length, town.tiles.length);
  assert.equal(town.areaTiles?.length, town.tiles.length);
  assert.equal(town.carpetTiles?.length, town.tiles.length);
  const old = readBundledLayout(LEGACY_TOWN_LAYOUT_PATH);
  const ratio = (town.cols * town.rows) / (old.cols * old.rows);
  assert.ok(ratio >= 1.8 && ratio <= 2.6, `area ${ratio.toFixed(2)}× the v0.4 town's`);
  assert.ok(town.cols > VIEW_TILES.cols, 'wider than the default view');
  assert.ok(town.rows > VIEW_TILES.rows, 'taller than the default view');
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

/** The tile a seat faces (its desk or table). */
function faced(seat: Seat): string {
  const d = {
    [Direction.UP]: [0, -1],
    [Direction.DOWN]: [0, 1],
    [Direction.LEFT]: [-1, 0],
    [Direction.RIGHT]: [1, 0],
  }[seat.facingDir];
  return tileKey(seat.seatCol + d[0], seat.seatRow + d[1]);
}

/** Every tile covered by the placed items of `types`. */
function tilesOf(layout: OfficeLayout, test: (type: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const f of layout.furniture) {
    if (!test(f.type)) continue;
    const entry = getCatalogEntry(f.type)!;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) out.add(tileKey(f.col + dc, f.row + dr));
    }
  }
  return out;
}

test('the Lab seats a handful of Leads, the work areas everyone else; no seat elsewhere', () => {
  const roles = areaRoleTiles(town)!;
  const seats = [...layoutToSeats(town.furniture).values()];
  const lab = seats.filter((s) => roles.lab.has(tileKey(s.seatCol, s.seatRow)));
  const field = seats.filter((s) => roles.field.has(tileKey(s.seatCol, s.seatRow)));
  assert.ok(lab.length >= 6 && lab.length <= 10, `${lab.length} Lab seats`);
  assert.ok(field.length >= 32, `${field.length} outdoor seats`);
  assert.equal(lab.length + field.length, seats.length, 'every seat is in the Lab or a field');
  // Outdoor seats are benches and stumps at tables, never next to each other.
  const tables = tilesOf(town, (t) => t === 'PICNIC_TABLE' || t === 'LOG_TABLE');
  const keys = new Set(field.map((s) => tileKey(s.seatCol, s.seatRow)));
  for (const seat of field) {
    assert.ok(
      tables.has(faced(seat)),
      `outdoor seat ${tileKey(seat.seatCol, seat.seatRow)} faces a table`,
    );
    assert.ok(
      !keys.has(tileKey(seat.seatCol + 1, seat.seatRow)),
      `no seat right beside ${tileKey(seat.seatCol, seat.seatRow)}`,
    );
  }
  // Every table carries a field terminal; every Lab desk seat faces a PC.
  for (const t of town.furniture.filter(
    (f) => f.type === 'PICNIC_TABLE' || f.type === 'LOG_TABLE',
  )) {
    const on = town.furniture.filter(
      (f) =>
        f.type.startsWith('FIELD_TERMINAL_') &&
        f.col >= t.col &&
        f.col < t.col + 3 &&
        f.row >= t.row &&
        f.row < t.row + 2,
    );
    assert.ok(on.length >= 1, `the table at (${t.col},${t.row}) has a field terminal`);
  }
  const pcs = tilesOf(town, (t) => t.startsWith('PC_'));
  const desks = lab.filter((s) => pcs.has(faced(s)));
  assert.ok(desks.length >= 6 && desks.length <= 8, `${desks.length} Lab desks with a PC`);
});

test('the town has a Lab, work areas, a Meadow and a Pokémon Center with 8+ beds', () => {
  const roles = areaRoleTiles(town)!;
  assert.ok(roles.lab.size >= 60, `lab ${roles.lab.size} tiles`);
  assert.ok(roles.field.size >= 200, `fields ${roles.field.size} tiles`);
  assert.ok(roles.meadow.size >= 400, `meadow ${roles.meadow.size} tiles`);
  assert.ok(roles.center.size >= 60, `center ${roles.center.size} tiles`);
  assert.equal(roles.lectern.size, 0, 'the whole Lab is for Leads: no separate lectern');
  const byRole = (role: string) => town.areas!.filter((a) => a.role === role).map((a) => a.label);
  assert.deepEqual(byRole('lab'), ['Lab']);
  assert.deepEqual(byRole('field'), ['Work Yard', 'Grove']);
  assert.deepEqual(byRole('meadow'), ['Meadow']);
  assert.deepEqual(byRole('center'), ['Pokémon Center']);
  const beds = town.furniture.filter((f) => f.type.startsWith('CENTER_BED_'));
  assert.ok(beds.length >= 8, `${beds.length} beds`);
  for (const bed of beds) {
    assert.ok(
      roles.center.has(tileKey(bed.col, bed.row)),
      `bed at (${bed.col},${bed.row}) is in the Center`,
    );
  }
});

test('the camera starts on the Lab and the Work Yard, which fit the default view', () => {
  const home = townCameraHome(town)!;
  assert.ok(home, 'a home view');
  const roles = areaRoleTiles(town)!;
  const yard = new Set<string>();
  town.areaTiles!.forEach((label, i) => {
    if (label === 'Work Yard') yard.add(tileKey(i % town.cols, Math.floor(i / town.cols)));
  });
  for (const key of [...roles.lab, ...yard]) {
    const [col, row] = key.split(',').map(Number);
    assert.ok(Math.abs(col + 0.5 - home.col) <= VIEW_TILES.cols / 2, `${key} in view`);
    assert.ok(Math.abs(row + 0.5 - home.row) <= VIEW_TILES.rows / 2, `${key} in view`);
  }
  // The classic office has no home: it stays centred.
  assert.equal(townCameraHome({ cols: 1, areas: [], areaTiles: [] }), null);
});

test('every seat and every walkable role tile is reachable from the Meadow', () => {
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
  for (const key of [...roles.meadow, ...roles.center, ...roles.field, ...roles.lab]) {
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
  const street: number[] = [];
  for (let c = 40; c <= 52; c++) if (open(c, 17)) street.push(c);
  assert.deepEqual(street, [44, 45], 'the gate, in line with the Center door');
  const groveSide: number[] = [];
  for (let r = 18; r <= 33; r++) if (open(39, r)) groveSide.push(r);
  assert.deepEqual(groveSide, [19], 'one opening, just under the signpost');
  const sign = town.furniture.find((f) => f.type === 'SIGNPOST' && f.col === 39)!;
  assert.deepEqual([sign.col, sign.row + 1], [39, 18], 'the signpost stands beside it');
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
  const patch = town.tileColors![20 * town.cols + 5]!;
  assert.ok(TALL.includes(tile(5, 20)), 'inside the patch');
  assert.notDeepEqual(patch, lawn);
  assert.deepEqual([patch.h, patch.s], [lawn.h, lawn.s]);
});

test('the Center has its own back wall and two wards of beds, each three tiles by two', () => {
  const at = (type: string) => town.furniture.filter((f) => f.type === type);
  assert.equal(at('WALL_WINDOW').length, 4, 'two pairs of windows');
  assert.equal(at('CENTER_POSTER').length, 1, 'a poster');
  const wainscot = at('WAINSCOT').map((f) => f.col);
  assert.deepEqual(
    wainscot,
    Array.from({ length: 14 }, (_, i) => 38 + i),
    'a wainscot the width of the room',
  );
  for (const bed of town.furniture.filter((f) => f.type.startsWith('CENTER_BED_'))) {
    const entry = getCatalogEntry(bed.type)!;
    assert.deepEqual([entry.footprintW, entry.footprintH, entry.backgroundTiles], [3, 2, 2]);
  }
  for (const type of ['SPECIMEN_CABINET', 'MICROSCOPE', 'PAPER_STACK', 'PROFESSOR_DESK']) {
    assert.ok(at(type).length > 0, `the Lab has a ${type}`);
  }
});
