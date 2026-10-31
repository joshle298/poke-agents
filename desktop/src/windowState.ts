/**
 * The office window's remembered frame: parsing what was saved (a small JSON
 * file in the app's userData folder) and fitting it to the displays attached
 * now. Pure; main.ts does the file I/O.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What is saved between launches. */
export interface WindowState {
  /** The normal (not maximized, not full screen) frame. */
  bounds: Rect;
  maximized: boolean;
  fullScreen: boolean;
}

export interface WindowLimits {
  minWidth: number;
  minHeight: number;
  defaultWidth: number;
  defaultHeight: number;
}

/** Where to open the window. No x/y: let the system center it. */
export interface WindowPlacement {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
  fullScreen: boolean;
}

/** A saved state, or null when the file holds anything else. */
export function parseWindowState(raw: unknown): WindowState | null {
  if (!isRecord(raw) || !isRecord(raw.bounds)) return null;
  const { x, y, width, height } = raw.bounds;
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return null;
  }
  if ((width as number) <= 0 || (height as number) <= 0) return null;
  return {
    bounds: {
      x: Math.round(x as number),
      y: Math.round(y as number),
      width: Math.round(width as number),
      height: Math.round(height as number),
    },
    maximized: raw.maximized === true,
    fullScreen: raw.fullScreen === true,
  };
}

/**
 * Fit a saved frame to the current displays' work areas (screen minus menu
 * bar and Dock): keep it at least the minimum size and at most the display's,
 * and put it fully on the display it overlaps most. A frame that no longer
 * overlaps any display (that monitor is gone) opens centered at its saved size
 * instead. Without a saved frame, or without display information, the window
 * opens centered at the default size.
 */
export function placeWindow(
  saved: WindowState | null,
  workAreas: readonly Rect[],
  limits: WindowLimits,
): WindowPlacement {
  const primary = workAreas[0];
  const flags = { maximized: saved?.maximized ?? false, fullScreen: saved?.fullScreen ?? false };
  const wanted = saved?.bounds ?? {
    x: 0,
    y: 0,
    width: limits.defaultWidth,
    height: limits.defaultHeight,
  };
  if (!primary) {
    return {
      width: Math.max(limits.minWidth, wanted.width),
      height: Math.max(limits.minHeight, wanted.height),
      ...flags,
    };
  }

  let area = primary;
  let best = 0;
  if (saved) {
    for (const candidate of workAreas) {
      const overlap = overlapArea(saved.bounds, candidate);
      if (overlap > best) {
        best = overlap;
        area = candidate;
      }
    }
  }
  const width = clamp(wanted.width, limits.minWidth, Math.max(limits.minWidth, area.width));
  const height = clamp(wanted.height, limits.minHeight, Math.max(limits.minHeight, area.height));
  if (!saved || best === 0) return { width, height, ...flags };
  return {
    x: clamp(wanted.x, area.x, area.x + area.width - width),
    y: clamp(wanted.y, area.y, area.y + area.height - height),
    width,
    height,
    ...flags,
  };
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Clamp into [min, max]; when the range is empty, `min` wins. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
