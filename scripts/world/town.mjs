/**
 * The Pokémon Town layout, built in code so it stays consistent with the art
 * (floor and carpet indices, footprints) and can be regenerated after a tweak.
 *
 *   ┌ forest: two staggered rows of tall trees ───────────────────────────────┐
 *   │ The Lab (Leads)  │ the Work Yard: picnic and log tables │ Pokémon Center │
 *   │ ══════════ main street ═════════════════════════════════════════════════ │
 *   │ The Meadow (tall grass, a route)  ║ the Grove: tables  │ pond garden     │
 *   └ forest ─────────────────────── south exit ──────────────────────────────┘
 *
 * Working Leads sit at the Lab's desks (Area role `lab`); every other working
 * session sits at a table outdoors, in the Work Yard or the Grove (Area role
 * `field`), seated on the benches and stumps around the tables (their seats
 * come from those chairs), with two field terminals on each table, one facing
 * each side. Idle sessions wander and nap in the Meadow and the pond garden
 * (Area role `meadow`), fainted ones rest on the Pokémon Center's beds (role
 * `center`).
 */

import { LOW_WALL_BRIGHTNESS_LIFT, TALL_GRASS_VARIANT_COUNT } from './art.mjs';

export const TOWN_COLS = 56;
export const TOWN_ROWS = 38;

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
  tallGrassLeft: 20, // floor_19.png: a patch's left side (a ragged edge)
  tallGrassRight: 21, // floor_20.png: its right side
  tallGrassTopLeft: 22, // floor_21.png: its top-left corner
  tallGrassTopRight: 23, // floor_22.png: its top-right corner
  dirt: 13, // floor_12.png
  cobble: 14, // floor_13.png
  centerTiles: 15, // floor_14.png: large soft tiles
};

/** Carpet variants (carpet_N.png). */
export const CARPET = { rug: 0, path: 3 };

export const COLOR = {
  grass: { h: 98, s: 50, b: 4, c: 0 },
  // The same hue and saturation as the grass: a patch's edge tiles are
  // coloured like the grass and match the patch by lightness alone.
  tallGrass: { h: 98, s: 50, b: -10, c: 14 },
  cobble: { h: 32, s: 14, b: 8, c: -10 },
  /** The Work Yard's paving: warmer and a little lighter than the street cobbles. */
  yard: { h: 36, s: 22, b: 14, c: -14 },
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
  const flowerBed = (spots) => {
    for (const [c, r] of spots) place((c + r) % 3 === 0 ? 'WILDFLOWERS' : 'FLOWERS', c, r);
  };
  /**
   * An outdoor work table, 3 wide and 2 deep at (c, r), with a seat at each
   * end of both long sides (two tiles apart, so neighbours never overlap) and
   * two field terminals on its far half, one turned toward each side.
   * `kind` picks the set: a picnic table with benches, or a log table with
   * tree stumps.
   */
  const workTable = (kind, c, r) => {
    const [table, seat] =
      kind === 'picnic' ? ['PICNIC_TABLE', 'PICNIC_BENCH'] : ['LOG_TABLE', 'TREE_STUMP'];
    place(table, c, r);
    for (const dc of [0, 2]) {
      place(seat, c + dc, r - 1);
      place(seat, c + dc, r + 2);
    }
    place('FIELD_TERMINAL_FRONT_OFF', c, r);
    place('FIELD_TERMINAL_BACK_OFF', c + 2, r);
  };

  // ── The Lab: cols 3..18, rows 4..13, door at cols 10-11. Only Leads work
  // here: the lectern and four desks, a PC at every seat. ──
  room(3, 4, 18, 13, FLOOR.labTiles, COLOR.labFloor, COLOR.labWall, COLOR.labRoof, [10, 11]);
  // The lectern under the whiteboard: two seats behind the professor's desk.
  place('CUSHIONED_CHAIR_FRONT', 9, 5);
  place('CUSHIONED_CHAIR_FRONT', 12, 5);
  place('PROFESSOR_DESK', 9, 6);
  /** A desk with a PC per seat, the seats on benches below it. */
  const deskWithPcs = (c, row) => {
    place('DESK_FRONT', c, row);
    place('PC_FRONT_OFF', c, row);
    place('PC_FRONT_OFF', c + 2, row);
    place('CUSHIONED_BENCH', c, row + 2);
    place('CUSHIONED_BENCH', c + 2, row + 2);
  };
  for (const c of [4, 14]) {
    deskWithPcs(c, 6);
    deskWithPcs(c, 9);
  }
  // between the PCs: microscopes and paperwork
  place('MICROSCOPE', 5, 6);
  place('PAPER_STACK', 15, 6);
  place('PAPER_STACK', 5, 9);
  place('MICROSCOPE', 15, 9);
  // research machines either side of the walk from the door
  place('LAB_MACHINE', 8, 9);
  place('LAB_MACHINE', 12, 9);
  place('PLANT', 17, 9);
  place('BIN', 8, 12);
  place('DOORMAT', 10, 13);
  // on the back wall
  place('BOOKSHELF', 4, 4);
  place('CLOCK', 7, 3);
  place('WHITEBOARD', 10, 3);
  place('SPECIMEN_CABINET', 13, 3);
  place('BOOKSHELF', 16, 4);

  // ── The Pokémon Center: cols 37..52, rows 4..13, door at cols 44-45 ──
  room(
    37,
    4,
    52,
    13,
    FLOOR.centerTiles,
    COLOR.centerFloor,
    COLOR.centerWall,
    COLOR.centerRoof,
    [44, 45],
  );
  place('COUNTER', 43, 5);
  place('HEALING_MACHINE', 44, 5);
  place('PC_FRONT_OFF', 46, 5);
  place('PLANT', 38, 5);
  place('PLANT', 51, 5);
  // the back wall: a wainscot, two pairs of windows and a poster
  for (let c = 38; c <= 51; c++) {
    place('WAINSCOT', c, 4, { color: facadeOf(COLOR.centerWall) });
  }
  for (const c of [39, 40, 49, 50]) place('WALL_WINDOW', c, 3);
  place('CENTER_POSTER', 44, 3);
  // Eight beds in two wards either side of the aisle, pillows toward the
  // side walls: fainted Pokémon rest here.
  for (const r of [7, 10]) {
    place('CENTER_BED_FRONT', 38, r);
    place('CENTER_BED_FRONT', 41, r);
    place('CENTER_BED_SIDE', 46, r);
    place('CENTER_BED_SIDE', 49, r);
  }
  place('DOORMAT', 44, 13);
  for (let r = 7; r <= 12; r++) {
    for (const c of [44, 45]) {
      carpetTiles[at(c, r)] = {
        variant: CARPET.rug,
        color: { ...COLOR.rugMain },
        accentColor: { ...COLOR.rugTrim },
      };
    }
  }

  // ── The Work Yard: cols 20..35, rows 4..14, a cobbled yard between the Lab
  // and the Center. Six tables: picnic tables in front, log tables behind. ──
  floorRect(20, 4, 35, 14, FLOOR.cobble, COLOR.yard);
  for (const c of [21, 26, 31]) {
    workTable('picnic', c, 6);
    workTable('log', c, 11);
  }
  place('LAMP_POST', 20, 8);
  place('LAMP_POST', 35, 8);
  place('BUSH', 19, 5);
  place('BUSH', 36, 5);
  flowerBed([
    [19, 9],
    [19, 12],
    [36, 10],
    [36, 13],
  ]);

  // ── Streets: the main street, the doors' walks, the south exit ──
  path(2, 15, 53, 16);
  path(10, 14, 11, 14);
  path(44, 14, 45, 14);
  path(27, 17, 28, rows - 1);
  // a route into the Meadow: down from the street, then east to the south path
  path(12, 17, 13, 25);
  path(12, 26, 26, 26);
  // cobbles in front of the Center, lamps either side of its door, signs outside
  floorRect(38, 14, 43, 14, FLOOR.cobble, COLOR.cobble);
  floorRect(46, 14, 51, 14, FLOOR.cobble, COLOR.cobble);
  place('LAMP_POST', 43, 13);
  place('LAMP_POST', 46, 13);
  place('CENTER_SIGN', 47, 13);
  place('LAB_SIGN', 7, 13);
  place('SIGNPOST', 26, 17);
  place('SIGNPOST', 39, 17);

  // ── The Meadow: cols 3..25, rows 18..33, either side of the route ──
  tallGrass(3, 18, 9, 22);
  tallGrass(4, 23, 8, 24);
  tallGrass(16, 19, 22, 23);
  tallGrass(15, 20, 15, 22);
  tallGrass(4, 29, 11, 32);
  tallGrass(17, 28, 23, 31);
  tallGrass(18, 32, 21, 32);
  place('TREE', 10, 18);
  place('TREE', 23, 18);
  place('TREE', 14, 28);
  place('TREE', 3, 26);
  place('ROCK', 2, 24);
  place('ROCK', 11, 23);
  place('ROCK', 24, 32);
  place('BUSH', 25, 22);
  place('BUSH', 15, 33);
  place('PARK_BENCH', 18, 25);
  place('PARK_BENCH', 6, 27);
  flowerBed([
    [2, 18],
    [10, 21],
    [14, 18],
    [11, 31],
    [2, 31],
    [21, 21],
    [24, 24],
    [16, 31],
    [9, 26],
    [20, 27],
    [25, 30],
    [14, 22],
    [5, 33],
  ]);

  // ── The Grove: cols 30..38, rows 18..29, four log and picnic tables under
  // the trees beside the south path ──
  workTable('log', 31, 20);
  workTable('log', 35, 20);
  workTable('picnic', 31, 26);
  workTable('picnic', 35, 26);
  place('TREE', 30, 30);
  place('TREE', 36, 30);
  place('TREE', 33, 31);
  place('LAMP_POST', 34, 22);
  flowerBed([
    [30, 18],
    [38, 18],
    [30, 23],
    [38, 24],
    [32, 30],
  ]);

  // ── The pond garden: fenced along the street (a gate at cols 44-45, in
  // line with the Center's door) and on the Grove's side below the signpost,
  // which marks the side entrance; the forest closes the other two sides.
  for (let c = 40; c <= 52; c++) if (c !== 44 && c !== 45) place('FENCE_FRONT', c, 17);
  for (let r = 20; r <= 33; r++) place('FENCE_SIDE', 39, r);
  place('POND_1', 43, 21);
  tallGrass(47, 26, 51, 30);
  tallGrass(41, 28, 43, 30);
  place('PARK_BENCH', 44, 25);
  place('TREE', 49, 19);
  place('ROCK', 51, 23);
  place('ROCK', 41, 33);
  place('BUSH', 52, 33);
  place('BUSH', 40, 19);
  flowerBed([
    [41, 22],
    [48, 23],
    [52, 21],
    [42, 25],
    [46, 31],
    [50, 32],
    [44, 33],
  ]);

  // Patch edges, coloured like the grass around them: shorter, ragged blades
  // along each patch's top row, a ragged side where it meets the lawn on the
  // left or right, and the patch's shadow on the grass under its bottom row.
  const isTall = (c, r) => FLOOR.tallGrass.includes(tiles[at(c, r)]);
  const isGrass = (c, r) =>
    tiles[at(c, r)] === FLOOR.grass || tiles[at(c, r)] === FLOOR.grassSpeckled;
  const edges = [];
  const shadows = [];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      if (isTall(c, r)) {
        const top = !isTall(c, r - 1);
        const side = !isTall(c - 1, r) ? 'Left' : !isTall(c + 1, r) ? 'Right' : '';
        const key = `tallGrass${top ? 'Top' : ''}${side}`;
        if (key !== 'tallGrass') edges.push([at(c, r), FLOOR[key]]);
      }
      if (isGrass(c, r) && isTall(c, r - 1) && carpetTiles[at(c, r)] === null)
        shadows.push(at(c, r));
    }
  }
  for (const [i, tile] of edges) {
    tiles[i] = tile;
    tileColors[i] = { ...COLOR.grass };
  }
  for (const i of shadows) tiles[i] = FLOOR.grassShadowed;

  // ── The forest edge: tall trees in two staggered rows on every side ──
  // Top: a back row on row 0 and a front row on row 1. A front tree's trunk
  // row is the top row of an item hanging on a building's back wall, so it
  // skips those columns.
  const wallItemCols = new Set();
  for (const f of furniture) if (f.row === 3) wallItemCols.add(f.col).add(f.col + 1);
  for (let c = 1; c < cols - 1; c += 2) forestTree(c, 0);
  for (let c = 0; c < cols - 1; c += 2) {
    if (!wallItemCols.has(c) && !wallItemCols.has(c + 1)) forestTree(c, 1);
  }
  // Sides: a column of trees every two rows down to the bottom band.
  for (let r = 3; r <= rows - 6; r += 2) {
    forestTree(0, r);
    forestTree(cols - 2, r);
  }
  // Bottom: a back row and a front row, with a gap for the south exit.
  const exit = (c) => c + 1 >= 27 && c <= 28;
  for (let c = 1; c < cols - 1; c += 2) if (!exit(c)) forestTree(c, rows - 4);
  for (let c = 0; c < cols - 1; c += 2) if (!exit(c)) forestTree(c, rows - 3);

  // ── Areas with roles ──
  const areas = [
    { label: 'Lab', color: '#7aa6ff', role: 'lab' },
    { label: 'Work Yard', color: '#f2a65a', role: 'field' },
    { label: 'Grove', color: '#c9a227', role: 'field' },
    { label: 'Meadow', color: '#7ed957', role: 'meadow' },
    { label: 'Pokémon Center', color: '#ff7a8a', role: 'center' },
  ];
  area('Lab', 4, 5, 17, 12);
  area('Work Yard', 20, 4, 35, 14);
  area('Grove', 30, 18, 38, 29);
  // Not the columns beside the side forest: a wide sprite there would stand
  // in the trees.
  area('Meadow', 3, 18, 25, 33);
  area('Meadow', 40, 18, 52, 33);
  area('Pokémon Center', 38, 7, 51, 12);

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
