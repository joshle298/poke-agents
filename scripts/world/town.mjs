/**
 * The Pokémon Town layout, built in code so it stays consistent with the art
 * (floor and carpet indices, footprints) and can be regenerated after a tweak.
 *
 *   ┌ trees ─────────────────────────────────────────────┐
 *   │ The Lab (20 desk seats)          Pokémon Center    │
 *   │ ═══════ path ══════════════════════════════════════ │
 *   │ The Meadow (tall grass, flowers)  │ pond, lamps     │
 *   └ trees ──────────────────────────── south exit ─────┘
 *
 * Working sessions sit at the Lab's desks (seats come from its benches),
 * idle ones wander and nap in the Meadow (Area role `meadow`), fainted ones
 * rest in the Pokémon Center (Area role `center`).
 */

import { LOW_WALL_BRIGHTNESS_LIFT } from './art.mjs';

export const TOWN_COLS = 36;
export const TOWN_ROWS = 26;

const WALL = 0;
const VOID = 255;

/** Tile values of the floor patterns the town uses (pattern index + 1). */
export const FLOOR = {
  labTiles: 5, // floor_4.png: light tiles
  centerChecker: 8, // floor_7.png: small checker
  grass: 10, // floor_9.png
  grassSpeckled: 11, // floor_10.png
  tallGrass: 12, // floor_11.png
  dirt: 13, // floor_12.png
  cobble: 14, // floor_13.png
};

/** Carpet variants (carpet_N.png). */
export const CARPET = { rug: 0, path: 3 };

const COLOR = {
  grass: { h: 98, s: 50, b: 4, c: 0 },
  tallGrass: { h: 112, s: 52, b: -4, c: 12 },
  cobble: { h: 32, s: 14, b: 8, c: -10 },
  labFloor: { h: 200, s: 18, b: 26, c: -58 },
  labWall: { h: 212, s: 24, b: -26, c: -50 },
  centerFloor: { h: 8, s: 34, b: 38, c: -62 },
  centerWall: { h: 356, s: 50, b: -22, c: -50 },
  pathRim: { h: 28, s: 44, b: -14, c: 0 },
  pathFill: { h: 40, s: 56, b: 40, c: 0 },
  rugMain: { h: 354, s: 62, b: -6, c: 0 },
  rugTrim: { h: 44, s: 78, b: 22, c: 0 },
};

/** A tiny deterministic hash for per-tile variation. */
function hash(col, row) {
  let h = Math.imul(col + 1, 374761393) ^ Math.imul(row + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function buildTown() {
  const cols = TOWN_COLS;
  const rows = TOWN_ROWS;
  const tiles = new Array(cols * rows).fill(FLOOR.grass);
  const tileColors = new Array(cols * rows).fill(null);
  const carpetTiles = new Array(cols * rows).fill(null);
  const areaTiles = new Array(cols * rows).fill(null);
  const furniture = [];
  const at = (c, r) => r * cols + c;

  // ── Ground: grass, with speckled clover tiles here and there ──
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles[at(c, r)] = hash(c, r) < 0.22 ? FLOOR.grassSpeckled : FLOOR.grass;
      tileColors[at(c, r)] = { ...COLOR.grass };
    }
  }
  const floorRect = (c0, r0, c1, r1, tile, color) => {
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        tiles[at(c, r)] = tile;
        tileColors[at(c, r)] = { ...color };
      }
    }
  };
  const place = (type, col, row, extra = {}) => {
    furniture.push({ uid: `town-${type.toLowerCase()}-${col}-${row}`, type, col, row, ...extra });
  };
  /**
   * A building seen from above: walls on the back and the sides, floor inside,
   * and a one-tile-high front wall (LOW_WALL, colored like the walls) with door
   * gaps, so the front never hides the room behind it.
   */
  const room = (c0, r0, c1, r1, floorTile, floorColor, wallColor, doors) => {
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const wall = r === r0 || ((c === c0 || c === c1) && r <= r1);
        tiles[at(c, r)] = wall ? WALL : floorTile;
        tileColors[at(c, r)] = { ...(wall ? wallColor : floorColor) };
        if (!wall && r === r1 && !doors.includes(c)) {
          const b = wallColor.b + LOW_WALL_BRIGHTNESS_LIFT;
          place('LOW_WALL', c, r, { color: { ...wallColor, b, colorize: true } });
        }
      }
    }
  };
  const path = (c0, r0, c1, r1) => {
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        carpetTiles[at(c, r)] = {
          variant: CARPET.path,
          color: { ...COLOR.pathRim },
          accentColor: { ...COLOR.pathFill },
        };
      }
    }
  };
  const area = (label, c0, r0, c1, r1) => {
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) if (tiles[at(c, r)] !== WALL) areaTiles[at(c, r)] = label;
    }
  };

  // ── Border: round trees along the top and bottom, cypresses on the sides ──
  for (let c = 0; c < cols; c += 2) place('TREE', c, 0);
  for (let c = 0; c < cols; c += 2) if (c !== 22) place('TREE', c, 24);
  for (let r = 2; r < 24; r += 2) {
    place('CYPRESS', 0, r);
    place('CYPRESS', cols - 1, r);
  }

  // ── The Lab: cols 1..23, rows 3..13, door at cols 11-12 ──
  room(1, 3, 23, 13, FLOOR.labTiles, COLOR.labFloor, COLOR.labWall, [11, 12]);
  for (const deskRow of [5, 9]) {
    for (const c of [2, 6, 10, 14, 18]) {
      place('DESK_FRONT', c, deskRow);
      place('PC_FRONT_OFF', c, deskRow);
      place('PC_FRONT_OFF', c + 2, deskRow);
      place('CUSHIONED_BENCH', c, deskRow + 2);
      place('CUSHIONED_BENCH', c + 2, deskRow + 2);
    }
  }
  place('LAB_MACHINE', 21, 4);
  place('LAB_MACHINE', 21, 8);
  place('PLANT', 22, 11);
  place('BIN', 21, 12);
  // on the back wall
  place('DOUBLE_BOOKSHELF', 2, 2);
  place('LAB_SIGN', 11, 3);
  place('WHITEBOARD', 14, 2);
  place('CLOCK', 9, 2);
  place('DOUBLE_BOOKSHELF', 18, 2);

  // ── The Pokémon Center: cols 25..34, rows 3..12, door at cols 29-30 ──
  room(25, 3, 34, 12, FLOOR.centerChecker, COLOR.centerFloor, COLOR.centerWall, [29, 30]);
  place('COUNTER', 28, 5);
  place('HEALING_MACHINE', 28, 5);
  place('PC_FRONT_OFF', 31, 5);
  place('PLANT', 26, 4);
  place('PLANT', 33, 4);
  place('PARK_BENCH', 26, 9, { color: { h: -18, s: 10, b: 4, c: 0 } });
  place('PARK_BENCH', 32, 9, { color: { h: -18, s: 10, b: 4, c: 0 } });
  place('CENTER_SIGN', 29, 3);
  for (let r = 7; r <= 11; r++) {
    for (const c of [29, 30]) {
      carpetTiles[at(c, r)] = {
        variant: CARPET.rug,
        color: { ...COLOR.rugMain },
        accentColor: { ...COLOR.rugTrim },
      };
    }
  }

  // ── Paths: main street, the Center's walk, the south exit ──
  path(2, 14, 33, 15);
  path(29, 13, 30, 13);
  path(22, 16, 23, 25);
  // cobbles in front of the Center
  floorRect(26, 13, 28, 13, FLOOR.cobble, COLOR.cobble);
  floorRect(31, 13, 33, 13, FLOOR.cobble, COLOR.cobble);
  place('LAMP_POST', 27, 12);
  place('LAMP_POST', 32, 12);
  place('SIGNPOST', 24, 16);

  // ── The Meadow: cols 1..21, rows 16..23 ──
  floorRect(3, 17, 8, 20, FLOOR.tallGrass, COLOR.tallGrass);
  floorRect(4, 21, 7, 22, FLOOR.tallGrass, COLOR.tallGrass);
  floorRect(14, 18, 19, 22, FLOOR.tallGrass, COLOR.tallGrass);
  floorRect(13, 19, 13, 21, FLOOR.tallGrass, COLOR.tallGrass);
  place('TREE', 10, 16);
  place('TREE', 19, 16);
  place('ROCK', 1, 23);
  place('ROCK', 12, 22);
  place('BUSH', 21, 23);
  place('PARK_BENCH', 9, 22);
  for (const [c, r] of [
    [2, 16],
    [12, 18],
    [9, 19],
    [11, 20],
    [2, 20],
    [20, 20],
    [16, 16],
    [14, 23],
  ]) {
    place('FLOWERS', c, r);
  }
  place('WILDFLOWERS', 6, 16);
  place('WILDFLOWERS', 17, 17);
  place('WILDFLOWERS', 4, 23);
  place('WILDFLOWERS', 19, 23);

  // ── South-east: the pond and a garden ──
  place('POND_1', 28, 18);
  place('FENCE_FRONT', 26, 22);
  place('FENCE_FRONT', 27, 22);
  place('FENCE_FRONT', 28, 22);
  place('FENCE_FRONT', 31, 22);
  place('FENCE_FRONT', 32, 22);
  place('FENCE_FRONT', 33, 22);
  place('BUSH', 26, 17);
  place('BUSH', 33, 17);
  for (const [c, r] of [
    [27, 21],
    [33, 21],
    [34, 20],
    [25, 22],
  ]) {
    place(c % 2 ? 'WILDFLOWERS' : 'FLOWERS', c, r);
  }
  place('PINE_TREE', 25, 19);
  place('ROCK', 31, 17);

  // ── Areas with roles ──
  const areas = [
    { label: 'Meadow', color: '#7ed957', role: 'meadow' },
    { label: 'Pokémon Center', color: '#ff7a8a', role: 'center' },
  ];
  area('Meadow', 1, 16, 21, 23);
  area('Pokémon Center', 26, 7, 33, 11);

  // Nothing may sit on a VOID tile (none here, but keep the invariant visible).
  for (let i = 0; i < tiles.length; i++) if (tiles[i] === VOID) tileColors[i] = null;

  return {
    version: 1,
    cols,
    rows,
    layoutRevision: 1,
    tiles,
    tileColors,
    furniture,
    carpetTiles,
    areas,
    areaTiles,
    pets: [],
  };
}
