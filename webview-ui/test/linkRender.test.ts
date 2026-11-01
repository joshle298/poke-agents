/**
 * Link lines read on any ground: every lit dash pixel is drawn over a dark
 * casing pixel one row below it, and a faint link keeps a visible strength.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { LINK_CASING_COLOR, LINK_COLORS, LINK_DIM_ALPHA } from '../src/constants.js';
import { renderLinks } from '../src/office/engine/connectionsRender.js';
import type { Character, LinkSegment } from '../src/office/types.js';

interface Fill {
  style: string;
  alpha: number;
  x: number;
  y: number;
}

/** Just enough of a 2D context to record the link's pixels: squares filled
 *  one by one, or added to a path and filled together. */
function recordingContext(): { ctx: CanvasRenderingContext2D; fills: Fill[] } {
  const fills: Fill[] = [];
  const state = { fillStyle: '', globalAlpha: 1 };
  let path: Array<{ x: number; y: number }> = [];
  const ctx = {
    canvas: { width: 1000, height: 1000 },
    save() {},
    restore() {},
    fillRect(x: number, y: number) {
      fills.push({ style: state.fillStyle, alpha: state.globalAlpha, x, y });
    },
    beginPath() {
      path = [];
    },
    rect(x: number, y: number) {
      path.push({ x, y });
    },
    fill() {
      for (const p of path) fills.push({ style: state.fillStyle, alpha: state.globalAlpha, ...p });
      path = [];
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills };
}

const at = (x: number, y: number) => ({ x, y }) as Character;

test('every lit pixel of a link sits on a casing pixel drawn before it', () => {
  const { ctx, fills } = recordingContext();
  const link: LinkSegment = { from: at(8, 8), to: at(120, 40), kind: 'spawned' };
  renderLinks(ctx, [link], 0.5, 0, 0, 1);
  const lit = fills.filter((f) => f.style === LINK_COLORS.spawned);
  const casing = fills.filter((f) => f.style === LINK_CASING_COLOR);
  assert.ok(lit.length > 20, `${lit.length} lit pixels`);
  assert.equal(casing.length, lit.length);
  for (const p of lit) {
    const under = fills.findIndex(
      (f) => f.style === LINK_CASING_COLOR && f.x === p.x && f.y === p.y + 1,
    );
    assert.ok(under >= 0 && under < fills.indexOf(p), `casing under (${p.x},${p.y})`);
  }
});

test('the pixels of a link off the canvas are not drawn', () => {
  const { ctx, fills } = recordingContext();
  // From inside the 1000×1000 canvas to far beyond its right edge.
  renderLinks(ctx, [{ from: at(900, 8), to: at(3000, 8), kind: 'spawned' }], 0, 0, 0, 1);
  assert.ok(fills.length > 10, 'the part in view is drawn');
  assert.ok(
    fills.every((f) => f.x < 1000),
    'nothing past the edge',
  );
});

test('a faint link is drawn at LINK_DIM_ALPHA, casing included; a lit one at full strength', () => {
  assert.ok(LINK_DIM_ALPHA >= 0.5, 'faint, but visible on light ground');
  const { ctx, fills } = recordingContext();
  renderLinks(
    ctx,
    [
      { from: at(8, 8), to: at(60, 8), kind: 'spawned', dim: true },
      { from: at(8, 40), to: at(60, 40), kind: 'messaged' },
    ],
    0,
    0,
    0,
    1,
  );
  for (const f of fills) assert.equal(f.alpha, f.y < 24 ? LINK_DIM_ALPHA : 1);
});
