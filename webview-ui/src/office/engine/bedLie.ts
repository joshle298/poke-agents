/**
 * How a sleeper lies in a Pokémon Center bed: where its frame is drawn and
 * whether it is turned on its side. Pure and DOM-free (Node-tested).
 *
 * A pose wider than it is tall (a Pokémon's held Faint, a curled Sleep) lies
 * as drawn; a taller one (an upright Sleep frame, a standing human) is turned
 * a quarter so its top points at the pillow. Either way the body lies on the
 * mattress between the boards with its head end on the pillow and its lowest
 * pixel on the mattress's near edge, where the tucked blanket covers it.
 */

import {
  BED_BOARD_PX,
  BED_PILLOW_INSET_PX,
  BED_SLEEPER_BASE_PX,
  BED_SLEEPER_SINK_LIMIT_PX,
} from '../../constants.js';
import type { BedRest, SpriteData } from '../types.js';

/** A body's reach from its ground point (px): left, right, up and down. */
export interface PoseBox {
  left: number;
  right: number;
  rise: number;
  drop: number;
}

/** Quarter turns a frame is drawn with: -1 top to the left, 1 top to the right. */
export type QuarterTurn = -1 | 0 | 1;

/** Where a sleeper's frame is drawn in its bed. */
export interface BedLie {
  /** World point the frame's ground point is drawn at (whole px). */
  x: number;
  y: number;
  turn: QuarterTurn;
  /** The body's reach from (x, y) as drawn, after the turn. */
  box: PoseBox;
}

/**
 * A box turned about its ground point: a quarter turn counterclockwise (-1)
 * takes the top to the left and the right side up; clockwise (1) the top to
 * the right and the left side up.
 */
export function turnBox(box: PoseBox, turn: QuarterTurn): PoseBox {
  if (turn === -1) return { left: box.rise, right: box.drop, rise: box.right, drop: box.left };
  if (turn === 1) return { left: box.drop, right: box.rise, rise: box.left, drop: box.right };
  return box;
}

/** How a body with reach `pose` lies in `bed`. */
export function lieInBed(
  pose: PoseBox,
  bed: Pick<BedRest, 'pillow' | 'x' | 'y' | 'w' | 'h'>,
): BedLie {
  const tall = pose.rise + pose.drop > pose.left + pose.right;
  const turn: QuarterTurn = tall ? (bed.pillow === 'left' ? -1 : 1) : 0;
  const box = turnBox(pose, turn);
  const width = box.left + box.right;
  const height = box.rise + box.drop;
  const mattressLeft = bed.x + BED_BOARD_PX;
  const mattressRight = bed.x + bed.w - BED_BOARD_PX;
  let left: number;
  if (width > mattressRight - mattressLeft) {
    // Longer than the mattress: centred, over both boards alike.
    left = bed.x + Math.floor((bed.w - width) / 2);
  } else if (bed.pillow === 'left') {
    left = Math.min(bed.x + BED_PILLOW_INSET_PX, mattressRight - width);
  } else {
    left = Math.max(bed.x + bed.w - BED_PILLOW_INSET_PX - width, mattressLeft);
  }
  let bottom = bed.y + bed.h - BED_SLEEPER_BASE_PX;
  if (bottom - height < bed.y) {
    bottom = Math.min(bed.y + bed.h - BED_SLEEPER_SINK_LIMIT_PX, bed.y + height);
  }
  return { x: left + box.left, y: bottom - box.drop, turn, box };
}

const spriteBoxes = new WeakMap<SpriteData, PoseBox>();

/** The opaque box of an upstream character sprite from its bottom-centre
 *  anchor (where it stands), measured once per sprite. */
export function spritePoseBox(sprite: SpriteData): PoseBox {
  const held = spriteBoxes.get(sprite);
  if (held) return held;
  const h = sprite.length;
  const w = sprite[0]?.length ?? 0;
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!sprite[y][x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const cx = Math.floor(w / 2);
  const box =
    maxX < 0
      ? { left: cx, right: w - cx, rise: h, drop: 0 }
      : { left: cx - minX, right: maxX + 1 - cx, rise: h - minY, drop: maxY + 1 - h };
  spriteBoxes.set(sprite, box);
  return box;
}
