/**
 * World coordinates → screen coordinates, in one place.
 *
 * The office is drawn by centering the map in the canvas and then applying the
 * pan, both snapped to whole device pixels so sprites stay on the pixel grid.
 * That formula was reproduced in the renderer and in each DOM overlay that
 * floats something above a character; a copy that rounds differently puts the
 * overlay a pixel off the sprite it is labelling, which is invisible in review
 * and obvious on screen.
 *
 * Deliberately free of DOM access — `dpr` is passed in, not read from
 * `window`. Reading the environment belongs at the component boundary; a state
 * or math module that reaches for `window` drags the DOM into every module
 * graph that imports it.
 */

import { TILE_SIZE } from './types.js';

/** Device-pixel offset of the map's top-left corner inside the canvas.
 *  This is the renderer's own frame of reference — overlays go through
 *  {@link overlayProjection} instead of calling this directly. */
export function mapOffset(
  canvasWidth: number,
  canvasHeight: number,
  cols: number,
  rows: number,
  zoom: number,
  panX: number,
  panY: number,
): { offsetX: number; offsetY: number } {
  const mapW = cols * TILE_SIZE * zoom;
  const mapH = rows * TILE_SIZE * zoom;
  return {
    offsetX: Math.floor((canvasWidth - mapW) / 2) + Math.round(panX),
    offsetY: Math.floor((canvasHeight - mapH) / 2) + Math.round(panY),
  };
}

/**
 * Clamp a camera pan on one axis so the map never leaves empty canvas on that
 * axis it could have filled: a map that fits (`mapPx` ≤ `viewPx`) stays
 * centred (pan 0); a larger one may follow its target only until a map edge
 * reaches the viewport's edge. Device px, like the pan itself.
 */
export function clampPanAxis(pan: number, mapPx: number, viewPx: number): number {
  const slack = (mapPx - viewPx) / 2;
  if (slack <= 0) return 0;
  return Math.max(-slack, Math.min(slack, pan));
}

/**
 * Clamp a pan the user makes (wheel, drag, pinch, zoom). `tight` (the town,
 * not editing): per axis like a follow (clampPanAxis), so panning and zooming
 * never show empty canvas the map could fill. Otherwise the map's edge may
 * come `marginFraction` of the canvas inside it, room to edit at the edges.
 * Device px.
 */
export function clampManualPan(
  pan: { x: number; y: number },
  map: { w: number; h: number },
  view: { w: number; h: number },
  { tight, marginFraction }: { tight: boolean; marginFraction: number },
): { x: number; y: number } {
  if (tight) {
    return { x: clampPanAxis(pan.x, map.w, view.w), y: clampPanAxis(pan.y, map.h, view.h) };
  }
  const maxX = map.w / 2 + view.w / 2 - view.w * marginFraction;
  const maxY = map.h / 2 + view.h / 2 - view.h * marginFraction;
  return {
    x: Math.max(-maxX, Math.min(maxX, pan.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.y)),
  };
}

/**
 * The pan after a zoom from `from` to `to` that keeps the world point under
 * `anchor` where it is on screen. `anchor` is device px from the canvas
 * centre (the cursor for a wheel or pinch zoom); the default, the centre,
 * is what the zoom buttons use. Without this the view would jump on a map
 * panned far from its middle.
 */
export function panForZoom(
  pan: { x: number; y: number },
  from: number,
  to: number,
  anchor: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  const k = to / from;
  return { x: anchor.x - k * (anchor.x - pan.x), y: anchor.y - k * (anchor.y - pan.y) };
}

/**
 * The pan that puts world point (`x`, `y`) (world px) in the middle of the
 * view, clamped per axis like a follow (clampPanAxis): the camera's start in
 * a town larger than the window. Device px.
 */
export function panToCentre(
  point: { x: number; y: number },
  layout: { cols: number; rows: number },
  zoom: number,
  view: { w: number; h: number },
): { x: number; y: number } {
  const mapW = layout.cols * TILE_SIZE * zoom;
  const mapH = layout.rows * TILE_SIZE * zoom;
  return {
    x: clampPanAxis(mapW / 2 - point.x * zoom, mapW, view.w),
    y: clampPanAxis(mapH / 2 - point.y * zoom, mapH, view.h),
  };
}

/** Projects world points into CSS pixels within the overlay container that
 *  sits on top of the canvas. */
export interface OverlayProjection {
  toScreenX(worldX: number): number;
  toScreenY(worldY: number): number;
  /** Container size in world units — what the viewport currently covers.
   *  Used to cap overlay offsets against the visible area. */
  readonly viewportWorldWidth: number;
  readonly viewportWorldHeight: number;
  /** CSS px → world units, for sizing overlay geometry in world terms. */
  toWorldLength(cssPx: number): number;
}

export function overlayProjection(
  layout: { cols: number; rows: number },
  containerRect: { width: number; height: number },
  zoom: number,
  pan: { x: number; y: number },
  dpr: number,
): OverlayProjection {
  const canvasW = Math.round(containerRect.width * dpr);
  const canvasH = Math.round(containerRect.height * dpr);
  const { offsetX, offsetY } = mapOffset(
    canvasW,
    canvasH,
    layout.cols,
    layout.rows,
    zoom,
    pan.x,
    pan.y,
  );
  return {
    toScreenX: (worldX) => (offsetX + worldX * zoom) / dpr,
    toScreenY: (worldY) => (offsetY + worldY * zoom) / dpr,
    viewportWorldWidth: canvasW / zoom,
    viewportWorldHeight: canvasH / zoom,
    toWorldLength: (cssPx) => (cssPx * dpr) / zoom,
  };
}
