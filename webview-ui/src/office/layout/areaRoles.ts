/**
 * Area roles: which tiles of a layout belong to its Meadow, its Pokémon Center,
 * its lectern, its Lab and its fields (outdoor work areas). Pure and DOM-free
 * (Node-tested). A role lives on the Area definition (`AreaDefinition.role`),
 * so the existing Areas tool paints and erases role tiles, and rename,
 * recolor, export and import carry the role along.
 */

import type { AreaRole, OfficeLayout } from '../types.js';

/** Tile keys (`"col,row"`) per role. An empty set means the layout has no such area. */
export interface AreaRoleTiles {
  meadow: ReadonlySet<string>;
  center: ReadonlySet<string>;
  /** Seats on these tiles are kept for Leads. */
  lectern: ReadonlySet<string>;
  /** The Lab: its seats are for working Leads only. */
  lab: ReadonlySet<string>;
  /** Outdoor work areas: every other working session sits (or stands) here. */
  field: ReadonlySet<string>;
}

export function tileKey(col: number, row: number): string {
  return `${col},${row}`;
}

const ROLES: readonly AreaRole[] = ['meadow', 'center', 'lectern', 'lab', 'field'];

/**
 * The tiles painted with an Area whose definition carries each role. Several
 * Areas may share a role; their tiles are merged. Returns null when the layout
 * has no role tiles at all, which is the signal to keep the upstream behavior.
 */
export function areaRoleTiles(
  layout: Pick<OfficeLayout, 'cols' | 'areas' | 'areaTiles'>,
): AreaRoleTiles | null {
  const areas = layout.areas ?? [];
  const tiles = layout.areaTiles ?? [];
  if (areas.length === 0 || tiles.length === 0) return null;
  const roleByLabel = new Map<string, AreaRole>();
  for (const area of areas)
    if (area.role && ROLES.includes(area.role)) roleByLabel.set(area.label, area.role);
  if (roleByLabel.size === 0) return null;

  const byRole: Record<AreaRole, Set<string>> = {
    meadow: new Set(),
    center: new Set(),
    lectern: new Set(),
    lab: new Set(),
    field: new Set(),
  };
  for (let i = 0; i < tiles.length; i++) {
    const label = tiles[i];
    if (!label) continue;
    const role = roleByLabel.get(label);
    if (!role) continue;
    byRole[role].add(tileKey(i % layout.cols, Math.floor(i / layout.cols)));
  }
  if (ROLES.every((role) => byRole[role].size === 0)) return null;
  return byRole;
}

/**
 * Whether the town seats sessions by zone: a Lab for working Leads and fields
 * for everyone else working. Without a `lab` or a `field` (the classic office,
 * a town saved before they existed, user layouts) seats keep their old rules.
 */
export function isZonedTown(roles: AreaRoleTiles | null): boolean {
  return roles !== null && (roles.lab.size > 0 || roles.field.size > 0);
}

/** Tiles of room kept around the Lab in the home view: its walls, and a
 *  speech bubble or a name beside a Lead at an end desk. */
const HOME_LAB_MARGIN_TILES = 1.5;

/** Tile bounds: first and last col and row (inclusive). */
interface TileBox {
  minC: number;
  maxC: number;
  minR: number;
  maxR: number;
}

/**
 * Where on one axis the view's middle goes: the middle of the whole box
 * (`lo`..`hi`, exclusive end) when it fits in `span` tiles; when it doesn't,
 * as near that as keeps the Lab (`keepLo`..`keepHi`) and its margin in view;
 * when even the Lab doesn't fit, the Lab's middle.
 */
function homeAxis(
  lo: number,
  hi: number,
  keepLo: number,
  keepHi: number,
  span: number | undefined,
): number {
  const mid = (lo + hi) / 2;
  if (span === undefined || hi - lo <= span) return mid;
  const from = keepHi + HOME_LAB_MARGIN_TILES - span / 2;
  const to = keepLo - HOME_LAB_MARGIN_TILES + span / 2;
  if (from > to) return (keepLo + keepHi) / 2;
  return Math.max(from, Math.min(to, mid));
}

/**
 * Where the camera starts in a town larger than the window, in world tiles
 * (a half tile is a tile's centre): the middle of the box around the Lab and
 * the main work area (the `field` Area with the most tiles). When `view` (the
 * window, in tiles) is too small for that box, the Lab stays whole and the
 * work area fills the rest. Null when the layout has neither: the map stays
 * centred, as before.
 */
export function townCameraHome(
  layout: Pick<OfficeLayout, 'cols' | 'areas' | 'areaTiles'>,
  view?: { cols: number; rows: number },
): { col: number; row: number } | null {
  const areas = layout.areas ?? [];
  const tiles = layout.areaTiles ?? [];
  const roleOf = new Map(areas.map((a) => [a.label, a.role]));
  const fieldCounts = new Map<string, number>();
  for (const label of tiles) {
    if (label && roleOf.get(label) === 'field') {
      fieldCounts.set(label, (fieldCounts.get(label) ?? 0) + 1);
    }
  }
  let mainField: string | null = null;
  for (const [label, n] of fieldCounts) {
    if (mainField === null || n > (fieldCounts.get(mainField) ?? 0)) mainField = label;
  }
  const box = (keep: (label: string) => boolean): TileBox | null => {
    let minC = Infinity;
    let maxC = -Infinity;
    let minR = Infinity;
    let maxR = -Infinity;
    for (let i = 0; i < tiles.length; i++) {
      const label = tiles[i];
      if (!label || !keep(label)) continue;
      const col = i % layout.cols;
      const row = Math.floor(i / layout.cols);
      minC = Math.min(minC, col);
      maxC = Math.max(maxC, col);
      minR = Math.min(minR, row);
      maxR = Math.max(maxR, row);
    }
    return minC === Infinity ? null : { minC, maxC, minR, maxR };
  };
  const all = box((label) => roleOf.get(label) === 'lab' || label === mainField);
  if (!all) return null;
  const lab = box((label) => roleOf.get(label) === 'lab') ?? all;
  return {
    col: homeAxis(all.minC, all.maxC + 1, lab.minC, lab.maxC + 1, view?.cols),
    row: homeAxis(all.minR, all.maxR + 1, lab.minR, lab.maxR + 1, view?.rows),
  };
}

/**
 * How far a Center tile is from the Center's edge: the shorter of the runs of
 * Center tiles to its left and to its right. A wide sprite resting on a tile
 * with clearance N spills at most N tiles sideways without crossing a wall.
 */
export function centerClearance(center: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const key of center) {
    const [col, row] = key.split(',').map(Number);
    let left = 0;
    while (center.has(tileKey(col - left - 1, row))) left++;
    let right = 0;
    while (center.has(tileKey(col + right + 1, row))) right++;
    out.set(key, Math.min(left, right));
  }
  return out;
}
