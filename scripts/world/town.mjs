/**
 * The Pokémon Town layout, built in code so it stays consistent with the art
 * (floor and carpet indices, footprints) and can be regenerated after a tweak.
 *
 *   ┌ forest: two staggered rows of tall trees ─────────────────────┐
 *   │ The Lab: lectern (Leads) + 18 desk seats │ │ Pokémon Center   │
 *   │ ═══════ main street ══════════════════════╧═╧═════════════════ │
 *   │ The Meadow (tall grass, flowers)  ║  fenced pond garden        │
 *   └ forest ────────────────────── south exit ─────────────────────┘
 *
 * Working sessions sit at the Lab's desks (seats come from its chairs and
 * benches; the two lectern seats are kept for Leads, Area role `lectern`),
 * idle ones wander and nap in the Meadow (Area role `meadow`), fainted ones
 * rest on the Pokémon Center's beds (Area role `center`).
 */

import { LOW_WALL_BRIGHTNESS_LIFT, TALL_GRASS_VARIANT_COUNT } from './art.mjs';

export const TOWN_COLS = 37;
export const TOWN_ROWS = 27;

const WALL = 0;
const VOID = 255;

/** Tile values of the floor patterns the town uses (pattern index + 1). */
export const FLOOR = {
  labTiles: 5, // floor_4.png: light tiles
  grass: 10, // floor_9.png
  grassSpeckled: 11, // floor_10.png
  tallGrass: [12, 16, 17], // floor_11.png, floor_15.png, floor_16.png (variants)
  tallGrassTop: 18, // floor_17.png: a patch's top row (shorter, ragged blades)
  grassShadowed: 19, // floor_18.png: grass with the shadow of the patch above
  dirt: 13, // floor_12.png
  cobble: 14, // floor_13.png
  centerTiles: 15, // floor_14.png: large soft tiles
};

/** Carpet variants (carpet_N.png). */
export const CARPET = { rug: 0, path: 3 };

export const COLOR = {
  grass: { h: 98, s: 50, b: 4, c: 0 },
  tallGrass: { h: 112, s: 52, b: -2, c: 12 },
  cobble: { h: 32, s: 14, b: 8, c: -10 },
  labFloor: { h: 200, s: 18, b: 26, c: -58 },
  labWall: { h: 212, s: 24, b: -26, c: -50 },
  labRoof: { h: 214, s: 34, b: -34, c: 0 },
  centerFloor: { h: 30, s: 52, b: 36, c: -45 },
  centerWall: { h: 356, s: 50, b: -22, c: -50 },
  centerRoof: { h: 356, s: 52, b: -32, c: 0 },
  pathRim: { h: 37, s: 43, b: 18, c: 0 },
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
  /** Placed last, so they draw over the wall items they share a sort key with. */
  const roofTrims = [];
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
        tiles[at(c, r)] = typeof tile === 'function' ? tile(c, r) : tile;
        tileColors[at(c, r)] = { ...color };
      }
    }
  };
  /** Tall grass, one blade variant per tile. */
  const tallGrass = (c0, r0, c1, r1) =>
    floorRect(
      c0,
      r0,
      c1,
      r1,
      (c, r) => FLOOR.tallGrass[Math.floor(hash(c + 101, r + 7) * TALL_GRASS_VARIANT_COUNT)],
      COLOR.tallGrass,
    );
  const place = (type, col, row, extra = {}) => {
    furniture.push({ uid: `town-${type.toLowerCase()}-${col}-${row}`, type, col, row, ...extra });
  };
  /**
   * A building seen from above: walls on the back and the sides, floor inside,
   * a roof edge along the back wall, and a one-tile-high façade on the front
   * (LOW_WALL, a window every third tile, colored like the walls) with door
   * gaps, so the front never hides the room behind it.
   */
  /** A wall color as wall items drawn in grays (façade, wainscot) take it. */
  const facadeOf = (wallColor) => ({
    ...wallColor,
    b: wallColor.b + LOW_WALL_BRIGHTNESS_LIFT,
    colorize: true,
  });
  const room = (c0, r0, c1, r1, floorTile, floorColor, wallColor, roofColor, doors) => {
    const facadeColor = facadeOf(wallColor);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const wall = r === r0 || ((c === c0 || c === c1) && r <= r1);
        tiles[at(c, r)] = wall ? WALL : floorTile;
        tileColors[at(c, r)] = { ...(wall ? wallColor : floorColor) };
        if (!wall && r === r1 && !doors.includes(c)) {
          const window = (c - c0) % 3 === 2 && !doors.includes(c - 1) && !doors.includes(c + 1);
          place(window ? 'LOW_WALL_WINDOW' : 'LOW_WALL', c, r, { color: { ...facadeColor } });
        }
      }
    }
    for (let c = c0; c <= c1; c++) {
      roofTrims.push({
        uid: `town-roof_trim-${c}-${r0 - 1}`,
        type: 'ROOF_TRIM',
        col: c,
        row: r0 - 1,
        color: { ...roofColor, colorize: true },
      });
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
  /** Tall broadleaf trees and pines, mixed by position. */
  const forestTree = (col, row) =>
    place(hash(col + 17, row + 3) < 0.3 ? 'PINE_TREE' : 'TALL_TREE', col, row);

  // ── The Lab: cols 2..23, rows 4..14, door at cols 12-13 ──
  room(2, 4, 23, 14, FLOOR.labTiles, COLOR.labFloor, COLOR.labWall, COLOR.labRoof, [12, 13]);
  // The lectern under the whiteboard: the two seats behind it are for Leads.
  place('CUSHIONED_CHAIR_FRONT', 11, 5);
  place('CUSHIONED_CHAIR_FRONT', 14, 5);
  place('PROFESSOR_DESK', 11, 6);
  // Desks with a PC per seat: two either side of the lectern, five below.
  const deskWithPcs = (c, row) => {
    place('DESK_FRONT', c, row);
    place('PC_FRONT_OFF', c, row);
    place('PC_FRONT_OFF', c + 2, row);
    place('CUSHIONED_BENCH', c, row + 2);
    place('CUSHIONED_BENCH', c + 2, row + 2);
  };
  for (const c of [3, 7, 16, 20]) deskWithPcs(c, 5);
  for (const c of [3, 7, 11, 15, 19]) deskWithPcs(c, 9);
  // between the PCs, a little variety: microscopes and paperwork
  place('MICROSCOPE', 8, 5);
  place('MICROSCOPE', 16, 9);
  place('PAPER_STACK', 17, 5);
  place('PAPER_STACK', 4, 9);
  place('PAPER_STACK', 20, 9);
  place('LAB_MACHINE', 3, 12);
  place('LAB_MACHINE', 20, 12);
  place('PLANT', 22, 12);
  place('BIN', 19, 13);
  place('DOORMAT', 12, 14);
  // on the back wall
  place('BOOKSHELF', 3, 4);
  place('BOOKSHELF', 7, 4);
  place('CLOCK', 9, 3);
  place('WHITEBOARD', 12, 3);
  place('SPECIMEN_CABINET', 16, 3);
  place('BOOKSHELF', 20, 4);

  // ── The Pokémon Center: cols 25..34, rows 4..13, door at cols 29-30 ──
  room(
    25,
    4,
    34,
    13,
    FLOOR.centerTiles,
    COLOR.centerFloor,
    COLOR.centerWall,
    COLOR.centerRoof,
    [29, 30],
  );
  place('COUNTER', 28, 5);
  place('HEALING_MACHINE', 28, 5);
  place('PC_FRONT_OFF', 31, 5);
  place('PLANT', 26, 5);
  place('PLANT', 33, 5);
  // the back wall: a wainscot, two pairs of windows and a poster
  for (let c = 26; c <= 33; c++) {
    place('WAINSCOT', c, 4, { color: facadeOf(COLOR.centerWall) });
  }
  for (const c of [26, 27, 32, 33]) place('WALL_WINDOW', c, 3);
  place('CENTER_POSTER', 29, 3);
  // Beds along the side walls, pillows to the wall: fainted Pokémon rest here.
  place('CENTER_BED_FRONT', 26, 7);
  place('CENTER_BED_FRONT', 26, 10);
  place('CENTER_BED_SIDE', 32, 7);
  place('CENTER_BED_SIDE', 32, 10);
  place('DOORMAT', 29, 13);
  for (let r = 7; r <= 12; r++) {
    for (const c of [29, 30]) {
      carpetTiles[at(c, r)] = {
        variant: CARPET.rug,
        color: { ...COLOR.rugMain },
        accentColor: { ...COLOR.rugTrim },
      };
    }
  }

  // ── Streets: the main street, the Center's walk, the south exit ──
  path(2, 15, 34, 16);
  path(29, 14, 30, 14);
  path(23, 17, 24, 26);
  // cobbles in front of the Center, lamps either side of its door, signs outside
  floorRect(25, 14, 28, 14, FLOOR.cobble, COLOR.cobble);
  floorRect(31, 14, 34, 14, FLOOR.cobble, COLOR.cobble);
  place('LAMP_POST', 28, 13);
  place('LAMP_POST', 31, 13);
  place('CENTER_SIGN', 32, 13);
  place('LAB_SIGN', 9, 14);
  place('SIGNPOST', 25, 17);
  // the alley between the buildings
  place('BUSH', 24, 5);
  place('FLOWERS', 24, 8);
  place('WILDFLOWERS', 24, 11);

  // ── The Meadow: cols 3..22, rows 17..22 ──
  tallGrass(3, 17, 8, 20);
  tallGrass(4, 21, 7, 22);
  tallGrass(14, 18, 19, 22);
  tallGrass(13, 19, 13, 21);
  // Patch edges: shorter, ragged blades along each patch's top row, and the
  // patch's shadow on the grass under its bottom row.
  const isTall = (c, r) => FLOOR.tallGrass.includes(tiles[at(c, r)]);
  const isGrass = (c, r) =>
    tiles[at(c, r)] === FLOOR.grass || tiles[at(c, r)] === FLOOR.grassSpeckled;
  const tops = [];
  const shadows = [];
  for (let r = 1; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isTall(c, r) && !isTall(c, r - 1)) tops.push(at(c, r));
      if (isGrass(c, r) && isTall(c, r - 1) && carpetTiles[at(c, r)] === null)
        shadows.push(at(c, r));
    }
  }
  for (const i of tops) {
    tiles[i] = FLOOR.tallGrassTop;
    tileColors[i] = { ...COLOR.grass };
  }
  for (const i of shadows) tiles[i] = FLOOR.grassShadowed;
  place('TREE', 10, 17);
  place('TREE', 20, 17);
  place('ROCK', 2, 22);
  place('ROCK', 12, 22);
  place('BUSH', 21, 22);
  place('PARK_BENCH', 9, 22);
  for (const [c, r] of [
    [2, 17],
    [12, 19],
    [9, 20],
    [11, 21],
    [2, 20],
    [20, 20],
    [16, 17],
  ]) {
    place('FLOWERS', c, r);
  }
  place('WILDFLOWERS', 9, 18);
  place('WILDFLOWERS', 17, 17);
  place('WILDFLOWERS', 10, 19);
  place('WILDFLOWERS', 21, 19);

  // ── The pond garden: fenced along the street (a gate at cols 29-30, in
  // line with the Center's door) and on the path side below the signpost,
  // which marks the side entrance; the forest closes the other two sides.
  for (const c of [26, 27, 28, 31, 32, 33, 34]) place('FENCE_FRONT', c, 17);
  for (let r = 20; r <= 22; r++) place('FENCE_SIDE', 25, r);
  place('POND_1', 28, 19);
  place('BUSH', 34, 22);
  place('ROCK', 33, 18);
  for (const [c, r] of [
    [26, 21],
    [33, 21],
    [34, 20],
    [27, 18],
    [31, 22],
  ]) {
    place(c % 2 ? 'WILDFLOWERS' : 'FLOWERS', c, r);
  }

  // ── The forest edge: tall trees in two staggered rows on every side ──
  // Top: a back row on row 0 and a front row on row 1. A front tree's trunk
  // row is a wall item's top row on the Lab's back wall, so it skips those.
  const wallItemCols = new Set([9, 12, 13]);
  for (let c = 1; c < cols - 1; c += 2) forestTree(c, 0);
  for (let c = 0; c < cols - 1; c += 2) {
    if (!wallItemCols.has(c) && !wallItemCols.has(c + 1)) forestTree(c, 1);
  }
  // Sides: a column of trees every two rows down to the bottom band.
  for (let r = 3; r <= 21; r += 2) {
    forestTree(0, r);
    forestTree(cols - 2, r);
  }
  // Bottom: a back row on row 23 and a front row on row 24, with a gap for the
  // south exit (cols 23-24).
  const exit = (c) => c + 1 >= 23 && c <= 24;
  for (let c = 1; c < cols - 1; c += 2) if (!exit(c)) forestTree(c, rows - 4);
  for (let c = 0; c < cols - 1; c += 2) if (!exit(c)) forestTree(c, rows - 3);

  // ── Areas with roles ──
  const areas = [
    { label: 'Meadow', color: '#7ed957', role: 'meadow' },
    { label: 'Pokémon Center', color: '#ff7a8a', role: 'center' },
    { label: 'Lectern', color: '#ffd166', role: 'lectern' },
  ];
  // Not the columns beside the side forest: a wide sprite there would stand
  // in the trees.
  area('Meadow', 3, 17, 22, 22);
  area('Meadow', 26, 18, 33, 22);
  area('Pokémon Center', 26, 7, 33, 12);
  area('Lectern', 11, 5, 14, 7);

  // Nothing may sit on a VOID tile (none here, but keep the invariant visible).
  for (let i = 0; i < tiles.length; i++) if (tiles[i] === VOID) tileColors[i] = null;

  return {
    version: 1,
    cols,
    rows,
    layoutRevision: 1,
    tiles,
    tileColors,
    furniture: [...furniture, ...roofTrims],
    carpetTiles,
    areas,
    areaTiles,
    pets: [],
  };
}
