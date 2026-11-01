import { describe, expect, it } from 'vitest';

import type { TopBarSizes } from '../src/components/topBarLayout.js';
import { balancedRowWidth, officeRightCover, placeTopBar } from '../src/components/topBarLayout.js';
import {
  OFFICE_TOP_BAR_EDGE_PX,
  OFFICE_TOP_BAR_GAP_PX,
  ZOOM_CONTROLS_BOTTOM_PX,
  ZOOM_CONTROLS_RIGHT_PX,
} from '../src/constants.js';

// Sizes measured in the demo office: the Conductor toolbar (Sessions, PC,
// Music, Layout, Settings) is 448 × 61; EditActionBar is 268 × 53.
const TOOLBAR = { toolbarWidth: 448, columnHeight: 61 };
const EDIT_ACTIONS = { laneWidth: 268, laneHeight: 53 };
const edge = OFFICE_TOP_BAR_EDGE_PX;
const gap = OFFICE_TOP_BAR_GAP_PX;

function sizes(overrides: Partial<TopBarSizes>): TopBarSizes {
  return {
    areaWidth: 1200,
    toolbarWidth: 0,
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

describe('officeRightCover', () => {
  it('is the card column alone while the Pokédex is docked or closed', () => {
    expect(officeRightCover(0, null)).toBe('0px');
    expect(officeRightCover(72, null)).toBe('72px');
  });

  it('adds the drawer, capped at the room the card column leaves', () => {
    expect(officeRightCover(72, 360)).toBe('calc(72px + min(360px, 100% - 72px))');
  });
});
