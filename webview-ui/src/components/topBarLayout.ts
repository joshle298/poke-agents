import {
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

/** Measured sizes, CSS px. */
export interface TopBarSizes {
  /** Width of the free area. */
  areaWidth: number;
  /** The toolbar (0 when there is none: a read-only office). */
  toolbarWidth: number;
  /** The right-hand column: the toolbar and what stacks under it (the
   *  now-playing pill, the first-run tooltip); 0 when empty. */
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
  return { laneTop, toastsTop: above > 0 ? above + gap : edge };
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
