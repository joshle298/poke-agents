/**
 * The renderer's Pokémon branch: resolve the PMD frame a character shows
 * right now, and queue its z-sorted drawables (outline, body, faint tint,
 * evolution flash, capsule effect). Returns null whenever the character
 * should stay upstream — theme off, no species, sheets not decoded — so it
 * never disappears while sprites load.
 */

import {
  CHARACTER_Z_SORT_OFFSET,
  HOVERED_OUTLINE_ALPHA,
  OUTLINE_Z_SORT_OFFSET,
  PMD_GROUND_Y_OFFSET_PX,
  POKEMON_FAINT_ALPHA,
  POKEMON_FAINT_TINT,
  POKEMON_SILHOUETTE_COLOR,
  SELECTED_OUTLINE_ALPHA,
} from '../../constants.js';
import {
  getPokemonAnimMeta,
  getPokemonAnimSource,
  getPokemonSheet,
} from '../sprites/pokemonSprites.js';
import type { Character } from '../types.js';
import { TILE_SIZE } from '../types.js';
import { renderCapsuleEffect } from './capsuleEffect.js';
import type { FrameRef } from './frameCanvas.js';
import { frameGreyed, frameOutline, frameSilhouette } from './frameCanvas.js';
import {
  choosePokemonAnim,
  evolutionFlashAlpha,
  pmdFrameIndex,
  pmdRow,
  pokemonAnimKey,
} from './pokemonAnim.js';
import { isPokemonCharacter, pokemonDrawPlace, pokemonGeometryOf } from './pokemonCharacter.js';

export interface ZDrawable {
  zY: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

/** The sheet frame a character drawn as a Pokémon shows this frame, or null. */
export function resolvePokemonFrame(ch: Character): FrameRef | null {
  if (!isPokemonCharacter(ch) || ch.species === undefined) return null;
  const shiny = ch.shiny === true;
  const anims = getPokemonAnimSource(ch.species, shiny);
  if (!anims) return null;
  const chosen = choosePokemonAnim(ch, anims.has);
  if (!chosen) return null;
  const meta = getPokemonAnimMeta(ch.species, shiny, chosen.anim);
  const sheet = getPokemonSheet(ch.species, shiny, chosen.anim);
  if (!meta || !sheet) return null;
  // The clock belongs to the anim OfficeState last advanced; a different
  // choice this frame (theme just toggled, sheet just decoded) starts at 0.
  const t = ch.pmdAnimKey === pokemonAnimKey(chosen) ? (ch.pmdAnimTime ?? 0) : 0;
  const col = Math.min(pmdFrameIndex(meta.durations, t, chosen.loop), meta.frames - 1);
  const row = Math.min(pmdRow(ch, meta.directions), meta.directions - 1);
  return {
    image: sheet.image as CanvasImageSource,
    sx: col * meta.frameWidth,
    sy: row * meta.frameHeight,
    sw: meta.frameWidth,
    sh: meta.frameHeight,
    anchorX: Math.floor(meta.frameWidth / 2),
    anchorY: Math.floor(meta.frameHeight / 2) + PMD_GROUND_Y_OFFSET_PX,
  };
}

/** Queue a Pokémon character's drawables, sorted with everything else by the
 *  same z key as upstream characters (so chairs and desks overlap the same). */
export function pushPokemonDrawables(
  drawables: ZDrawable[],
  ch: Character,
  frame: FrameRef,
  offsetX: number,
  offsetY: number,
  zoom: number,
  isSelected: boolean,
  isHovered: boolean,
  ghostAlpha: number,
): void {
  // In bed a tall pose lies on its side: the frame turns about its ground
  // point, a whole device pixel, so it stays on the pixel grid.
  const place = pokemonDrawPlace(ch);
  const groundY = place.y;
  const gx = Math.round(offsetX + place.x * zoom);
  const gy = Math.round(offsetY + place.y * zoom);
  const drawX = gx - frame.anchorX * zoom;
  const drawY = gy - frame.anchorY * zoom;
  const turned = (c: CanvasRenderingContext2D) => {
    if (place.turn === 0) return;
    c.translate(gx, gy);
    c.rotate((place.turn * Math.PI) / 2);
    c.translate(-gx, -gy);
  };
  const zY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET;
  // Fainted: see-through, except in the town, where it walks to the Pokémon
  // Center and rests there at full strength (still grey), so it reads clearly.
  const faintAlpha = ch.townGoal === 'center' ? 1 : POKEMON_FAINT_ALPHA;
  const alpha = ghostAlpha * (ch.isErrored ? faintAlpha : 1);

  if (ch.matrixEffect) {
    const headRise = pokemonGeometryOf(ch)?.headRise ?? frame.anchorY;
    const ground = { x: place.x, y: groundY };
    drawables.push({
      zY,
      draw: (c) =>
        renderCapsuleEffect(c, ch, frame, ground, headRise, offsetX, offsetY, zoom, alpha),
    });
    return;
  }

  if (isSelected || isHovered) {
    const outline = frameOutline(frame);
    const outlineAlpha = isSelected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA;
    drawables.push({
      zY: zY - OUTLINE_Z_SORT_OFFSET,
      draw: (c) => {
        c.save();
        turned(c);
        c.globalAlpha = outlineAlpha;
        c.drawImage(
          outline,
          drawX - zoom,
          drawY - zoom,
          outline.width * zoom,
          outline.height * zoom,
        );
        c.restore();
      },
    });
  }

  const dw = frame.sw * zoom;
  const dh = frame.sh * zoom;
  const flash = evolutionFlashAlpha(ch.evolveTimer);
  const errored = ch.isErrored === true;
  drawables.push({
    zY,
    draw: (c) => {
      c.save();
      turned(c);
      c.globalAlpha = alpha;
      if (errored) {
        c.drawImage(frameGreyed(frame, POKEMON_FAINT_TINT), drawX, drawY, dw, dh);
      } else {
        c.drawImage(frame.image, frame.sx, frame.sy, frame.sw, frame.sh, drawX, drawY, dw, dh);
      }
      if (flash > 0) {
        c.globalAlpha = alpha * flash;
        c.drawImage(frameSilhouette(frame, POKEMON_SILHOUETTE_COLOR), drawX, drawY, dw, dh);
      }
      c.restore();
    },
  });
}
