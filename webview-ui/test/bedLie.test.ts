/**
 * How a sleeper lies in a Pokémon Center bed: a wide pose as drawn, a tall
 * one turned on its side with its top to the pillow; on the mattress between
 * the boards, its head on the pillow, its lowest pixel on the near edge.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  BED_BOARD_PX,
  BED_PILLOW_INSET_PX,
  BED_SLEEPER_BASE_PX,
  BED_SLEEPER_SINK_LIMIT_PX,
} from '../src/constants.js';
import type { BedLie, PoseBox } from '../src/office/engine/bedLie.js';
import { lieInBed, spritePoseBox, turnBox } from '../src/office/engine/bedLie.js';

/** A 3×2-tile bed at world (100, 200). */
const bed = (pillow: 'left' | 'right') => ({ pillow, x: 100, y: 200, w: 48, h: 32 });

/** The body's world box as drawn. */
const span = (lie: BedLie) => ({
  left: lie.x - lie.box.left,
  right: lie.x + lie.box.right,
  top: lie.y - lie.box.rise,
  bottom: lie.y + lie.box.drop,
});

test('a wide pose lies as drawn, its head end on the pillow, its lowest pixel on the base', () => {
  const lying: PoseBox = { left: 15, right: 14, rise: 12, drop: 3 };
  for (const pillow of ['left', 'right'] as const) {
    const lie = lieInBed(lying, bed(pillow));
    assert.equal(lie.turn, 0);
    assert.deepEqual(lie.box, lying);
    const s = span(lie);
    if (pillow === 'left') assert.equal(s.left, 100 + BED_PILLOW_INSET_PX);
    else assert.equal(s.right, 148 - BED_PILLOW_INSET_PX);
    assert.equal(s.bottom, 232 - BED_SLEEPER_BASE_PX);
  }
});

test('a tall pose turns on its side, its top to the pillow', () => {
  const upright: PoseBox = { left: 12, right: 10, rise: 26, drop: 6 };
  const left = lieInBed(upright, bed('left'));
  assert.equal(left.turn, -1, 'counterclockwise: the top goes left');
  assert.deepEqual(left.box, { left: 26, right: 6, rise: 10, drop: 12 });
  assert.equal(span(left).left, 100 + BED_PILLOW_INSET_PX, 'the head on the pillow');
  const right = lieInBed(upright, bed('right'));
  assert.equal(right.turn, 1, 'clockwise: the top goes right');
  assert.deepEqual(right.box, { left: 6, right: 26, rise: 12, drop: 10 });
  assert.equal(span(right).right, 148 - BED_PILLOW_INSET_PX);
  for (const lie of [left, right]) {
    const s = span(lie);
    assert.ok(s.left >= 100 + BED_BOARD_PX && s.right <= 148 - BED_BOARD_PX, 'between the boards');
  }
});

test('a turn and its reverse give the box back', () => {
  const box: PoseBox = { left: 3, right: 9, rise: 20, drop: 2 };
  assert.deepEqual(turnBox(turnBox(box, -1), 1), box);
  assert.deepEqual(turnBox(turnBox(box, 1), -1), box);
  assert.deepEqual(turnBox(box, 0), box);
});

test('a body longer than the mattress lies centred over both boards', () => {
  const long: PoseBox = { left: 22, right: 20, rise: 16, drop: 2 };
  for (const pillow of ['left', 'right'] as const) {
    const s = span(lieInBed(long, bed(pillow)));
    assert.equal(s.right - s.left, 42);
    assert.equal(s.left - 100, 148 - s.right, `${pillow}: centred`);
  }
});

test('a body too tall for the bed sinks toward the front, never past the limit', () => {
  const tall: PoseBox = { left: 17, right: 15, rise: 20, drop: 6 };
  const s = span(lieInBed(tall, bed('left')));
  assert.equal(s.top, 200, 'its top on the bed’s top edge');
  assert.equal(s.bottom, 226, 'three pixels lower than the base');
  const huge: PoseBox = { left: 20, right: 20, rise: 36, drop: 0 };
  const h = span(lieInBed(huge, bed('left')));
  assert.equal(h.bottom, 232 - BED_SLEEPER_SINK_LIMIT_PX, 'sunk only to the limit');
});

/** Any opaque sprite pixel (SpriteData marks transparency with ''). */
const OPAQUE = 'x';

test('spritePoseBox measures an upstream sprite from its bottom centre', () => {
  const row = (fill: string, from: number, to: number) =>
    Array.from({ length: 16 }, (_, x) => (x >= from && x <= to ? fill : ''));
  const sprite = [
    ...Array.from({ length: 3 }, () => row('', 0, -1)),
    ...Array.from({ length: 28 }, () => row(OPAQUE, 2, 13)),
    row('', 0, -1),
  ];
  assert.deepEqual(spritePoseBox(sprite), { left: 6, right: 6, rise: 29, drop: -1 });
  assert.equal(spritePoseBox(sprite), spritePoseBox(sprite), 'measured once');
});
