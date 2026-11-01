import {
  OFFICE_TOP_BAR_EDGE_PX,
  OFFICE_TOP_BAR_GAP_PX,
  ZOOM_CONTROLS_BOTTOM_PX,
  ZOOM_CONTROLS_RIGHT_PX,
} from '../constants.js';

/**
 * Where the desktop office's top chrome goes (DOM-free; OfficeTopBar measures
 * and applies it). The toolbar is fixed in the top-right corner of the free
 * area: the office left of whatever covers its right edge. The top-centre
 * pills (EditActionBar, the rotate hint, the zoom level, the connection
 * status) stay at the top while they fit between the zoom buttons and the
 * toolbar, and otherwise move under the toolbar's column, so nothing in the
 * top area ever overlaps. (Toasts and the battle log are in the message bar
 * under the office.)
 */

/** Measured sizes, CSS px. */
export interface TopBarSizes {
  /** Width of the free area. */
  areaWidth: number;
  /** The toolbar (0 when there is none: a read-only office). */
  toolbarWidth: number;
  /** The right-hand column's height: the toolbar and what stacks under it
   *  (the now-playing pill, the first-run tooltip); 0 when empty. */
  columnHeight: number;
  /** The top-centre pills, stacked (0 × 0 while none shows). */
  laneWidth: number;
  laneHeight: number;
}

export interface TopBarPlacement {
  /** Top of the top-centre pills. */
  laneTop: number;
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
  return { laneTop };
}

/**
 * The narrowest content width at which items `widths` wide, `gap` apart and
 * wrapped in order, take no more rows than they do at `maxWidth`: the
 * toolbar's width when one row doesn't fit, so its rows come out balanced
 * (Sessions, Archive, Music over Layout, Settings rather than one button alone on
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
 * What covers the office's right edge, as a CSS length (percentages of the
 * office's width): the upstream card column (theme off) and, on narrow
 * windows, the Pokédex drawer beside it (SessionPanel's drawer frame).
 */
export function officeRightCover(cardColumnPx: number, drawerPx: number | null): string {
  if (drawerPx === null) return `${cardColumnPx}px`;
  return `calc(${cardColumnPx}px + min(${drawerPx}px, 100% - ${cardColumnPx}px))`;
}
