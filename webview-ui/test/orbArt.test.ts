/**
 * The catch orb (office/sprites/orb.json): thrown when a session appears,
 * flown as a message and drawn where a session has no Pokémon. It is our own
 * design, so these guard what keeps it off the official ball (a round
 * sphere of one colour with a tilted gold C round it: no band across it, no
 * button in its middle, no red), the geometry the spawn and recall effect
 * draws with, and the fallback icon built from the same pixels.
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

interface Cell {
  x: number;
  y: number;
}

function cellsOf(frame: Frame, keys: Set<string>): Cell[] {
  return frame.flatMap((row, y) => [...row].flatMap((key, x) => (keys.has(key) ? [{ x, y }] : [])));
}

function box(cells: Cell[]) {
  const xs = cells.map((c) => c.x);
  const ys = cells.map((c) => c.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { x0, x1, y0, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Groups of cells that touch, corners included. */
function groupCount(cells: Cell[]): number {
  const left = new Set(cells.map((c) => `${c.x},${c.y}`));
  let count = 0;
  for (const start of left) {
    left.delete(start);
    count++;
    const queue = [start];
    while (queue.length > 0) {
      const [x, y] = queue.pop()!.split(',').map(Number);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const next = `${x + dx},${y + dy}`;
          if (left.delete(next)) queue.push(next);
        }
      }
    }
  }
  return count;
}

/** The sphere's disc, from its own colours: as wide as they reach, its top
 *  where they start (the ring hides part of its bottom). */
function sphereDisc(frame: Frame) {
  const b = box(cellsOf(frame, SPHERE_KEYS));
  const r = b.width / 2;
  return { cx: b.x0 + r, cy: b.y0 + r, r };
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

test('the closed and spinning orb is a round sphere, not a pill', () => {
  for (const name of ['closed', 'spinFront', 'spinLeft'] as const) {
    const frame = FRAMES[name];
    const disc = sphereDisc(frame);
    for (const cell of cellsOf(frame, SPHERE_KEYS)) {
      assert.ok(
        distance(cell, disc) <= disc.r + 0.5,
        `${name}: (${cell.x}, ${cell.y}) off the disc`,
      );
    }
    frame.forEach((row, y) =>
      [...row].forEach((key, x) => {
        if (distance({ x, y }, disc) > disc.r - 1) return;
        assert.ok(
          SPHERE_KEYS.has(key) || RING_KEYS.has(key) || key === 'K',
          `${name}: (${x}, ${y})`,
        );
      }),
    );
  }
});

test('a gold C rings the closed orb: past the sphere both sides, open on the right', () => {
  const frame = FRAMES.closed;
  const disc = sphereDisc(frame);
  const gold = cellsOf(frame, RING_KEYS);
  const left = gold.filter((c) => c.x + 1 <= disc.cx - disc.r);
  const right = gold.filter((c) => c.x >= disc.cx + disc.r);
  assert.equal(groupCount(left), 1, 'one stroke round the left');
  assert.equal(groupCount(right), 2, 'two ends on the right, the opening between');
  // Tilted: the ring crosses the sphere only below its middle (in front),
  // and passes behind its upper half.
  const inside = gold.filter((c) => distance(c, disc) <= disc.r - 0.5);
  assert.ok(inside.length > 0, 'in front of the sphere');
  assert.ok(
    inside.every((c) => c.y + 0.5 > disc.cy),
    'behind its upper half',
  );
});

test('no band splits the sphere and no button sits in its middle', () => {
  for (const name of ['closed', 'spinFront', 'spinLeft'] as const) {
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

test('the ring spins from closed to front to left and comes to rest closed', () => {
  assert.deepEqual(
    ORB_SPIN_SPRITES.map((s) => [s[0].length, s.length]),
    ORB_SPIN_SPRITES.map(() => [ORB_CLOSED_SPRITE[0].length, ORB_CLOSED_SPRITE.length]),
    'every spin frame is the closed frame’s size, so the orb never jumps',
  );
  assert.equal(orbSpinSprite(0), ORB_CLOSED_SPRITE, 'at rest');
  assert.equal(orbSpinSprite(ORB_SPIN_FRAME_SEC * 1.5), ORB_SPIN_SPRITES[2], 'left just before');
  assert.equal(orbSpinSprite(ORB_SPIN_FRAME_SEC * 2.5), ORB_SPIN_SPRITES[1], 'front before that');
  assert.equal(orbSpinSprite(ORB_SPIN_FRAME_SEC * 3.5), ORB_CLOSED_SPRITE, 'closed before that');
});

test("the open frame's light is at its centre, where the recall beam leaves", () => {
  const w = ORB_OPEN_SPRITE[0].length;
  const h = ORB_OPEN_SPRITE.length;
  const light = new Set([orbData.palette.W, orbData.palette.L]);
  for (const [x, y] of [
    [w / 2 - 1, h / 2 - 1],
    [w / 2, h / 2 - 1],
    [w / 2 - 1, h / 2],
    [w / 2, h / 2],
  ]) {
    assert.ok(light.has(ORB_OPEN_SPRITE[y][x]), `(${x}, ${y}) is ${ORB_OPEN_SPRITE[y][x]}`);
  }
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
  // Split open, partway through the open phase (after the ring has turned).
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
