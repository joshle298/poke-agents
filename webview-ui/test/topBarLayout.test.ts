import { describe, expect, it } from 'vitest';

import type { Rect, TopBarSizes } from '../src/components/topBarLayout.js';
import {
  balancedRowWidth,
  officeRightCover,
  placeBattleLog,
  placeTopBar,
} from '../src/components/topBarLayout.js';
import {
  BATTLE_LOG_EDGE_GAP_PX,
  OFFICE_TOP_BAR_EDGE_PX,
  OFFICE_TOP_BAR_GAP_PX,
  TOAST_MAX_WIDTH_PX,
  ZOOM_CONTROLS_BOTTOM_PX,
  ZOOM_CONTROLS_RIGHT_PX,
} from '../src/constants.js';

// Sizes measured in the demo office: the Conductor toolbar (Sessions, PC,
// Music, Layout, Settings) is 448 × 61; EditActionBar is 268 × 53.
const TOOLBAR = { toolbarWidth: 448, columnWidth: 448, columnHeight: 61 };
const EDIT_ACTIONS = { laneWidth: 268, laneHeight: 53 };
const edge = OFFICE_TOP_BAR_EDGE_PX;
const gap = OFFICE_TOP_BAR_GAP_PX;

function sizes(overrides: Partial<TopBarSizes>): TopBarSizes {
  return {
    areaWidth: 1200,
    toolbarWidth: 0,
    columnWidth: 0,
    columnHeight: 0,
    laneWidth: 0,
    laneHeight: 0,
    ...overrides,
  };
}

/** The horizontal span of the centred pills and of the toolbar. */
function spans(s: TopBarSizes) {
  const laneLeft = (s.areaWidth - s.laneWidth) / 2;
  return {
    lane: [laneLeft, laneLeft + s.laneWidth],
    toolbar: [s.areaWidth - edge - s.toolbarWidth, s.areaWidth - edge],
  };
}

describe('placeTopBar', () => {
  it('keeps the centre pills at the top when they fit between the zoom buttons and the toolbar', () => {
    // 1400 px window, party bar 200 px wide: EditActionBar centred at 600
    // ends at 734, the toolbar starts at 744.
    const s = sizes({ ...TOOLBAR, ...EDIT_ACTIONS });
    const { lane, toolbar } = spans(s);
    expect(lane[1] + gap).toBeLessThanOrEqual(toolbar[0]);
    expect(placeTopBar(s).laneTop).toBe(edge);
  });

  it('moves the centre pills under the toolbar when they would reach it', () => {
    // 1100 px window: the office is 900 px wide and the centred bar would
    // run into the toolbar.
    const s = sizes({ areaWidth: 900, ...TOOLBAR, ...EDIT_ACTIONS });
    const { lane, toolbar } = spans(s);
    expect(lane[1] + gap).toBeGreaterThan(toolbar[0]);
    const { laneTop } = placeTopBar(s);
    expect(laneTop).toBe(edge + TOOLBAR.columnHeight + gap);
    expect(laneTop).toBeGreaterThan(edge + TOOLBAR.columnHeight);
  });

  it('also clears the zoom buttons when the moved pills reach under them', () => {
    // A narrow office (a docked Pokédex beside it): the moved bar would
    // start left of the zoom buttons' edge, which reach lower than the
    // toolbar column.
    const s = sizes({
      areaWidth: 300,
      toolbarWidth: 236,
      columnWidth: 236,
      columnHeight: 40,
      ...EDIT_ACTIONS,
    });
    expect(spans(s).lane[0]).toBeLessThan(ZOOM_CONTROLS_RIGHT_PX + gap);
    expect(placeTopBar(s).laneTop).toBe(ZOOM_CONTROLS_BOTTOM_PX + gap);
  });

  it('puts the moved pills under everything stacked in the toolbar column', () => {
    // The now-playing pill under the toolbar makes the column 105 px tall.
    const s = sizes({ areaWidth: 900, ...TOOLBAR, columnHeight: 105, ...EDIT_ACTIONS });
    expect(placeTopBar(s).laneTop).toBe(edge + 105 + gap);
  });

  it('keeps an empty lane at the top', () => {
    expect(placeTopBar(sizes({ areaWidth: 400, ...TOOLBAR })).laneTop).toBe(edge);
  });

  it('stacks toasts under the toolbar column', () => {
    expect(placeTopBar(sizes({ ...TOOLBAR })).toastsTop).toBe(edge + TOOLBAR.columnHeight + gap);
    expect(placeTopBar(sizes({ ...TOOLBAR, columnHeight: 105 })).toastsTop).toBe(edge + 105 + gap);
  });

  it('stacks toasts under the centre pills when those moved into the toasts strip', () => {
    const s = sizes({ areaWidth: 900, ...TOOLBAR, ...EDIT_ACTIONS });
    const { laneTop, toastsTop } = placeTopBar(s);
    // The bar spans 316..584 and the toasts strip starts at 900 - 8 - 320.
    expect(spans(s).lane[1]).toBeGreaterThan(s.areaWidth - edge - TOAST_MAX_WIDTH_PX);
    expect(toastsTop).toBe(laneTop + EDIT_ACTIONS.laneHeight + gap);
  });

  it('leaves toasts under the toolbar when the pills sit clear of their strip', () => {
    const s = sizes({ ...TOOLBAR, ...EDIT_ACTIONS });
    expect(placeTopBar(s).toastsTop).toBe(edge + TOOLBAR.columnHeight + gap);
  });

  it('puts toasts at the top edge of a read-only office (no toolbar)', () => {
    expect(placeTopBar(sizes({})).toastsTop).toBe(edge);
  });

  it('reports the zoom buttons, the toolbar column and the moved pills as occupied', () => {
    const s = sizes({ areaWidth: 900, ...TOOLBAR, ...EDIT_ACTIONS });
    const { laneTop, occupied } = placeTopBar(s);
    expect(occupied).toEqual([
      { left: 0, top: 0, right: ZOOM_CONTROLS_RIGHT_PX, bottom: ZOOM_CONTROLS_BOTTOM_PX },
      { left: 900 - edge - 448, top: edge, right: 900 - edge, bottom: edge + 61 },
      { left: 316, top: laneTop, right: 584, bottom: laneTop + EDIT_ACTIONS.laneHeight },
    ]);
  });

  it('reports only the zoom buttons in an office with nothing at its top edge', () => {
    expect(placeTopBar(sizes({})).occupied).toHaveLength(1);
  });
});

// Button widths measured in the demo office: Sessions, PC, Music, Layout,
// Settings (+ Agent first when Claude feeds the office), 4 px apart.
const BUTTONS = [104, 52, 80, 88, 100];
const BUTTON_GAP = 4;
const oneRow = (widths: number[]) =>
  widths.reduce((sum, w) => sum + w, 0) + BUTTON_GAP * (widths.length - 1);

describe('balancedRowWidth', () => {
  it('is the one-row width when that fits', () => {
    expect(balancedRowWidth(BUTTONS, BUTTON_GAP, 1000)).toBe(oneRow(BUTTONS));
    expect(balancedRowWidth(BUTTONS, BUTTON_GAP, oneRow(BUTTONS))).toBe(oneRow(BUTTONS));
  });

  it('balances two rows instead of leaving the last button alone', () => {
    // At 364 px greedy wrapping puts four buttons on row 1 and Settings alone
    // on row 2 (the review's 860 px drawer case); balanced, row 1 is
    // Sessions, PC, Music and the panel hugs it.
    expect(oneRow(BUTTONS.slice(0, 4))).toBeLessThanOrEqual(364);
    expect(balancedRowWidth(BUTTONS, BUTTON_GAP, 364)).toBe(oneRow(BUTTONS.slice(0, 3)));
  });

  it('takes no more rows than the room needs', () => {
    // Three rows at 200 px (no split into two fits); the widest of the best
    // three is Music and Layout.
    const width = balancedRowWidth(BUTTONS, BUTTON_GAP, 200);
    expect(width).toBeLessThanOrEqual(200);
    expect(width).toBe(oneRow([80, 88]));
  });

  it('keeps the widest button when nothing fits beside it', () => {
    expect(balancedRowWidth(BUTTONS, BUTTON_GAP, 50)).toBe(104);
  });

  it('is 0 with no buttons', () => {
    expect(balancedRowWidth([], BUTTON_GAP, 300)).toBe(0);
  });
});

describe('placeBattleLog', () => {
  const LOG = { logWidth: 300, logHeight: 49 };
  const gapLog = BATTLE_LOG_EDGE_GAP_PX;
  const place = (areaHeight: number, obstacles: Rect[], areaWidth = 900) =>
    placeBattleLog({ areaWidth, areaHeight, ...LOG, obstacles });

  it('sits a quarter of the office height above the bottom edge', () => {
    expect(place(900, [])).toBe(900 * 0.75 - LOG.logHeight);
  });

  it('moves above the layout editor palette when that reaches the spot', () => {
    const palette = { left: 10, top: 500, right: 600, bottom: 890 };
    expect(place(900, [palette])).toBe(500 - gapLog - LOG.logHeight);
  });

  it('ignores what is beside it rather than across its width', () => {
    // The log spans 300..600; a column at the right edge doesn't move it.
    const column = { left: 640, top: 8, right: 892, bottom: 800 };
    expect(place(900, [column])).toBe(900 * 0.75 - LOG.logHeight);
  });

  it('moves below the top chrome on a short window', () => {
    // 300 px tall: the quarter spot (176) is inside pills that end at 200.
    const pills = { left: 316, top: 77, right: 584, bottom: 200 };
    expect(place(300, [pills])).toBe(200 + gapLog);
  });

  it('hides when nothing between the palette and the top bar is clear', () => {
    // 1100 × 300 in the layout editor: the toolbar column, EditActionBar
    // under it ending at 130, and the palette from 150.
    const column = { left: 444, top: 8, right: 892, bottom: 69 };
    const pills = { left: 316, top: 77, right: 584, bottom: 130 };
    const palette = { left: 10, top: 150, right: 600, bottom: 290 };
    expect(place(300, [column, pills, palette])).toBeNull();
    // Without the palette its own spot is clear again.
    expect(place(300, [column, pills])).toBe(300 * 0.75 - LOG.logHeight);
  });

  it('is null until measured', () => {
    expect(
      placeBattleLog({ areaWidth: 0, areaHeight: 0, logWidth: 0, logHeight: 0, obstacles: [] }),
    ).toBeNull();
  });
});

describe('officeRightCover', () => {
  it('is the card column alone while the Pokédex is docked or closed', () => {
    expect(officeRightCover(0, null)).toBe('0px');
    expect(officeRightCover(72, null)).toBe('72px');
  });

  it('adds the drawer, capped at the room the card column leaves', () => {
    expect(officeRightCover(72, 360)).toBe('calc(72px + min(360px, 100% - 72px))');
  });
});
