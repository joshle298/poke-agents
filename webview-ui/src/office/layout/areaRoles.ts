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

/**
 * Where the camera starts in a town larger than the window: the middle of the
 * box around the Lab and the main work area (the `field` Area with the most
 * tiles), in world tiles (a half tile is a tile's centre). Null when the
 * layout has neither: the map stays centred, as before.
 */
export function townCameraHome(
  layout: Pick<OfficeLayout, 'cols' | 'areas' | 'areaTiles'>,
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
  let minC = Infinity;
  let maxC = -Infinity;
  let minR = Infinity;
  let maxR = -Infinity;
  for (let i = 0; i < tiles.length; i++) {
    const label = tiles[i];
    if (!label || (roleOf.get(label) !== 'lab' && label !== mainField)) continue;
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    minC = Math.min(minC, col);
    maxC = Math.max(maxC, col);
    minR = Math.min(minR, row);
    maxR = Math.max(maxR, row);
  }
  if (minC === Infinity) return null;
  return { col: (minC + maxC + 1) / 2, row: (minR + maxR + 1) / 2 };
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
