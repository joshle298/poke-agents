/**
 * The catch orb (office/sprites/orb.json): thrown when a session appears,
 * flown as a message and drawn where a session has no Pokémon. It is our own
 * design, so these guard what keeps it off the official ball (a round
 * sphere of one colour inside a free gold C: no band across it, no button in
 * its middle, no red), the geometry the spawn and recall effect draws with,
 * and the fallback icon built from the same pixels.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import type { FunctionComponent } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, test } from 'vitest';

import { ORB_SPAWN_SEC, ORB_SPIN_FRAME_SEC } from '../src/constants.js';
import { spriteFrame } from '../src/office/engine/frameCanvas.js';
import { ORB_LANDED_SEC } from '../src/office/engine/matrixEffectState.js';
import {
  groundedCenter,
  orbSpinSprite,
  renderOrbEffect,
  renderRestingOrb,
} from '../src/office/engine/orbEffect.js';
import {
  setPokemonSpritesDelivered,
  setPokemonThemeEnabled,
} from '../src/office/engine/pokemonTheme.js';
import orbData from '../src/office/sprites/orb.json';
import {
  ORB_CLOSED_SPRITE,
  ORB_OPEN_SPRITE,
  ORB_SPIN_SPRITES,
} from '../src/office/sprites/pokemonUiSprites.js';
import type { Character, SpriteData } from '../src/office/types.js';

/** The test tsconfig has no JSX, so the .tsx module is imported untyped. */
const PORTRAIT_MODULE = '../src/components/PokemonPortrait.js';
let CapsuleIcon: FunctionComponent<{ size: number }>;

const realDocument = (globalThis as { document?: unknown }).document;
beforeAll(async () => {
  ({ CapsuleIcon } = (await import(PORTRAIT_MODULE)) as {
    CapsuleIcon: FunctionComponent<{ size: number }>;
  });
  // The effect's timing is the orb's only in a Pokémon office.
  setPokemonThemeEnabled(true);
  setPokemonSpritesDelivered(true);
  // getCachedSprite paints into a canvas; a stub that ignores paint is enough.
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => new Proxy({}, { get: () => () => {} }),
    }),
  };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = realDocument;
  setPokemonSpritesDelivered(false);
});

const FRAMES = orbData.frames;
type Frame = readonly string[];
/** The sphere's own colours: body, rim, highlight and glint. */
const SPHERE_KEYS = new Set('BbnNMRhW');
const BODY_KEYS = new Set('BbnNMR');
/** The C ring's gold, its latch's glint included. */
const RING_KEYS = new Set('Ggow');
/** The closed orb, then the C turned a quarter clockwise at a time. */
const SPIN_FRAMES = ['closed', 'spinDown', 'spinLeft', 'spinUp'] as const;
const NEIGHBOURS_4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

interface Cell {
  x: number;
  y: number;
}

function cellsOf(frame: Frame, keep: (key: string, x: number, y: number) => boolean): Cell[] {
  return frame.flatMap((row, y) =>
    [...row].flatMap((key, x) => (keep(key, x, y) ? [{ x, y }] : [])),
  );
}

const keyAt = (frame: Frame, x: number, y: number): string => frame[y]?.[x] ?? '_';

/** The sphere's outline: dark pixels beside the sphere. */
const isSphereOutline = (frame: Frame, x: number, y: number): boolean =>
  keyAt(frame, x, y) === 'K' &&
  NEIGHBOURS_4.some(([dx, dy]) => SPHERE_KEYS.has(keyAt(frame, x + dx, y + dy)));

function box(cells: Cell[]) {
  const xs = cells.map((c) => c.x);
  const ys = cells.map((c) => c.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { x0, x1, y0, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Groups of cells that touch, corners included. */
function groupsOf(cells: Cell[]): Cell[][] {
  const left = new Set(cells.map((c) => `${c.x},${c.y}`));
  const found: Cell[][] = [];
  for (const start of left) {
    left.delete(start);
    const group = [start];
    for (let i = 0; i < group.length; i++) {
      const [x, y] = group[i].split(',').map(Number);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const next = `${x + dx},${y + dy}`;
          if (left.delete(next)) group.push(next);
        }
      }
    }
    found.push(group.map((k) => k.split(',').map(Number)).map(([x, y]) => ({ x, y })));
  }
  return found;
}

/** The sphere's disc, from its own colours: as wide as they reach. */
function sphereDisc(frame: Frame) {
  const b = box(cellsOf(frame, (key) => SPHERE_KEYS.has(key)));
  const r = b.width / 2;
  return { cx: b.x0 + r, cy: b.y0 + r, r, box: b };
}

const distance = (c: Cell, d: { cx: number; cy: number }) =>
  Math.hypot(c.x + 0.5 - d.cx, c.y + 0.5 - d.cy);

/** HSV hue in degrees, saturation and value of a `#RRGGBB` colour. */
function hsv(color: string): { hue: number; sat: number; value: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return { hue: 0, sat: 0, value: max / 255 };
  const sector = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { hue: (sector * 60 + 360) % 360, sat: d / max, value: max / 255 };
}

const colorsOf = (sprite: SpriteData) => new Set(sprite.flat().filter(Boolean));

test('the closed and spinning orb is a whole round sphere, not a pill or an egg', () => {
  for (const name of SPIN_FRAMES) {
    const frame = FRAMES[name];
    const disc = sphereDisc(frame);
    assert.equal(disc.box.height, disc.box.width, `${name}: as tall as it is wide`);
    const sphere = cellsOf(frame, (key) => SPHERE_KEYS.has(key));
    for (const y of new Set(sphere.map((c) => c.y))) {
      const row = box(sphere.filter((c) => c.y === y));
      assert.equal((row.x0 + row.x1 + 1) / 2, disc.cx, `${name}: row ${y} is centred`);
    }
    for (const x of new Set(sphere.map((c) => c.x))) {
      const column = box(sphere.filter((c) => c.x === x));
      assert.equal((column.y0 + column.y1 + 1) / 2, disc.cy, `${name}: column ${x} is centred`);
    }
    for (const cell of cellsOf(frame, (_, x, y) => distance({ x, y }, disc) <= disc.r - 1)) {
      assert.ok(SPHERE_KEYS.has(keyAt(frame, cell.x, cell.y)), `${name}: (${cell.x}, ${cell.y})`);
    }
  }
});

test('a free gold C stands round the orb: a pixel of floor between, open on the right', () => {
  for (const name of SPIN_FRAMES) {
    const frame = FRAMES[name];
    // Nothing but floor touches the sphere's outline from outside.
    for (const { x, y } of cellsOf(frame, (_, x, y) => isSphereOutline(frame, x, y))) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const key = keyAt(frame, x + dx, y + dy);
          const ok = key === '_' || SPHERE_KEYS.has(key) || isSphereOutline(frame, x + dx, y + dy);
          assert.ok(ok, `${name}: ${key} at (${x + dx}, ${y + dy}) touches the sphere`);
        }
      }
    }
  }
  const frame = FRAMES.closed;
  const disc = sphereDisc(frame);
  const gold = cellsOf(frame, (key) => RING_KEYS.has(key));
  const ring = box(gold);
  assert.ok(Math.abs(ring.width - ring.height) <= 2, 'face-on: as tall as it is wide');
  const middle = Math.floor(disc.cx);
  assert.ok(
    gold.some((c) => c.x === middle && c.y < disc.box.y0),
    'over the sphere',
  );
  assert.ok(
    gold.some((c) => c.x === middle && c.y > disc.box.y1),
    'under the sphere',
  );
  const left = gold.filter((c) => c.x + 1 <= disc.cx - disc.r);
  const right = gold.filter((c) => c.x >= disc.cx + disc.r);
  assert.equal(groupsOf(left).length, 1, 'one stroke round the left');
  const ends = groupsOf(right).map(box);
  assert.equal(ends.length, 2, 'two ends on the right, the opening between');
  const [upper, lower] = ends.sort((a, b) => a.y0 - b.y0);
  const [x0, x1] = [Math.min(upper.x0, lower.x0), Math.max(upper.x1, lower.x1)];
  let open = 0;
  for (let y = upper.y1 + 1; y < lower.y0; y++) {
    const clear = [...frame[y].slice(x0, x1 + 1)].every(
      (key, i) => key === '_' || isSphereOutline(frame, x0 + i, y),
    );
    if (clear) open++;
  }
  assert.ok(open >= 2, `${open} rows of floor in the opening`);
});

test('the sphere holds still while the C turns a quarter clockwise each frame', () => {
  const closed = FRAMES.closed;
  const disc = sphereDisc(closed);
  // Where the gold lies relative to the sphere: away from the opening.
  const away: Record<(typeof SPIN_FRAMES)[number], [number, number]> = {
    closed: [-1, 0],
    spinDown: [0, -1],
    spinLeft: [1, 0],
    spinUp: [0, 1],
  };
  for (const name of SPIN_FRAMES) {
    const frame = FRAMES[name];
    const sphere = (f: Frame) =>
      cellsOf(f, (key) => SPHERE_KEYS.has(key)).map((c) => keyAt(f, c.x, c.y) + c.x + ',' + c.y);
    assert.deepEqual(sphere(frame), sphere(closed), `${name}: the same sphere`);
    const gold = cellsOf(frame, (key) => RING_KEYS.has(key));
    const mx = gold.reduce((a, c) => a + c.x + 0.5, 0) / gold.length - disc.cx;
    const my = gold.reduce((a, c) => a + c.y + 0.5, 0) / gold.length - disc.cy;
    const [ax, ay] = away[name];
    assert.ok(mx * ax + my * ay > 0.5, `${name}: the C opens the other way (${mx}, ${my})`);
  }
});

test('no band splits the sphere and no button sits in its middle', () => {
  for (const name of SPIN_FRAMES) {
    const frame = FRAMES[name];
    const disc = sphereDisc(frame);
    frame.forEach((row, y) => {
      const dy = y + 0.5 - disc.cy;
      if (Math.abs(dy) > disc.r / 2) return;
      const half = Math.sqrt(disc.r ** 2 - dy ** 2);
      const x0 = Math.ceil(disc.cx - half - 0.5);
      const x1 = Math.floor(disc.cx + half - 0.5);
      let run = 0;
      for (let x = x0; x <= x1; x++) {
        run = SPHERE_KEYS.has(row[x]) ? 0 : run + 1;
        assert.ok(run < (x1 - x0 + 1) / 2, `${name}: row ${y} has a band`);
      }
    });
    frame.forEach((row, y) =>
      [...row].forEach((key, x) => {
        if (distance({ x, y }, disc) > disc.r / 3) return;
        assert.ok(BODY_KEYS.has(key), `${name}: (${x}, ${y}) at the centre is ${key}`);
      }),
    );
  }
});

test('no frame uses red, the official ball colour; the body is teal to indigo', () => {
  for (const sprite of [...ORB_SPIN_SPRITES, ORB_OPEN_SPRITE]) {
    for (const color of colorsOf(sprite)) {
      const { hue, sat, value } = hsv(color);
      assert.ok(!((hue < 20 || hue > 340) && sat > 0.4 && value > 0.3), `${color} is red`);
    }
  }
  for (const key of BODY_KEYS) {
    const { hue, sat } = hsv(orbData.palette[key as keyof typeof orbData.palette]);
    assert.ok(hue >= 170 && hue <= 250 && sat >= 0.4, `body ${key}`);
  }
});

test('the C spins right, down, left, up and comes to rest closed', () => {
  assert.deepEqual(
    [...ORB_SPIN_SPRITES, ORB_OPEN_SPRITE].map((s) => [s[0].length, s.length]),
    [...ORB_SPIN_SPRITES, ORB_OPEN_SPRITE].map(() => [
      ORB_CLOSED_SPRITE[0].length,
      ORB_CLOSED_SPRITE.length,
    ]),
    'every frame is the closed frame’s size, so the orb never jumps',
  );
  assert.equal(orbSpinSprite(0), ORB_CLOSED_SPRITE, 'at rest');
  assert.equal(orbSpinSprite(ORB_SPIN_FRAME_SEC * 1.5), ORB_SPIN_SPRITES[3], 'up just before');
  assert.equal(orbSpinSprite(ORB_SPIN_FRAME_SEC * 2.5), ORB_SPIN_SPRITES[2], 'left before that');
  assert.equal(orbSpinSprite(ORB_SPIN_FRAME_SEC * 3.5), ORB_SPIN_SPRITES[1], 'down before that');
  assert.equal(orbSpinSprite(ORB_SPIN_FRAME_SEC * 4.5), ORB_CLOSED_SPRITE, 'closed before that');
});

test('the open orb is the closed one cracked: a thin slit of light rising through its centre', () => {
  const open = FRAMES.open;
  const closed = FRAMES.closed;
  const light = new Set(['W', 'L']);
  const slit: Cell[] = [];
  open.forEach((row, y) =>
    [...row].forEach((key, x) => {
      const was = keyAt(closed, x, y);
      if (RING_KEYS.has(was) || RING_KEYS.has(key)) {
        assert.equal(key, was, `(${x}, ${y}): the C stays whole`);
      }
      if (was === '_') assert.ok(key === '_' || light.has(key), `(${x}, ${y}): only light spills`);
      if (light.has(key) && key !== was) slit.push({ x, y });
    }),
  );
  const w = open[0].length;
  const h = open.length;
  // The recall beam leaves the frame's centre.
  const centre = [
    [w / 2 - 1, h / 2 - 1],
    [w / 2, h / 2 - 1],
    [w / 2 - 1, h / 2],
    [w / 2, h / 2],
  ];
  assert.ok(
    centre.some(([x, y]) => slit.some((c) => c.x === x && c.y === y)),
    'the slit crosses the centre',
  );
  for (const x of new Set(slit.map((c) => c.x))) {
    assert.ok(slit.filter((c) => c.x === x).length <= 2, `column ${x}: a slit, not a wedge`);
  }
  const b = box(slit);
  const leftmost = slit.filter((c) => c.x === b.x0);
  const rightmost = slit.filter((c) => c.x === b.x1);
  assert.ok(
    Math.max(...rightmost.map((c) => c.y)) < Math.min(...leftmost.map((c) => c.y)),
    'rising to the latch side',
  );
  assert.ok(b.height >= 3, 'slanted, not a level band');
});

/** The sprite canvases drawn, with where (device px). */
function recordDraws(): {
  ctx: CanvasRenderingContext2D;
  draws: Array<{ x: number; y: number; w: number; h: number }>;
} {
  const draws: Array<{ x: number; y: number; w: number; h: number }> = [];
  const ctx = new Proxy(
    {
      drawImage: (img: { width: number; height: number }, x: number, y: number) =>
        draws.push({ x, y, w: img.width, h: img.height }),
    },
    {
      get: (target, key) => (key in target ? target[key as 'drawImage'] : () => {}),
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, draws };
}

function orbCharacter(timer: number): Character {
  return {
    id: 1,
    matrixEffect: 'spawn',
    matrixEffectTimer: timer,
    species: 25,
    isGreeter: true,
  } as unknown as Character;
}

test('the resting and the open orb both stand on the ground by their bottom row', () => {
  const zoom = 3;
  const ground = { x: 40, y: 50 };
  const frame = spriteFrame(ORB_CLOSED_SPRITE);
  // Resting closed, at the bottom of its bob.
  const resting = recordDraws();
  renderRestingOrb(
    resting.ctx,
    { ...orbCharacter(0), matrixEffect: null, id: 0 },
    ground,
    0,
    0,
    zoom,
    1,
  );
  const closed = resting.draws[0];
  assert.equal(closed.y + closed.h, ground.y * zoom, 'closed: bottom on the ground');
  // Cracked open, partway through the open phase.
  const opening = recordDraws();
  const timer = ORB_LANDED_SEC + ORB_SPAWN_SEC * 0.14;
  renderOrbEffect(opening.ctx, orbCharacter(timer), frame, ground, 20, 0, 0, zoom, 1);
  const open = opening.draws.find((d) => d.h === ORB_OPEN_SPRITE.length * zoom);
  assert.ok(open, 'the open frame is drawn');
  assert.equal(open.y + open.h, ground.y * zoom, 'open: bottom on the ground');
  // Same middle, give or take half a sprite pixel of rounding.
  assert.ok(Math.abs(open.x + open.w / 2 - (closed.x + closed.w / 2)) <= zoom / 2);
  assert.deepEqual(groundedCenter(ORB_OPEN_SPRITE, ground), {
    x: ground.x,
    y: ground.y - ORB_OPEN_SPRITE.length / 2,
  });
});

test('the fallback icon is the closed orb, centred at whole CSS pixels', () => {
  const drawn = ORB_CLOSED_SPRITE.flat().filter(Boolean).length;
  const orbWidth = ORB_CLOSED_SPRITE[0].length;
  const orbHeight = ORB_CLOSED_SPRITE.length;
  for (const size of [32, 40]) {
    const svg = renderToStaticMarkup(createElement(CapsuleIcon, { size }));
    const scale = Math.floor(size / orbWidth);
    assert.ok(scale >= 2, `${size}: drawn at ${scale} CSS px a pixel`);
    const side = size / scale;
    const [left, top, w, h] = /viewBox="([^"]+)"/.exec(svg)![1].split(' ').map(Number);
    assert.deepEqual([w, h], [side, side]);
    for (const [offset, extent] of [
      [left, orbWidth],
      [top, orbHeight],
    ]) {
      assert.ok(Number.isInteger(offset * scale), `${size}: offset ${offset} is whole CSS px`);
      assert.ok(Math.abs(offset - (extent - side) / 2) <= 0.5, `${size}: centred`);
    }
    assert.ok(svg.includes(`width="${size}"`) && svg.includes(`height="${size}"`));
    const rects = [
      ...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1" fill="([^"]+)"/g),
    ];
    let covered = 0;
    for (const [, x, y, width, fill] of rects) {
      for (let i = 0; i < Number(width); i++) {
        assert.equal(ORB_CLOSED_SPRITE[Number(y)][Number(x) + i], fill);
      }
      covered += Number(width);
    }
    assert.equal(covered, drawn, 'every drawn pixel, once');
  }
});
