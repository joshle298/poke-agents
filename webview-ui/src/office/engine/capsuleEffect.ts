/**
 * The capsule spawn/despawn effect (drawing only; matrixEffectState.ts owns
 * the timer). It rides the same `matrixEffect` field as the matrix rain. The
 * capsule is our own design (sprites/capsule.json): a teal-and-cream pill
 * that opens by pulling its two halves apart.
 *
 * Spawn: the capsule is thrown from `effectOrigin` (the Lead) on an arc, or
 * drops from above; it pops open in a ring of white pixels; the body grows
 * out of it as a white silhouette and fades to its colours.
 * Despawn (recall): a teal beam from the open capsule over the head shrinks
 * the body to a teal point, then the closed capsule flies up and away.
 *
 * Works on any frame: a Pokémon sheet frame, or Promptling (the greeter).
 *
 * Waiting: while a Pokémon's sheets are still loading (or failed) its capsule
 * rests closed on its ground point with a gentle bob (renderRestingCapsule),
 * and flies off closed if the session leaves before it ever opened.
 */

import {
  CAPSULE_BOB_PERIOD_SEC,
  CAPSULE_BOB_PX,
  CAPSULE_BOB_STAGGER_SEC,
  CAPSULE_BURST_POINTS,
  CAPSULE_BURST_RADIUS_PX,
  CAPSULE_DROP_HEIGHT_PX,
  CAPSULE_FLASH_COLOR,
  CAPSULE_GROW_SHARE,
  CAPSULE_MATERIALIZE_MIN_SCALE,
  CAPSULE_OPEN_END,
  CAPSULE_RECALL_BEAM_COLOR,
  CAPSULE_RECALL_BEAM_END,
  CAPSULE_RECALL_EXIT_PX,
  CAPSULE_RECALL_HOVER_PX,
  CAPSULE_THROW_ARC_PX,
  CAPSULE_THROW_END,
  POKEMON_RECALL_COLOR,
  POKEMON_SILHOUETTE_COLOR,
} from '../../constants.js';
import { CAPSULE_CLOSED_SPRITE, CAPSULE_OPEN_SPRITE } from '../sprites/pokemonUiSprites.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import type { Character, SpriteData } from '../types.js';
import type { FrameRef } from './frameCanvas.js';
import { drawFrameScaled } from './frameCanvas.js';
import { matrixEffectDurationSec } from './matrixEffectState.js';
import { forEachLinePixel } from './pixelLine.js';

interface Point {
  x: number;
  y: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Draw a small sprite centred on a world point, snapped to whole device px. */
export function drawCenteredSprite(
  ctx: CanvasRenderingContext2D,
  sprite: SpriteData,
  at: Point,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const cached = getCachedSprite(sprite, zoom);
  ctx.drawImage(
    cached,
    Math.round(offsetX + at.x * zoom - cached.width / 2),
    Math.round(offsetY + at.y * zoom - cached.height / 2),
  );
}

function fillWorldPixel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  ctx.fillRect(Math.round(offsetX + x * zoom), Math.round(offsetY + y * zoom), zoom, zoom);
}

/**
 * @param ground   World point the frame's anchor sits on.
 * @param headRise World px from that point to the top of the body.
 */
export function renderCapsuleEffect(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  frame: FrameRef,
  ground: Point,
  headRise: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
  alpha: number,
): void {
  const p = Math.min(1, Math.max(0, ch.matrixEffectTimer / matrixEffectDurationSec(ch)));
  const capsuleHalf = CAPSULE_CLOSED_SPRITE.length / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (ch.matrixEffect === 'despawn') {
    const capsule = {
      x: ground.x,
      y: ground.y - headRise - CAPSULE_RECALL_HOVER_PX - capsuleHalf,
    };
    if (p < CAPSULE_RECALL_BEAM_END) {
      const q = p / CAPSULE_RECALL_BEAM_END;
      // The body, a teal silhouette shrinking to a point at its feet.
      drawFrameScaled(
        ctx,
        frame,
        ground,
        1 - q,
        offsetX,
        offsetY,
        zoom,
        alpha,
        1,
        POKEMON_RECALL_COLOR,
      );
      // The beam from the capsule's open seam down to the middle of the body.
      ctx.fillStyle = CAPSULE_RECALL_BEAM_COLOR;
      const chestY = ground.y - Math.round((headRise * (1 - q)) / 2);
      forEachLinePixel(capsule.x, capsule.y + capsuleHalf, ground.x, chestY, (x, y) =>
        fillWorldPixel(ctx, x, y, offsetX, offsetY, zoom),
      );
      drawCenteredSprite(ctx, CAPSULE_OPEN_SPRITE, capsule, offsetX, offsetY, zoom);
    } else {
      const q = (p - CAPSULE_RECALL_BEAM_END) / (1 - CAPSULE_RECALL_BEAM_END);
      ctx.globalAlpha = alpha * (1 - q);
      const at = { x: capsule.x, y: capsule.y - CAPSULE_RECALL_EXIT_PX * q * q };
      drawCenteredSprite(ctx, CAPSULE_CLOSED_SPRITE, at, offsetX, offsetY, zoom);
    }
    ctx.restore();
    return;
  }

  const rest = { x: ground.x, y: ground.y - capsuleHalf };
  if (p < CAPSULE_THROW_END) {
    const q = p / CAPSULE_THROW_END;
    const origin = ch.effectOrigin;
    const at = origin
      ? {
          x: lerp(origin.x, rest.x, q),
          y: lerp(origin.y, rest.y, q) - CAPSULE_THROW_ARC_PX * 4 * q * (1 - q),
        }
      : { x: rest.x, y: rest.y - CAPSULE_DROP_HEIGHT_PX * (1 - q * q) };
    drawCenteredSprite(ctx, CAPSULE_CLOSED_SPRITE, at, offsetX, offsetY, zoom);
  } else if (p < CAPSULE_OPEN_END) {
    const q = (p - CAPSULE_THROW_END) / (CAPSULE_OPEN_END - CAPSULE_THROW_END);
    drawCenteredSprite(ctx, CAPSULE_OPEN_SPRITE, rest, offsetX, offsetY, zoom);
    const radius = Math.max(1, Math.round(q * CAPSULE_BURST_RADIUS_PX));
    ctx.globalAlpha = alpha * (1 - q);
    ctx.fillStyle = CAPSULE_FLASH_COLOR;
    for (let k = 0; k < CAPSULE_BURST_POINTS; k++) {
      const angle = (k * 2 * Math.PI) / CAPSULE_BURST_POINTS;
      fillWorldPixel(
        ctx,
        Math.round(rest.x + Math.cos(angle) * radius),
        Math.round(rest.y + Math.sin(angle) * radius),
        offsetX,
        offsetY,
        zoom,
      );
    }
  } else {
    const q = (p - CAPSULE_OPEN_END) / (1 - CAPSULE_OPEN_END);
    const grow = Math.min(1, q / CAPSULE_GROW_SHARE);
    const scale = CAPSULE_MATERIALIZE_MIN_SCALE + (1 - CAPSULE_MATERIALIZE_MIN_SCALE) * grow;
    const white =
      q < CAPSULE_GROW_SHARE
        ? 1
        : Math.max(0, 1 - (q - CAPSULE_GROW_SHARE) / (1 - CAPSULE_GROW_SHARE));
    drawFrameScaled(
      ctx,
      frame,
      ground,
      scale,
      offsetX,
      offsetY,
      zoom,
      alpha,
      white,
      POKEMON_SILHOUETTE_COLOR,
    );
  }
  ctx.restore();
}

/** World px the waiting capsule is lifted `t` seconds into its bob (0 or up to
 *  CAPSULE_BOB_PX, a smooth rise and fall each CAPSULE_BOB_PERIOD_SEC). */
export function capsuleBobPx(t: number): number {
  const phase = (1 - Math.cos((2 * Math.PI * t) / CAPSULE_BOB_PERIOD_SEC)) / 2;
  return Math.round(phase * CAPSULE_BOB_PX);
}

/** Centre of the waiting capsule resting on `ground`, lifted by its bob
 *  (neighbouring capsules bob out of step). */
export function restingCapsuleCenter(ch: Character, ground: Point): Point {
  const t =
    (ch.spawnHoldSec ?? 0) + (ch.capsuleWaitSec ?? 0) + Math.abs(ch.id) * CAPSULE_BOB_STAGGER_SEC;
  return { x: ground.x, y: ground.y - CAPSULE_CLOSED_SPRITE.length / 2 - capsuleBobPx(t) };
}

/**
 * The closed capsule standing in for a Pokémon whose sprites aren't ready:
 * resting on `ground` with a gentle bob, or (despawn) flying up and away,
 * closed, the way a recall ends.
 */
export function renderRestingCapsule(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  ground: Point,
  offsetX: number,
  offsetY: number,
  zoom: number,
  alpha: number,
): void {
  const capsuleHalf = CAPSULE_CLOSED_SPRITE.length / 2;
  const rest = { x: ground.x, y: ground.y - capsuleHalf };
  ctx.save();
  ctx.globalAlpha = alpha;
  if (ch.matrixEffect === 'despawn') {
    const q = Math.min(1, Math.max(0, ch.matrixEffectTimer / matrixEffectDurationSec(ch)));
    ctx.globalAlpha = alpha * (1 - q);
    const at = { x: rest.x, y: rest.y - CAPSULE_RECALL_EXIT_PX * q * q };
    drawCenteredSprite(ctx, CAPSULE_CLOSED_SPRITE, at, offsetX, offsetY, zoom);
  } else {
    drawCenteredSprite(
      ctx,
      CAPSULE_CLOSED_SPRITE,
      restingCapsuleCenter(ch, ground),
      offsetX,
      offsetY,
      zoom,
    );
  }
  ctx.restore();
}
