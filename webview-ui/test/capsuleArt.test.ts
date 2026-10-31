/**
 * The capsule (office/sprites/capsule.json): thrown when a session appears,
 * flown as a message and drawn where a session has no Pokémon. It is our own
 * design, so these guard what keeps it off the official ball (a pill, no
 * red), the geometry the spawn and recall effect draws with, and the
 * fallback icon built from the same pixels.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import type { FunctionComponent } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, test } from 'vitest';

import capsuleData from '../src/office/sprites/capsule.json';
import {
  CAPSULE_CLOSED_SPRITE,
  CAPSULE_OPEN_SPRITE,
} from '../src/office/sprites/pokemonUiSprites.js';
import type { SpriteData } from '../src/office/types.js';

/** The test tsconfig has no JSX, so the .tsx module is imported untyped. */
const PORTRAIT_MODULE = '../src/components/PokemonPortrait.js';
let CapsuleIcon: FunctionComponent<{ size: number }>;

beforeAll(async () => {
  ({ CapsuleIcon } = (await import(PORTRAIT_MODULE)) as {
    CapsuleIcon: FunctionComponent<{ size: number }>;
  });
});

/** Size of the box round a frame's drawn pixels. */
function drawnBox(sprite: SpriteData): { width: number; height: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  sprite.forEach((row, y) =>
    row.forEach((color, x) => {
      if (!color) return;
      xs.push(x);
      ys.push(y);
    }),
  );
  return {
    width: Math.max(...xs) - Math.min(...xs) + 1,
    height: Math.max(...ys) - Math.min(...ys) + 1,
  };
}

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

test('the capsule is a pill at least 1.75 times as wide as tall, not a ball', () => {
  const { width, height } = drawnBox(CAPSULE_CLOSED_SPRITE);
  assert.ok(width / height >= 1.75, `${width} x ${height}`);
});

test('neither frame uses red, the official ball colour', () => {
  for (const sprite of [CAPSULE_CLOSED_SPRITE, CAPSULE_OPEN_SPRITE]) {
    for (const color of colorsOf(sprite)) {
      const { hue, sat, value } = hsv(color);
      assert.ok(!((hue < 20 || hue > 340) && sat > 0.4 && value > 0.3), `${color} is red`);
    }
  }
});

test('the open frame keeps the closed height, with its light on the centre line', () => {
  // The effect rests both frames on the ground by the closed frame's half
  // height, and the recall beam leaves from the sprite's centre.
  assert.equal(CAPSULE_OPEN_SPRITE.length, CAPSULE_CLOSED_SPRITE.length);
  const width = CAPSULE_OPEN_SPRITE[0].length;
  assert.equal(width % 2, 1, 'an odd width has a centre column');
  const centre = (width - 1) / 2;
  const middle = CAPSULE_OPEN_SPRITE.length / 2;
  const light = capsuleData.palette.W;
  assert.equal(CAPSULE_OPEN_SPRITE[middle - 1][centre], light);
  assert.equal(CAPSULE_OPEN_SPRITE[middle][centre], light);
  for (const row of CAPSULE_OPEN_SPRITE) assert.equal(row.length, width);
});

test('the fallback icon is the closed capsule, centred at whole CSS pixels', () => {
  const drawn = CAPSULE_CLOSED_SPRITE.flat().filter(Boolean).length;
  const capsuleWidth = CAPSULE_CLOSED_SPRITE[0].length;
  const capsuleHeight = CAPSULE_CLOSED_SPRITE.length;
  for (const size of [32, 40]) {
    const svg = renderToStaticMarkup(createElement(CapsuleIcon, { size }));
    const scale = Math.floor(size / capsuleWidth);
    const side = size / scale;
    const viewBox = [(capsuleWidth - side) / 2, (capsuleHeight - side) / 2, side, side].join(' ');
    assert.ok(svg.includes(`viewBox="${viewBox}"`), `${size}: ${svg.slice(0, 160)}`);
    assert.ok(svg.includes(`width="${size}"`) && svg.includes(`height="${size}"`));
    const rects = [
      ...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1" fill="([^"]+)"/g),
    ];
    let covered = 0;
    for (const [, x, y, width, fill] of rects) {
      for (let i = 0; i < Number(width); i++) {
        assert.equal(CAPSULE_CLOSED_SPRITE[Number(y)][Number(x) + i], fill);
      }
      covered += Number(width);
    }
    assert.equal(covered, drawn, 'every drawn pixel, once');
  }
});
