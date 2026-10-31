/**
 * Floor foreground: the tall-grass effect. A floor pattern may mark pixels as
 * foreground by storing them at alpha FLOOR_FOREGROUND_ALPHA (254, visually
 * opaque). The renderer draws those pixels a second time, z-sorted just in
 * front of whoever stands there, so the lower body of a character in tall
 * grass disappears behind the blades:
 *
 *   - foreground pixels in rows above FLOOR_FOREGROUND_BELOW_ROW cover a
 *     character standing on that tile;
 *   - foreground pixels from that row down (blade tips) cover a character
 *     standing on the tile below, whose feet sit near the top of its own tile.
 *
 * Pure and DOM-free (Node-tested); the renderer turns pieces into drawables.
 */

import { FLOOR_FOREGROUND_ALPHA, FLOOR_FOREGROUND_BELOW_ROW } from '../constants.js';
import type { SpriteData } from './types.js';

const FOREGROUND_ALPHA_HEX = FLOOR_FOREGROUND_ALPHA.toString(16).toUpperCase().padStart(2, '0');

/** Whether a sprite pixel is marked as floor foreground. */
export function isForegroundPixel(pixel: string): boolean {
  return pixel.length === 9 && pixel.slice(7).toUpperCase() === FOREGROUND_ALPHA_HEX;
}

/** Whether any pixel of a floor sprite is marked as foreground. */
export function hasForegroundPixels(sprite: SpriteData): boolean {
  return sprite.some((row) => row.some(isForegroundPixel));
}

/** A sprite's foreground pixels alone, opaque (the rest transparent), or null
 *  when it has none: a bed's blanket, drawn again over its sleeper. */
export function foregroundSprite(sprite: SpriteData): SpriteData | null {
  let any = false;
  const out = sprite.map((row) =>
    row.map((pixel) => {
      if (!isForegroundPixel(pixel)) return '';
      any = true;
      return pixel.slice(0, 7);
    }),
  );
  return any ? out : null;
}

/** The two halves of a tile's foreground, opaque, or null when a half is empty. */
export interface FloorForegroundSprites {
  /** Rows above FLOOR_FOREGROUND_BELOW_ROW: in front of the tile's own occupant. */
  own: SpriteData | null;
  /** Rows from FLOOR_FOREGROUND_BELOW_ROW down: in front of the occupant of the tile below. */
  below: SpriteData | null;
}

/** Split a (colorized) floor sprite's foreground pixels into its two halves. */
export function splitFloorForeground(sprite: SpriteData): FloorForegroundSprites {
  const own: SpriteData = [];
  const below: SpriteData = [];
  let ownAny = false;
  let belowAny = false;
  for (let r = 0; r < sprite.length; r++) {
    const isBelow = r >= FLOOR_FOREGROUND_BELOW_ROW;
    const ownRow: string[] = [];
    const belowRow: string[] = [];
    for (const pixel of sprite[r]) {
      const fg = isForegroundPixel(pixel) ? pixel.slice(0, 7) : '';
      ownRow.push(isBelow ? '' : fg);
      belowRow.push(isBelow ? fg : '');
      if (fg && isBelow) belowAny = true;
      else if (fg) ownAny = true;
    }
    own.push(ownRow);
    below.push(belowRow);
  }
  return { own: ownAny ? own : null, below: belowAny ? below : null };
}

/** Something that stands on tiles and walks between them: a character or a pet. */
export interface ForegroundEntity {
  tileCol: number;
  tileRow: number;
  path: ReadonlyArray<{ col: number; row: number }>;
  /** Highest world y the grass may cover on this entity (a small sprite keeps
   *  its top visible); undefined = no limit. */
  coverTopY?: number;
}

/** One foreground half to draw at a tile, sorted with the entities of `zRow`. */
export interface ForegroundPiece {
  col: number;
  row: number;
  part: 'own' | 'below';
  /** The row whose occupants it covers: draw just after them. */
  zRow: number;
  /** Draw only from this world y down (the lowest limit among the entities
   *  it covers); undefined = the whole half. */
  clipTopY?: number;
}

/**
 * The foreground pieces to draw this frame: for every entity standing on (or
 * stepping into) a foreground tile, that tile's and its side neighbors' own
 * halves, plus the blade tips of the tiles above them. Only tiles that
 * `hasForeground` say carry foreground pixels are returned; each piece once.
 */
export function foregroundPieces(
  entities: Iterable<ForegroundEntity>,
  hasForeground: (col: number, row: number) => boolean,
): ForegroundPiece[] {
  const out: ForegroundPiece[] = [];
  const seen = new Map<string, ForegroundPiece>();
  const add = (
    col: number,
    row: number,
    part: ForegroundPiece['part'],
    zRow: number,
    clipTopY: number | undefined,
  ) => {
    if (!hasForeground(col, row)) return;
    const key = `${part}:${col},${row}`;
    const held = seen.get(key);
    if (held) {
      if (clipTopY !== undefined) held.clipTopY = Math.max(held.clipTopY ?? clipTopY, clipTopY);
      return;
    }
    const piece: ForegroundPiece = { col, row, part, zRow };
    if (clipTopY !== undefined) piece.clipTopY = clipTopY;
    seen.set(key, piece);
    out.push(piece);
  };
  for (const e of entities) {
    const stands = [{ col: e.tileCol, row: e.tileRow }];
    const next = e.path[0];
    if (next) stands.push(next);
    for (const t of stands) {
      if (!hasForeground(t.col, t.row)) continue;
      for (let dc = -1; dc <= 1; dc++) {
        add(t.col + dc, t.row, 'own', t.row, e.coverTopY);
        add(t.col + dc, t.row - 1, 'below', t.row, e.coverTopY);
      }
    }
  }
  return out;
}
