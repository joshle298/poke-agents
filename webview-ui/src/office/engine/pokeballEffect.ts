/**
 * The Poké Ball spawn/despawn effect (drawing only; matrixEffectState.ts
 * owns the timer). It rides the same `matrixEffect` field as the matrix rain.
 *
 * Spawn: the ball is thrown from `effectOrigin` (the Lead) on an arc, or
 * drops from above; it pops open in a ring of white pixels; the body grows
 * out of it as a white silhouette and fades to its colours.
 * Despawn (recall): a red beam from a ball over the head shrinks the body to
 * a red point, then the ball flies up and away.
 *
 * Works on any frame: a Pokémon sheet frame, or the upstream character while
 * its species' sheets are still decoding.
 */

import {
  POKEBALL_BURST_POINTS,
  POKEBALL_BURST_RADIUS_PX,
  POKEBALL_DROP_HEIGHT_PX,
  POKEBALL_FLASH_COLOR,
  POKEBALL_GROW_SHARE,
  POKEBALL_MATERIALIZE_MIN_SCALE,
  POKEBALL_OPEN_END,
  POKEBALL_RECALL_BEAM_COLOR,
  POKEBALL_RECALL_BEAM_END,
  POKEBALL_RECALL_EXIT_PX,
  POKEBALL_RECALL_HOVER_PX,
  POKEBALL_THROW_ARC_PX,
  POKEBALL_THROW_END,
  POKEMON_RECALL_COLOR,
  POKEMON_SILHOUETTE_COLOR,
} from '../../constants.js';
import { POKEBALL_CLOSED_SPRITE, POKEBALL_OPEN_SPRITE } from '../sprites/pokemonUiSprites.js';
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
export function renderPokeballEffect(
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
  const ballHalf = POKEBALL_CLOSED_SPRITE.length / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (ch.matrixEffect === 'despawn') {
    const ball = { x: ground.x, y: ground.y - headRise - POKEBALL_RECALL_HOVER_PX - ballHalf };
    if (p < POKEBALL_RECALL_BEAM_END) {
      const q = p / POKEBALL_RECALL_BEAM_END;
      // The body, a red silhouette shrinking to a point at its feet.
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
      // The beam from the ball down to the middle of the body.
      ctx.fillStyle = POKEBALL_RECALL_BEAM_COLOR;
      const chestY = ground.y - Math.round((headRise * (1 - q)) / 2);
      forEachLinePixel(ball.x, ball.y + ballHalf, ground.x, chestY, (x, y) =>
        fillWorldPixel(ctx, x, y, offsetX, offsetY, zoom),
      );
      drawCenteredSprite(ctx, POKEBALL_OPEN_SPRITE, ball, offsetX, offsetY, zoom);
    } else {
      const q = (p - POKEBALL_RECALL_BEAM_END) / (1 - POKEBALL_RECALL_BEAM_END);
      ctx.globalAlpha = alpha * (1 - q);
      const at = { x: ball.x, y: ball.y - POKEBALL_RECALL_EXIT_PX * q * q };
      drawCenteredSprite(ctx, POKEBALL_CLOSED_SPRITE, at, offsetX, offsetY, zoom);
    }
    ctx.restore();
    return;
  }

  const rest = { x: ground.x, y: ground.y - ballHalf };
  if (p < POKEBALL_THROW_END) {
    const q = p / POKEBALL_THROW_END;
    const origin = ch.effectOrigin;
    const at = origin
      ? {
          x: lerp(origin.x, rest.x, q),
          y: lerp(origin.y, rest.y, q) - POKEBALL_THROW_ARC_PX * 4 * q * (1 - q),
        }
      : { x: rest.x, y: rest.y - POKEBALL_DROP_HEIGHT_PX * (1 - q * q) };
    drawCenteredSprite(ctx, POKEBALL_CLOSED_SPRITE, at, offsetX, offsetY, zoom);
  } else if (p < POKEBALL_OPEN_END) {
    const q = (p - POKEBALL_THROW_END) / (POKEBALL_OPEN_END - POKEBALL_THROW_END);
    drawCenteredSprite(ctx, POKEBALL_OPEN_SPRITE, rest, offsetX, offsetY, zoom);
    const radius = Math.max(1, Math.round(q * POKEBALL_BURST_RADIUS_PX));
    ctx.globalAlpha = alpha * (1 - q);
    ctx.fillStyle = POKEBALL_FLASH_COLOR;
    for (let k = 0; k < POKEBALL_BURST_POINTS; k++) {
      const angle = (k * 2 * Math.PI) / POKEBALL_BURST_POINTS;
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
    const q = (p - POKEBALL_OPEN_END) / (1 - POKEBALL_OPEN_END);
    const grow = Math.min(1, q / POKEBALL_GROW_SHARE);
    const scale = POKEBALL_MATERIALIZE_MIN_SCALE + (1 - POKEBALL_MATERIALIZE_MIN_SCALE) * grow;
    const white =
      q < POKEBALL_GROW_SHARE
        ? 1
        : Math.max(0, 1 - (q - POKEBALL_GROW_SHARE) / (1 - POKEBALL_GROW_SHARE));
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
