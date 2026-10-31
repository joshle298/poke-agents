/**
 * Area roles: which tiles of a layout belong to its Meadow, its Pokémon Center
 * and its lectern. Pure and DOM-free (Node-tested). A role lives on the Area
 * definition (`AreaDefinition.role`), so the existing Areas tool paints and
 * erases role tiles, and rename, recolor, export and import carry the role
 * along.
 */

import type { AreaRole, OfficeLayout } from '../types.js';

/** Tile keys (`"col,row"`) per role. An empty set means the layout has no such area. */
export interface AreaRoleTiles {
  meadow: ReadonlySet<string>;
  center: ReadonlySet<string>;
  /** Seats on these tiles are kept for Leads. */
  lectern: ReadonlySet<string>;
}

export function tileKey(col: number, row: number): string {
  return `${col},${row}`;
}

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
  for (const area of areas) if (area.role) roleByLabel.set(area.label, area.role);
  if (roleByLabel.size === 0) return null;

  const byRole: Record<AreaRole, Set<string>> = {
    meadow: new Set(),
    center: new Set(),
    lectern: new Set(),
  };
  for (let i = 0; i < tiles.length; i++) {
    const label = tiles[i];
    if (!label) continue;
    const role = roleByLabel.get(label);
    if (!role) continue;
    byRole[role]?.add(tileKey(i % layout.cols, Math.floor(i / layout.cols)));
  }
  const { meadow, center, lectern } = byRole;
  if (meadow.size === 0 && center.size === 0 && lectern.size === 0) return null;
  return { meadow, center, lectern };
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
