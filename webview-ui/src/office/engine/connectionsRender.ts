/**
 * Links and message projectiles between agents (drawing only; OfficeState
 * owns the data).
 *
 * Links lie on the floor under everyone: pixel-art dashes between two
 * characters (where each stands, or the middle of a body drawn off its tile:
 * a Pokémon seated at a desk, anyone lying in a bed), marching from sender
 * to receiver — spawned as dashes, messaged as dots, watched faint — each
 * lit pixel over a dark casing pixel.
 * Projectiles fly above everyone on an arc from chest to chest: a capsule
 * while themed, an envelope otherwise.
 */

import {
  LINK_CASING_COLOR,
  LINK_COLORS,
  LINK_DIM_ALPHA,
  LINK_MARCH_PX_PER_SEC,
  LINK_PATTERNS,
  PROJECTILE_ARC_LIFT_PX,
} from '../../constants.js';
import { CAPSULE_CLOSED_SPRITE, ENVELOPE_SPRITE } from '../sprites/pokemonUiSprites.js';
import type { Character, LinkSegment, Projectile } from '../types.js';
import { drawCenteredSprite } from './capsuleEffect.js';
import { forEachLinePixel, isDashLit } from './pixelLine.js';
import { characterChest, linkEnd } from './pokemonCharacter.js';

/** What renderFrame needs to draw connections this frame. */
export interface ConnectionsRenderState {
  /** Empty when the "Show connections" setting is off. */
  links: LinkSegment[];
  projectiles: Projectile[];
  characters: Map<number, Character>;
  /** Seconds of simulated time (OfficeState.clock). */
  time: number;
  /** Fly capsules (themed) or envelopes. */
  themed: boolean;
}

export function renderLinks(
  ctx: CanvasRenderingContext2D,
  links: LinkSegment[],
  time: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const march = time * LINK_MARCH_PX_PER_SEC;
  ctx.save();
  for (const link of links) {
    const { kind, dim } = link;
    const from = linkEnd(link.from);
    const to = linkEnd(link.to);
    const { period, on } = LINK_PATTERNS[kind];
    ctx.globalAlpha = dim ? LINK_DIM_ALPHA : 1;
    // A dark casing one pixel under every lit pixel first, so the line reads
    // on light ground (sand, the Lab's floor) as well as on dark.
    for (const [color, dy] of [
      [LINK_CASING_COLOR, 1],
      [LINK_COLORS[kind], 0],
    ] as const) {
      ctx.fillStyle = color;
      forEachLinePixel(from.x, from.y, to.x, to.y, (x, y, step) => {
        if (!isDashLit(step, march, period, on)) return;
        ctx.fillRect(
          Math.round(offsetX + x * zoom),
          Math.round(offsetY + (y + dy) * zoom),
          zoom,
          zoom,
        );
      });
    }
  }
  ctx.restore();
}

export function renderProjectiles(
  ctx: CanvasRenderingContext2D,
  state: ConnectionsRenderState,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const sprite = state.themed ? CAPSULE_CLOSED_SPRITE : ENVELOPE_SPRITE;
  for (const p of state.projectiles) {
    const from = state.characters.get(p.fromId);
    const to = state.characters.get(p.toId);
    if (!from || !to) continue;
    const q = p.dur > 0 ? Math.min(1, Math.max(0, p.t / p.dur)) : 1;
    const a = characterChest(from);
    const b = characterChest(to);
    const at = {
      x: Math.round(a.x + (b.x - a.x) * q),
      y: Math.round(a.y + (b.y - a.y) * q - PROJECTILE_ARC_LIFT_PX * 4 * q * (1 - q)),
    };
    drawCenteredSprite(ctx, sprite, at, offsetX, offsetY, zoom);
  }
}
