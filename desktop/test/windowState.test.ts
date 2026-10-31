import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseWindowState, placeWindow, type Rect, type WindowState } from '../src/windowState.js';

const LIMITS = { minWidth: 720, minHeight: 480, defaultWidth: 1280, defaultHeight: 820 };
/** A 1512x982 laptop display minus the menu bar. */
const LAPTOP: Rect = { x: 0, y: 25, width: 1512, height: 957 };
/** An external display to the laptop's right. */
const EXTERNAL: Rect = { x: 1512, y: 0, width: 2560, height: 1415 };

const saved = (bounds: Rect, flags: Partial<WindowState> = {}): WindowState => ({
  bounds,
  maximized: false,
  fullScreen: false,
  ...flags,
});

describe('parseWindowState', () => {
  it('accepts a saved frame, rounding it', () => {
    assert.deepEqual(
      parseWindowState({
        bounds: { x: 10.4, y: 20, width: 900, height: 600.6 },
        maximized: true,
      }),
      saved({ x: 10, y: 20, width: 900, height: 601 }, { maximized: true }),
    );
  });

  it('rejects anything else', () => {
    for (const raw of [
      null,
      'x',
      {},
      { bounds: { x: 0, y: 0, width: 0, height: 600 } },
      { bounds: { x: 0, y: 0, width: 800, height: '600' } },
      { bounds: { x: Number.NaN, y: 0, width: 800, height: 600 } },
    ]) {
      assert.equal(parseWindowState(raw), null, JSON.stringify(raw));
    }
  });
});

describe('placeWindow', () => {
  it('opens centered at the default size the first time', () => {
    assert.deepEqual(placeWindow(null, [LAPTOP], LIMITS), {
      width: 1280,
      height: 820,
      maximized: false,
      fullScreen: false,
    });
  });

  it('keeps a frame that still fits where it was', () => {
    const frame = { x: 1600, y: 100, width: 1000, height: 700 };
    assert.deepEqual(placeWindow(saved(frame), [LAPTOP, EXTERNAL], LIMITS), {
      ...frame,
      maximized: false,
      fullScreen: false,
    });
  });

  it('never opens smaller than the minimum or larger than the display', () => {
    const tiny = placeWindow(saved({ x: 50, y: 50, width: 200, height: 100 }), [LAPTOP], LIMITS);
    assert.equal(tiny.width, 720);
    assert.equal(tiny.height, 480);
    const huge = placeWindow(saved({ x: 0, y: 0, width: 5000, height: 3000 }), [LAPTOP], LIMITS);
    assert.deepEqual(
      { x: huge.x, y: huge.y, width: huge.width, height: huge.height },
      { x: 0, y: 25, width: 1512, height: 957 },
    );
  });

  it('pulls a frame hanging off a display fully back onto it', () => {
    const placed = placeWindow(
      saved({ x: 1100, y: -200, width: 1000, height: 700 }),
      [LAPTOP],
      LIMITS,
    );
    assert.deepEqual({ x: placed.x, y: placed.y }, { x: 512, y: 25 });
  });

  it('chooses the display the frame overlaps most', () => {
    // Mostly on the external display, a little on the laptop.
    const placed = placeWindow(
      saved({ x: 1300, y: 200, width: 1000, height: 700 }),
      [LAPTOP, EXTERNAL],
      LIMITS,
    );
    assert.deepEqual({ x: placed.x, y: placed.y }, { x: 1512, y: 200 });
  });

  it('centers a frame whose display is gone, keeping its size and flags', () => {
    assert.deepEqual(
      placeWindow(
        saved({ x: 1600, y: 100, width: 1000, height: 700 }, { maximized: true }),
        [LAPTOP],
        LIMITS,
      ),
      { width: 1000, height: 700, maximized: true, fullScreen: false },
    );
  });

  it('still honors the minimum size without display information', () => {
    assert.deepEqual(placeWindow(saved({ x: 0, y: 0, width: 300, height: 300 }), [], LIMITS), {
      width: 720,
      height: 480,
      maximized: false,
      fullScreen: false,
    });
  });
});
