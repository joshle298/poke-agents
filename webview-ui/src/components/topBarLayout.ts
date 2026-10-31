import {
  BATTLE_LOG_BOTTOM_FRACTION,
  BATTLE_LOG_EDGE_GAP_PX,
  OFFICE_TOP_BAR_EDGE_PX,
  OFFICE_TOP_BAR_GAP_PX,
  TOAST_MAX_WIDTH_PX,
  ZOOM_CONTROLS_BOTTOM_PX,
  ZOOM_CONTROLS_RIGHT_PX,
} from '../constants.js';

/**
 * Where the desktop office's top chrome goes (DOM-free; OfficeTopBar measures
 * and applies it). The toolbar is fixed in the top-right corner of the free
 * area: the office left of whatever covers its right edge. The top-centre
 * pills (EditActionBar, the rotate hint, the zoom level, the connection
 * status) stay at the top while they fit between the zoom buttons and the
 * toolbar, and otherwise move under the toolbar's column; toasts go under
 * both, so nothing in the top area ever overlaps.
 */

/** A box in the office's coordinates: CSS px from its top-left corner. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Measured sizes, CSS px. */
export interface TopBarSizes {
  /** Width of the free area. */
  areaWidth: number;
  /** The toolbar (0 when there is none: a read-only office). */
  toolbarWidth: number;
  /** The right-hand column: the toolbar and what stacks under it (the
   *  now-playing pill, the first-run tooltip); 0 × 0 when empty. */
  columnWidth: number;
  columnHeight: number;
  /** The top-centre pills, stacked (0 × 0 while none shows). */
  laneWidth: number;
  laneHeight: number;
}

export interface TopBarPlacement {
  /** Top of the top-centre pills. */
  laneTop: number;
  /** Top of the toast stack, right-aligned under the toolbar. */
  toastsTop: number;
  /** What the top chrome covers (the zoom buttons, the toolbar column, the
   *  centre pills), for what has to keep clear of it (the battle log). */
  occupied: Rect[];
}

export function placeTopBar(sizes: TopBarSizes): TopBarPlacement {
  const edge = OFFICE_TOP_BAR_EDGE_PX;
  const gap = OFFICE_TOP_BAR_GAP_PX;
  const laneLeft = (sizes.areaWidth - sizes.laneWidth) / 2;
  const laneRight = laneLeft + sizes.laneWidth;
  const clearsZoom = laneLeft >= ZOOM_CONTROLS_RIGHT_PX + gap;
  const toolbarLeft = sizes.areaWidth - edge - sizes.toolbarWidth;
  const columnBottom = sizes.columnHeight > 0 ? edge + sizes.columnHeight : 0;

  const laneFitsAtTop = sizes.laneWidth === 0 || (clearsZoom && laneRight + gap <= toolbarLeft);
  const laneTop = laneFitsAtTop
    ? edge
    : Math.max(edge, columnBottom, clearsZoom ? 0 : ZOOM_CONTROLS_BOTTOM_PX) + gap;

  // Toasts are as wide as TOAST_MAX_WIDTH_PX at most; they go under the pills
  // too when the pills reach into that strip.
  const toastsLeft = sizes.areaWidth - edge - TOAST_MAX_WIDTH_PX;
  const laneBottom = sizes.laneWidth > 0 && laneRight > toastsLeft ? laneTop + sizes.laneHeight : 0;
  const above = Math.max(columnBottom, laneBottom);

  const occupied: Rect[] = [
    { left: 0, top: 0, right: ZOOM_CONTROLS_RIGHT_PX, bottom: ZOOM_CONTROLS_BOTTOM_PX },
  ];
  if (sizes.columnHeight > 0) {
    const right = sizes.areaWidth - edge;
    occupied.push({ left: right - sizes.columnWidth, top: edge, right, bottom: columnBottom });
  }
  if (sizes.laneWidth > 0) {
    occupied.push({
      left: laneLeft,
      top: laneTop,
      right: laneRight,
      bottom: laneTop + sizes.laneHeight,
    });
  }
  return { laneTop, toastsTop: above > 0 ? above + gap : edge, occupied };
}

/**
 * The narrowest content width at which items `widths` wide, `gap` apart and
 * wrapped in order, take no more rows than they do at `maxWidth`: the
 * toolbar's width when one row doesn't fit, so its rows come out balanced
 * (Sessions, PC, Music over Layout, Settings rather than one button alone on
 * the second row) and its panel has no empty stretch beside the shorter row.
 * Equal to the one-row width when that fits.
 */
export function balancedRowWidth(widths: readonly number[], gap: number, maxWidth: number): number {
  if (widths.length === 0) return 0;
  const rowsAt = (cap: number) => {
    let rows = 1;
    let line = widths[0];
    for (const width of widths.slice(1)) {
      if (line + gap + width > cap) {
        rows += 1;
        line = width;
      } else {
        line += gap + width;
      }
    }
    return rows;
  };
  const rows = rowsAt(maxWidth);
  // The best width is always some run of consecutive items at least as wide
  // as the widest item: try each.
  const widest = Math.max(...widths);
  let best = Infinity;
  for (let start = 0; start < widths.length; start++) {
    let run = widths[start];
    for (let end = start; end < widths.length; end++) {
      if (end > start) run = run + gap + widths[end];
      if (run >= widest && run < best && rowsAt(run) <= rows) best = run;
    }
  }
  return best;
}

/**
 * Where the battle log goes: the top of its box, `areaHeight` ×
 * BATTLE_LOG_BOTTOM_FRACTION above the area's bottom edge when that is clear,
 * else the clear spot nearest to it (above the layout editor's palette, below
 * the top chrome on a short window); null when no spot between them is clear
 * (the log hides). The log is centred horizontally, so only `obstacles` across
 * its width count.
 */
export function placeBattleLog(input: {
  areaWidth: number;
  areaHeight: number;
  logWidth: number;
  logHeight: number;
  obstacles: readonly Rect[];
}): number | null {
  const { areaWidth, areaHeight, logWidth, logHeight } = input;
  if (areaHeight <= 0 || logHeight <= 0) return null;
  const gap = BATTLE_LOG_EDGE_GAP_PX;
  const left = (areaWidth - logWidth) / 2;
  const right = left + logWidth;
  const across = input.obstacles.filter((o) => o.left < right && o.right > left);
  const highest = gap;
  const lowest = areaHeight - gap - logHeight;
  // Measured sizes are fractional: a spot computed as exactly clear of an
  // obstacle must not fail on rounding.
  const slack = 0.01;
  const clear = (top: number) =>
    top >= highest - slack &&
    top <= lowest + slack &&
    across.every((o) => top + logHeight + gap <= o.top + slack || top >= o.bottom + gap - slack);

  const preferred = areaHeight * (1 - BATTLE_LOG_BOTTOM_FRACTION) - logHeight;
  const candidates = [
    preferred,
    highest,
    lowest,
    ...across.flatMap((o) => [o.top - gap - logHeight, o.bottom + gap]),
  ].filter(clear);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, top) =>
    Math.abs(top - preferred) < Math.abs(best - preferred) ? top : best,
  );
}

/**
 * What covers the office's right edge, as a CSS length (percentages of the
 * office's width): the upstream card column (theme off) and, on narrow
 * windows, the Pokédex drawer beside it (SessionPanel's drawer frame).
 */
export function officeRightCover(cardColumnPx: number, drawerPx: number | null): string {
  if (drawerPx === null) return `${cardColumnPx}px`;
  return `calc(${cardColumnPx}px + min(${drawerPx}px, 100% - ${cardColumnPx}px))`;
}
