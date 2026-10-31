#!/usr/bin/env node
/**
 * Generate the Pokémon Town's art and layout from code.
 *
 *   node scripts/generate-world-assets.mjs
 *
 * Writes, under webview-ui/public/assets/:
 *   floors/floor_9.png .. floor_22.png    grass, speckled grass, tall grass (three
 *                                         variants: 11, 15, 16; a patch's top row 17,
 *                                         its left and right sides 19, 20, its top
 *                                         corners 21, 22), dirt, cobbles, the Pokémon
 *                                         Center's tiles (14), grass in a patch's
 *                                         shadow (18)
 *   carpets/carpet_3.png                  an auto-tiled dirt path
 *   furniture/<ID>/                       outdoor items, the Center's and the Lab's furniture
 *   layouts/pokemon-town.json             the town (the standalone default layout)
 *
 * Every pixel is drawn by scripts/world/art.mjs (discs, ellipses, hand-placed
 * rows, a seeded PRNG): no tiles, sprites or palettes are copied from any game
 * or third-party tileset. The output is deterministic, so re-running it after
 * a tweak changes only what the tweak changed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as art from './world/art.mjs';
import { buildTown, COLOR } from './world/town.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(REPO_ROOT, 'webview-ui', 'public', 'assets');

function write(rel, data) {
  const file = path.join(ASSETS, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function writeJson(rel, value) {
  write(rel, `${JSON.stringify(value, null, 2)}\n`);
}

// ── Floors (appended after the bundled floor_0..floor_8) ──
const floors = [
  ['floor_9.png', art.grassFloor()],
  ['floor_10.png', art.grassFloorSpeckled()],
  ['floor_11.png', art.tallGrassFloor(0)],
  ['floor_12.png', art.dirtPathFloor()],
  ['floor_13.png', art.cobbleFloor()],
  ['floor_14.png', art.centerTileFloor()],
  ['floor_15.png', art.tallGrassFloor(1)],
  ['floor_16.png', art.tallGrassFloor(2)],
  ['floor_17.png', art.tallGrassEdgeFloor(COLOR.tallGrass, COLOR.grass, { top: true })],
  ['floor_18.png', art.grassShadowFloor()],
  ['floor_19.png', art.tallGrassEdgeFloor(COLOR.tallGrass, COLOR.grass, { side: 'left' })],
  ['floor_20.png', art.tallGrassEdgeFloor(COLOR.tallGrass, COLOR.grass, { side: 'right' })],
  [
    'floor_21.png',
    art.tallGrassEdgeFloor(COLOR.tallGrass, COLOR.grass, { top: true, side: 'left' }),
  ],
  [
    'floor_22.png',
    art.tallGrassEdgeFloor(COLOR.tallGrass, COLOR.grass, { top: true, side: 'right' }),
  ],
];
for (const [file, canvas] of floors) write(`floors/${file}`, canvas.png());

// ── Carpets (appended after carpet_0..carpet_2) ──
write('carpets/carpet_3.png', art.pathCarpet().png());

// ── Furniture ──
const NO_FLAGS = { canPlaceOnWalls: false, canPlaceOnSurfaces: false };
let furnitureCount = 0;

/** One single-asset furniture item: its folder, PNG and manifest. */
function item(id, name, category, canvas, footprintW, footprintH, backgroundTiles, flags = {}) {
  furnitureCount++;
  write(`furniture/${id}/${id}.png`, canvas.png());
  writeJson(`furniture/${id}/manifest.json`, {
    id,
    name,
    category,
    type: 'asset',
    ...NO_FLAGS,
    ...flags,
    backgroundTiles,
    width: canvas.w,
    height: canvas.h,
    footprintW,
    footprintH,
  });
}

item('TREE', 'Tree', 'outdoor', art.tree(), 2, 2, 1);
item('TALL_TREE', 'Tall Tree', 'outdoor', art.tallTree(), 2, 3, 2);
item('PINE_TREE', 'Pine Tree', 'outdoor', art.pineTree(), 2, 3, 2);
item('CYPRESS', 'Cypress', 'outdoor', art.cypress(), 1, 2, 1);
item('BUSH', 'Bush', 'outdoor', art.bush(), 1, 1, 0);
// Flowers are all background: characters walk over them.
item('FLOWERS', 'Flowers', 'outdoor', art.flowers(), 1, 1, 1);
item('WILDFLOWERS', 'Wildflowers', 'outdoor', art.wildflowers(), 1, 1, 1);
item('ROCK', 'Rock', 'outdoor', art.rock(), 1, 1, 0);
item('PARK_BENCH', 'Park Bench', 'outdoor', art.parkBench(), 2, 1, 0);
item('SIGNPOST', 'Signpost', 'outdoor', art.signpost(), 1, 2, 1);
item('LAMP_POST', 'Lamp Post', 'outdoor', art.lampPost(), 1, 2, 1);
item('LOW_WALL', 'Low Wall', 'outdoor', art.lowWall(), 1, 1, 0);
item('LOW_WALL_WINDOW', 'Low Wall Window', 'outdoor', art.lowWall({ window: true }), 1, 1, 0);
// Doormats and beds are all background: characters step onto them.
item('DOORMAT', 'Doormat', 'decor', art.doormat(), 2, 1, 1);
item('COUNTER', 'Counter', 'desks', art.counter(), 4, 2, 1);
item('PROFESSOR_DESK', 'Professor Desk', 'desks', art.professorDesk(), 4, 2, 1);
item('HEALING_MACHINE', 'Healing Machine', 'electronics', art.healingMachine(), 2, 2, 1, {
  canPlaceOnSurfaces: true,
});
item('LAB_MACHINE', 'Lab Machine', 'electronics', art.labMachine(), 2, 2, 1);
// Desk clutter for the Lab: surface items, like a PC.
item('MICROSCOPE', 'Microscope', 'misc', art.microscope(), 1, 2, 1, { canPlaceOnSurfaces: true });
item('PAPER_STACK', 'Paper Stack', 'misc', art.paperStack(), 1, 2, 1, { canPlaceOnSurfaces: true });
// Back-wall items: the bottom row hangs on the wall, the top row is
// background (it may share a tile with a tree trunk behind the wall).
const ON_WALL = { canPlaceOnWalls: true };
item('WALL_WINDOW', 'Wall Window', 'wall', art.wallWindow(), 1, 2, 1, ON_WALL);
item('CENTER_POSTER', 'Center Poster', 'wall', art.centerPoster(), 2, 2, 1, ON_WALL);
item('SPECIMEN_CABINET', 'Specimen Cabinet', 'wall', art.specimenCabinet(), 2, 2, 1, ON_WALL);
// A wainscot stacks with whatever hangs on its wall tile: all background.
item('WAINSCOT', 'Wainscot', 'wall', art.wainscot(), 1, 1, 1, ON_WALL);
item('CENTER_SIGN', 'Center Sign', 'outdoor', art.centerSign(), 2, 2, 1);
item('LAB_SIGN', 'Lab Sign', 'outdoor', art.labSign(), 2, 2, 1);
// A roof edge hangs on a back wall tile and covers its top face. Every row is
// background, so it stacks over the wall and the wall items already there.
item('ROOF_TRIM', 'Roof Trim', 'wall', art.roofTrim(), 1, 2, 2, { canPlaceOnWalls: true });

/** A two-member rotation group (R swaps them): `front` then `side`. */
function rotationPair(id, name, category, [front, side], footprintW, footprintH, backgroundTiles) {
  furnitureCount++;
  const members = [
    ['front', front],
    ['side', side],
  ];
  for (const [orientation, canvas] of members) {
    write(`furniture/${id}/${id}_${orientation.toUpperCase()}.png`, canvas.png());
  }
  writeJson(`furniture/${id}/manifest.json`, {
    id,
    name,
    category,
    type: 'group',
    groupType: 'rotation',
    rotationScheme: '2-way',
    ...NO_FLAGS,
    backgroundTiles,
    members: members.map(([orientation, canvas]) => ({
      type: 'asset',
      id: `${id}_${orientation.toUpperCase()}`,
      file: `${id}_${orientation.toUpperCase()}.png`,
      width: canvas.w,
      height: canvas.h,
      footprintW,
      footprintH,
      orientation,
    })),
  });
}

// A Pokémon Center bed: R puts the pillow on the other side. All background:
// a fainted Pokémon walks onto it and lies down.
rotationPair(
  'CENTER_BED',
  'Bed',
  'decor',
  [art.centerBed('left'), art.centerBed('right')],
  3,
  2,
  2,
);

// A fence turns: R swaps the horizontal run for the vertical one.
rotationPair('FENCE', 'Fence', 'outdoor', [art.fenceFront(), art.fenceSide()], 1, 1, 0);

// The pond shimmers: an animation group with no on/off state loops on its own.
const POND_FRAMES = 3;
furnitureCount++;
for (let f = 0; f < POND_FRAMES; f++) write(`furniture/POND/POND_${f + 1}.png`, art.pond(f).png());
writeJson('furniture/POND/manifest.json', {
  id: 'POND',
  name: 'Pond',
  category: 'outdoor',
  type: 'group',
  groupType: 'animation',
  ...NO_FLAGS,
  backgroundTiles: 0,
  members: Array.from({ length: POND_FRAMES }, (_, f) => ({
    type: 'asset',
    id: `POND_${f + 1}`,
    file: `POND_${f + 1}.png`,
    width: 80,
    height: 48,
    footprintW: 5,
    footprintH: 3,
    frame: f,
  })),
});

// ── The town layout ──
const town = buildTown();
/** One map row per line for the per-tile arrays, so the JSON diffs by row. */
function layoutJson(layout) {
  const perTile = new Set(['tiles', 'tileColors', 'carpetTiles', 'areaTiles']);
  const lines = ['{'];
  const keys = Object.keys(layout);
  keys.forEach((key, i) => {
    const comma = i < keys.length - 1 ? ',' : '';
    const value = layout[key];
    if (perTile.has(key)) {
      const rows = [];
      for (let r = 0; r < layout.rows; r++) {
        const row = value.slice(r * layout.cols, (r + 1) * layout.cols);
        rows.push(`    ${row.map((v) => JSON.stringify(v)).join(', ')}`);
      }
      lines.push(`  ${JSON.stringify(key)}: [\n${rows.join(',\n')}\n  ]${comma}`);
    } else if (key === 'furniture' || key === 'areas') {
      const items = value.map((v) => `    ${JSON.stringify(v)}`);
      lines.push(`  ${JSON.stringify(key)}: [\n${items.join(',\n')}\n  ]${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
    }
  });
  lines.push('}');
  return `${lines.join('\n')}\n`;
}
write('layouts/pokemon-town.json', layoutJson(town));

console.log(
  `generate-world-assets: ${floors.length} floors, 1 carpet, ${furnitureCount} furniture items, ` +
    `town ${town.cols}×${town.rows} with ${town.furniture.length} placed items`,
);
