/**
 * Links and message projectiles between agents (drawing only; OfficeState
 * owns the data).
 *
 * Links lie on the floor under everyone: pixel-art dashes between two
 * characters (where each stands, or the middle of a body drawn off its tile:
 * a Pokémon seated at a desk, anyone lying in a bed), marching from sender
 * to receiver — spawned as dashes, messaged as dots, watched faint — each
 * lit pixel over a dark casing pixel.
 * Projectiles fly above everyone on an arc from chest to chest: an orb, its
 * C spinning round it until it lands, while themed; an envelope otherwise.
 */

import {
  LINK_CASING_COLOR,
  LINK_COLORS,
  LINK_DIM_ALPHA,
  LINK_MARCH_PX_PER_SEC,
  LINK_PATTERNS,
  PROJECTILE_ARC_LIFT_PX,
} from '../../constants.js';
import { ENVELOPE_SPRITE } from '../sprites/pokemonUiSprites.js';
import type { Character, LinkSegment, Projectile } from '../types.js';
import { drawCenteredSprite, orbSpinSprite } from './orbEffect.js';
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
  /** Fly orbs (themed) or envelopes. */
  themed: boolean;
}

/** Device-px corners of the current link's lit pixels (reused every frame). */
const litX: number[] = [];
const litY: number[] = [];

export function renderLinks(
  ctx: CanvasRenderingContext2D,
  links: LinkSegment[],
  time: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const march = time * LINK_MARCH_PX_PER_SEC;
  // Pixels off the canvas are skipped: in a town larger than the window a
  // Lead's links can run far out of view.
  const viewW = ctx.canvas?.width ?? Infinity;
  const viewH = ctx.canvas?.height ?? Infinity;
  ctx.save();
  for (const link of links) {
    const { kind, dim } = link;
    const from = linkEnd(link.from);
    const to = linkEnd(link.to);
    const { period, on } = LINK_PATTERNS[kind];
    litX.length = 0;
    litY.length = 0;
    forEachLinePixel(from.x, from.y, to.x, to.y, (x, y, step) => {
      if (!isDashLit(step, march, period, on)) return;
      const px = Math.round(offsetX + x * zoom);
      const py = Math.round(offsetY + y * zoom);
      if (px >= viewW || py >= viewH || px + zoom <= 0 || py + 2 * zoom <= 0) return;
      litX.push(px);
      litY.push(py);
    });
    if (litX.length === 0) continue;
    ctx.globalAlpha = dim ? LINK_DIM_ALPHA : 1;
    // A dark casing one pixel under every lit pixel first, so the line reads
    // on light ground (sand, the Lab's floor) as well as on dark.
    // One path per colour: hundreds of pixel squares in one fill call.
    ctx.fillStyle = LINK_CASING_COLOR;
    ctx.beginPath();
    for (let i = 0; i < litX.length; i++) ctx.rect(litX[i], litY[i] + zoom, zoom, zoom);
    ctx.fill();
    ctx.fillStyle = LINK_COLORS[kind];
    ctx.beginPath();
    for (let i = 0; i < litX.length; i++) ctx.rect(litX[i], litY[i], zoom, zoom);
    ctx.fill();
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
    const sprite = state.themed ? orbSpinSprite(p.dur - p.t) : ENVELOPE_SPRITE;
    drawCenteredSprite(ctx, sprite, at, offsetX, offsetY, zoom);
  }
}
