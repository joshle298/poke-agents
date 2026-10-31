/**
 * The town's static layer: placed items nothing can ever be drawn behind
 * (most of the forest that frames the map), drawn once into a cached canvas
 * under everyone instead of being z-sorted with the characters every frame.
 * Pure and DOM-free (Node-tested); OfficeState decides, the renderer draws.
 *
 * An item may join the layer when drawing it first changes nothing:
 *   - no character, at any spot it can reach (standing on a tile or halfway
 *     between two), sorts before it while its sprite overlaps the item's;
 *   - nothing left in the z-sorted pass (an item, a wall, tall grass) sorts
 *     before it while overlapping it — that would now be drawn over it.
 * The layer keeps its items in their usual draw order.
 */

import { CHARACTER_Z_SORT_OFFSET } from '../../constants.js';
import { TILE_SIZE } from '../types.js';

/** A drawn rectangle (world px) and the key it sorts by. */
export interface LayerRect {
  x: number;
  y: number;
  w: number;
  h: number;
  zY: number;
}

/** How far a character's sprite may reach from its ground point (world px). */
export interface CharacterReach {
  halfW: number;
  rise: number;
  below: number;
}

export interface StaticLayerInput {
  /** The placed items in draw order; `candidate` when their sprite never
   *  changes at run time (no on/off state, no animation). */
  items: ReadonlyArray<LayerRect & { candidate: boolean }>;
  /** Drawn in the z-sorted pass before the items with the same key (walls,
   *  tall grass): never in the layer. */
  others: readonly LayerRect[];
  /** Tiles a character can stand on. */
  standable: ReadonlyArray<{ col: number; row: number }>;
  reach: CharacterReach;
}

function overlaps(a: LayerRect, b: LayerRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Where a character's sprite may be drawn when it stands at world (x, y). */
function characterRect(x: number, y: number, reach: CharacterReach): LayerRect {
  return {
    x: x - reach.halfW,
    y: y - reach.rise,
    w: reach.halfW * 2,
    h: reach.rise + reach.below,
    zY: y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET,
  };
}

/** Indices of the items that can be drawn in the static layer. */
export function staticLayerItems(input: StaticLayerInput): Set<number> {
  const { items, others, standable, reach } = input;
  const keys = new Set(standable.map((t) => `${t.col},${t.row}`));
  const spots: LayerRect[] = [];
  const half = TILE_SIZE / 2;
  for (const t of standable) {
    const x = t.col * TILE_SIZE + half;
    const y = t.row * TILE_SIZE + half;
    spots.push(characterRect(x, y, reach));
    // halfway to the tiles to the right and below (walking between them)
    if (keys.has(`${t.col + 1},${t.row}`)) spots.push(characterRect(x + half, y, reach));
    if (keys.has(`${t.col},${t.row + 1}`)) spots.push(characterRect(x, y + half, reach));
  }
  const inLayer = new Set<number>();
  items.forEach((item, i) => {
    if (!item.candidate) return;
    if (spots.some((s) => s.zY < item.zY && overlaps(s, item))) return;
    inLayer.add(i);
  });
  // Anything still z-sorted that is drawn before an item and overlaps it
  // keeps that item out of the layer; repeat until nothing changes.
  const drawnBefore = (j: LayerRect, jIndex: number, i: LayerRect, iIndex: number) =>
    j.zY < i.zY || (j.zY === i.zY && jIndex < iIndex);
  for (let changed = true; changed;) {
    changed = false;
    for (const i of [...inLayer]) {
      const item = items[i];
      const blocked =
        others.some((o) => o.zY <= item.zY && overlaps(o, item)) ||
        items.some(
          (j, jIndex) =>
            !inLayer.has(jIndex) && drawnBefore(j, jIndex, item, i) && overlaps(j, item),
        );
      if (blocked) {
        inLayer.delete(i);
        changed = true;
      }
    }
  }
  return inLayer;
}
