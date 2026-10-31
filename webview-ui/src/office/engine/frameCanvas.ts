/**
 * One sprite frame as a canvas source rectangle, and the canvases derived
 * from it by compositing: the selection outline, flat-colour silhouettes
 * (spawn flash, evolution, recall) and a tinted copy (fainted). Each is built
 * once at 1x and cached per source image; zoom happens in drawImage.
 *
 * Works for Pokémon sheets (an ImageBitmap plus the frame's rectangle) and
 * for upstream SpriteData (its 1x canvas), so the capsule effect can open
 * on either. DOM: only the renderer imports this.
 */

import { FRAME_GREY, POKEMON_OUTLINE_COLOR } from '../../constants.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import type { SpriteData } from '../types.js';

export interface FrameRef {
  image: CanvasImageSource;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** The frame pixel drawn on the character's world anchor. */
  anchorX: number;
  anchorY: number;
}

/** An upstream sprite as a frame, anchored bottom-centre like the renderer. */
export function spriteFrame(sprite: SpriteData): FrameRef {
  const image = getCachedSprite(sprite, 1);
  return {
    image,
    sx: 0,
    sy: 0,
    sw: image.width,
    sh: image.height,
    anchorX: image.width / 2,
    anchorY: image.height,
  };
}

const derived = new WeakMap<object, Map<string, HTMLCanvasElement>>();

function derivedCanvas(
  frame: FrameRef,
  kind: string,
  width: number,
  height: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
): HTMLCanvasElement {
  let byKey = derived.get(frame.image);
  if (!byKey) {
    byKey = new Map();
    derived.set(frame.image, byKey);
  }
  const key = `${kind}|${frame.sx},${frame.sy},${frame.sw},${frame.sh}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    paint(ctx);
  }
  byKey.set(key, canvas);
  return canvas;
}

function drawFrameAt(ctx: CanvasRenderingContext2D, frame: FrameRef, x: number, y: number): void {
  ctx.drawImage(frame.image, frame.sx, frame.sy, frame.sw, frame.sh, x, y, frame.sw, frame.sh);
}

/** A 1-px ring around the opaque pixels, (w+2)×(h+2): the frame drawn at its
 *  four neighbours, filled white, with the frame itself cut back out. */
export function frameOutline(frame: FrameRef): HTMLCanvasElement {
  return derivedCanvas(frame, 'outline', frame.sw + 2, frame.sh + 2, (ctx) => {
    drawFrameAt(ctx, frame, 0, 1);
    drawFrameAt(ctx, frame, 2, 1);
    drawFrameAt(ctx, frame, 1, 0);
    drawFrameAt(ctx, frame, 1, 2);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = POKEMON_OUTLINE_COLOR;
    ctx.fillRect(0, 0, frame.sw + 2, frame.sh + 2);
    ctx.globalCompositeOperation = 'destination-out';
    drawFrameAt(ctx, frame, 1, 1);
  });
}

/** The frame's shape in one flat colour. */
export function frameSilhouette(frame: FrameRef, color: string): HTMLCanvasElement {
  return derivedCanvas(frame, `fill:${color}`, frame.sw, frame.sh, (ctx) => {
    drawFrameAt(ctx, frame, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, frame.sw, frame.sh);
  });
}

/** The frame in greys (its saturation removed, its lightness kept), with a
 *  translucent colour laid over: a fainted Pokémon, grey rather than muddy. */
export function frameGreyed(frame: FrameRef, tint: string): HTMLCanvasElement {
  return derivedCanvas(frame, `grey:${tint}`, frame.sw, frame.sh, (ctx) => {
    drawFrameAt(ctx, frame, 0, 0);
    ctx.globalCompositeOperation = 'saturation';
    ctx.fillStyle = FRAME_GREY;
    ctx.fillRect(0, 0, frame.sw, frame.sh);
    // the blend painted the transparent margin grey too: cut back to the shape
    ctx.globalCompositeOperation = 'destination-in';
    drawFrameAt(ctx, frame, 0, 0);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, frame.sw, frame.sh);
  });
}

/**
 * Draw a frame scaled about its anchor, which sits on world point `ground`:
 * the real pixels (skipped once fully covered), then a `coverColor`
 * silhouette at `alpha * cover` on top — so `cover` fades the frame from a
 * flat colour to itself. Scale 1 lands on the device-pixel grid like any
 * sprite.
 */
export function drawFrameScaled(
  ctx: CanvasRenderingContext2D,
  frame: FrameRef,
  ground: { x: number; y: number },
  scale: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
  alpha: number,
  cover: number,
  coverColor: string,
): void {
  if (scale <= 0) return;
  const dw = Math.max(1, Math.round(frame.sw * zoom * scale));
  const dh = Math.max(1, Math.round(frame.sh * zoom * scale));
  const dx = Math.round(offsetX + ground.x * zoom - frame.anchorX * zoom * scale);
  const dy = Math.round(offsetY + ground.y * zoom - frame.anchorY * zoom * scale);
  const prev = ctx.globalAlpha;
  if (cover < 1) {
    ctx.globalAlpha = alpha;
    ctx.drawImage(frame.image, frame.sx, frame.sy, frame.sw, frame.sh, dx, dy, dw, dh);
  }
  if (cover > 0) {
    ctx.globalAlpha = alpha * cover;
    ctx.drawImage(frameSilhouette(frame, coverColor), dx, dy, dw, dh);
  }
  ctx.globalAlpha = prev;
}
