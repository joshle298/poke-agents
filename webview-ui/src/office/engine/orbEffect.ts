/**
 * The orb's spawn/despawn effect (drawing only; matrixEffectState.ts owns
 * the timer). It rides the same `matrixEffect` field as the matrix rain. The
 * orb is our own design (sprites/orb.json): a glossy sphere inside a free
 * gold C.
 *
 * Spawn: the orb is thrown from `effectOrigin` (the Lead) on an arc, or
 * drops from above, its C spinning round it and coming to rest, open on the
 * right, as it lands. Then it cracks open: a slit of light runs through it
 * to the latch while a ring of white pixels flashes out, and the body grows
 * out of it as a white silhouette and fades to its colours.
 * Despawn (recall): a teal beam from the open orb's slit over the head
 * shrinks the body to a teal point, then the orb, closed, flies up and away
 * spinning.
 *
 * Works on any frame: a Pokémon sheet frame, or Promptling (the greeter).
 *
 * Waiting: while a Pokémon's sheets are still loading (or failed) its orb
 * rests closed on its ground point with a gentle bob (renderRestingOrb),
 * and flies off closed if the session leaves before it ever opened.
 *
 * Every orb frame is the same size and stands on the ground by its bottom
 * row (groundedCenter), so the orb cracks open where it landed.
 */

import {
  ORB_BOB_PERIOD_SEC,
  ORB_BOB_PX,
  ORB_BOB_STAGGER_SEC,
  ORB_BURST_POINTS,
  ORB_BURST_RADIUS_PX,
  ORB_DROP_HEIGHT_PX,
  ORB_FLASH_COLOR,
  ORB_GROW_SHARE,
  ORB_MATERIALIZE_MIN_SCALE,
  ORB_OPEN_END,
  ORB_RECALL_BEAM_COLOR,
  ORB_RECALL_BEAM_END,
  ORB_RECALL_EXIT_PX,
  ORB_RECALL_HOVER_PX,
  ORB_SPIN_FRAME_SEC,
  ORB_THROW_ARC_PX,
  ORB_THROW_END,
  POKEMON_RECALL_COLOR,
  POKEMON_SILHOUETTE_COLOR,
} from '../../constants.js';
import {
  ORB_CLOSED_SPRITE,
  ORB_OPEN_SPRITE,
  ORB_SPIN_SPRITES,
} from '../sprites/pokemonUiSprites.js';
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

/** Centre of an orb frame standing on `ground` by its bottom row. */
export function groundedCenter(sprite: SpriteData, ground: Point): Point {
  return { x: ground.x, y: ground.y - sprite.length / 2 };
}

/**
 * The orb `secondsToRest` before its C stops spinning. In forward time the
 * C's opening turns clockwise from the right to below, the left, above and
 * back (ORB_SPIN_SPRITES in order), one frame every ORB_SPIN_FRAME_SEC, and
 * it comes to rest on the right, closed, at 0.
 */
export function orbSpinSprite(secondsToRest: number): SpriteData {
  const n = ORB_SPIN_SPRITES.length;
  const k = Math.floor(Math.max(0, secondsToRest) / ORB_SPIN_FRAME_SEC);
  return ORB_SPIN_SPRITES[(n - (k % n)) % n];
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
export function renderOrbEffect(
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
  const duration = matrixEffectDurationSec(ch);
  const p = Math.min(1, Math.max(0, ch.matrixEffectTimer / duration));
  ctx.save();
  ctx.globalAlpha = alpha;
  if (ch.matrixEffect === 'despawn') {
    // The open orb hovers over the head, its slit of light at its centre.
    const open = {
      x: ground.x,
      y: ground.y - headRise - ORB_RECALL_HOVER_PX - ORB_OPEN_SPRITE.length / 2,
    };
    if (p < ORB_RECALL_BEAM_END) {
      const q = p / ORB_RECALL_BEAM_END;
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
      // The beam from the orb's slit down to the middle of the body.
      ctx.fillStyle = ORB_RECALL_BEAM_COLOR;
      const chestY = ground.y - Math.round((headRise * (1 - q)) / 2);
      forEachLinePixel(open.x, open.y, ground.x, chestY, (x, y) =>
        fillWorldPixel(ctx, x, y, offsetX, offsetY, zoom),
      );
      drawCenteredSprite(ctx, ORB_OPEN_SPRITE, open, offsetX, offsetY, zoom);
    } else {
      // Closed where the open orb stood, then up and away, spinning.
      const q = (p - ORB_RECALL_BEAM_END) / (1 - ORB_RECALL_BEAM_END);
      ctx.globalAlpha = alpha * (1 - q);
      const bottom = open.y + ORB_OPEN_SPRITE.length / 2;
      const at = {
        x: open.x,
        y: bottom - ORB_CLOSED_SPRITE.length / 2 - ORB_RECALL_EXIT_PX * q * q,
      };
      const sprite = orbSpinSprite((1 - p) * duration);
      drawCenteredSprite(ctx, sprite, at, offsetX, offsetY, zoom);
    }
    ctx.restore();
    return;
  }

  const throwSec = ORB_THROW_END * duration;
  if (p < ORB_THROW_END) {
    // In the air, the C spinning until it lands.
    const q = p / ORB_THROW_END;
    const rest = groundedCenter(ORB_CLOSED_SPRITE, ground);
    const origin = ch.effectOrigin;
    const at = origin
      ? {
          x: lerp(origin.x, rest.x, q),
          y: lerp(origin.y, rest.y, q) - ORB_THROW_ARC_PX * 4 * q * (1 - q),
        }
      : { x: rest.x, y: rest.y - ORB_DROP_HEIGHT_PX * (1 - q * q) };
    const sprite = orbSpinSprite(throwSec - ch.matrixEffectTimer);
    drawCenteredSprite(ctx, sprite, at, offsetX, offsetY, zoom);
  } else if (p < ORB_OPEN_END) {
    // The orb cracks open; a ring of white pixels flashes out of its light,
    // from the open orb's edge outward, fading as it goes.
    const q = (p - ORB_THROW_END) / (ORB_OPEN_END - ORB_THROW_END);
    const light = groundedCenter(ORB_OPEN_SPRITE, ground);
    drawCenteredSprite(ctx, ORB_OPEN_SPRITE, light, offsetX, offsetY, zoom);
    const from = ORB_OPEN_SPRITE.length / 2;
    const radius = Math.round(from + q * (ORB_BURST_RADIUS_PX - from));
    ctx.globalAlpha = alpha * (1 - q * q);
    ctx.fillStyle = ORB_FLASH_COLOR;
    for (let k = 0; k < ORB_BURST_POINTS; k++) {
      const angle = (k * 2 * Math.PI) / ORB_BURST_POINTS;
      fillWorldPixel(
        ctx,
        Math.round(light.x + Math.cos(angle) * radius),
        Math.round(light.y + Math.sin(angle) * radius),
        offsetX,
        offsetY,
        zoom,
      );
    }
  } else {
    const q = (p - ORB_OPEN_END) / (1 - ORB_OPEN_END);
    const grow = Math.min(1, q / ORB_GROW_SHARE);
    const scale = ORB_MATERIALIZE_MIN_SCALE + (1 - ORB_MATERIALIZE_MIN_SCALE) * grow;
    const white =
      q < ORB_GROW_SHARE ? 1 : Math.max(0, 1 - (q - ORB_GROW_SHARE) / (1 - ORB_GROW_SHARE));
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

/** World px the waiting orb is lifted `t` seconds into its bob (0 or up to
 *  ORB_BOB_PX, a smooth rise and fall each ORB_BOB_PERIOD_SEC). */
export function orbBobPx(t: number): number {
  const phase = (1 - Math.cos((2 * Math.PI * t) / ORB_BOB_PERIOD_SEC)) / 2;
  return Math.round(phase * ORB_BOB_PX);
}

/** Centre of the waiting orb resting on `ground`, lifted by its bob
 *  (neighbouring orbs bob out of step). */
export function restingOrbCenter(ch: Character, ground: Point): Point {
  const t = (ch.spawnHoldSec ?? 0) + (ch.orbWaitSec ?? 0) + Math.abs(ch.id) * ORB_BOB_STAGGER_SEC;
  const rest = groundedCenter(ORB_CLOSED_SPRITE, ground);
  return { x: rest.x, y: rest.y - orbBobPx(t) };
}

/**
 * The closed orb standing in for a Pokémon whose sprites aren't ready:
 * resting on `ground` with a gentle bob, or (despawn) flying up and away,
 * spinning, the way a recall ends.
 */
export function renderRestingOrb(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  ground: Point,
  offsetX: number,
  offsetY: number,
  zoom: number,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  if (ch.matrixEffect === 'despawn') {
    const duration = matrixEffectDurationSec(ch);
    const q = Math.min(1, Math.max(0, ch.matrixEffectTimer / duration));
    ctx.globalAlpha = alpha * (1 - q);
    const rest = groundedCenter(ORB_CLOSED_SPRITE, ground);
    const at = { x: rest.x, y: rest.y - ORB_RECALL_EXIT_PX * q * q };
    drawCenteredSprite(ctx, orbSpinSprite((1 - q) * duration), at, offsetX, offsetY, zoom);
  } else {
    drawCenteredSprite(
      ctx,
      ORB_CLOSED_SPRITE,
      restingOrbCenter(ch, ground),
      offsetX,
      offsetY,
      zoom,
    );
  }
  ctx.restore();
}
