/**
 * Area roles: which tiles of a layout belong to its Meadow and its Pokémon
 * Center. Pure and DOM-free (Node-tested). A role lives on the Area definition
 * (`AreaDefinition.role`), so the existing Areas tool paints and erases role
 * tiles, and rename, recolor, export and import carry the role along.
 */

import type { AreaRole, OfficeLayout } from '../types.js';

/** Tile keys (`"col,row"`) per role. An empty set means the layout has no such area. */
export interface AreaRoleTiles {
  meadow: ReadonlySet<string>;
  center: ReadonlySet<string>;
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

  const meadow = new Set<string>();
  const center = new Set<string>();
  for (let i = 0; i < tiles.length; i++) {
    const label = tiles[i];
    if (!label) continue;
    const role = roleByLabel.get(label);
    if (!role) continue;
    const key = tileKey(i % layout.cols, Math.floor(i / layout.cols));
    if (role === 'meadow') meadow.add(key);
    else if (role === 'center') center.add(key);
  }
  if (meadow.size === 0 && center.size === 0) return null;
  return { meadow, center };
}
