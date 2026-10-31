/**
 * Where a character drawn as a Pokémon, or lying in a bed, actually is: its
 * ground point, hit box and head height. DOM-free, shared by OfficeState
 * (hit-testing), the renderer and the DOM overlays, so all three agree on
 * one set of numbers.
 *
 * A character is drawn as a Pokémon only when the theme is on, it has a
 * species, and that species' sheets are decoded and measured. A character in
 * a bed lies there either way (theme off, as its sprite turned on its side).
 * Otherwise these helpers return null and the caller keeps its upstream
 * geometry.
 */

import {
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  CHARACTER_SITTING_OFFSET_PX,
  POKEMON_BUBBLE_GAP_PX,
  POKEMON_FEET_BELOW_GROUND_PX,
  POKEMON_GROUND_OFFSET_PX,
  POKEMON_LABEL_GAP_PX,
  POKEMON_SITTING_OFFSET_PX,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { PokemonGeometry, PokemonRestPose } from '../sprites/pokemonSprites.js';
import {
  getPokemonAnimMeta,
  getPokemonAnimSource,
  getPokemonGeometry,
  getPokemonPose,
  getPokemonRestPose,
  getPokemonSpeciesInfo,
  isPokemonReady,
} from '../sprites/pokemonSprites.js';
import { getCharacterSprites } from '../sprites/spriteData.js';
import type { Character } from '../types.js';
import { CharacterState, Direction } from '../types.js';
import type { BedLie, PoseBox, QuarterTurn } from './bedLie.js';
import { lieInBed, spritePoseBox } from './bedLie.js';
import type { PokemonAnimSource } from './pokemonAnim.js';
import { choosePokemonAnim, pmdRow } from './pokemonAnim.js';
import { isPokemonThemeEnabled } from './pokemonTheme.js';

/**
 * A Pokémon as far as the UI is concerned: the theme is on and the server
 * sent this character's species (pokemonSpeciesLoaded), even if its sheets
 * are still decoding. Drives the capsule spawn and the themed label. Hosts
 * that never send species (VS Code, `--no-sprites`) stay upstream throughout.
 */
export function hasPokemonIdentity(ch: Character): boolean {
  return (
    isPokemonThemeEnabled() &&
    ch.species !== undefined &&
    getPokemonSpeciesInfo(ch.species, ch.shiny === true) !== undefined
  );
}

/** Drawn as a Pokémon this frame (theme on, species known and decoded). */
export function isPokemonCharacter(ch: Character): boolean {
  return (
    isPokemonThemeEnabled() &&
    ch.species !== undefined &&
    isPokemonReady(ch.species, ch.shiny === true)
  );
}

/** The measured body of a character drawn as a Pokémon, else null. */
export function pokemonGeometryOf(ch: Character): PokemonGeometry | null {
  if (!isPokemonCharacter(ch) || ch.species === undefined) return null;
  return getPokemonGeometry(ch.species, ch.shiny === true);
}

/** How far a character drawn as a Pokémon reaches when it lies fainted
 *  (world px from its ground point, sideways and up; the largest over the
 *  directions it may lie in), else null. */
export function pokemonRestPose(ch: Character): PokemonRestPose | null {
  if (!isPokemonCharacter(ch) || ch.species === undefined) return null;
  return getPokemonRestPose(ch.species, ch.shiny === true);
}

/** Decoded animations of the character's species (metadata only, no theme check). */
export function pokemonAnimSourceOf(ch: Character): PokemonAnimSource | null {
  if (ch.species === undefined) return null;
  return getPokemonAnimSource(ch.species, ch.shiny === true);
}

/** The upright ground point's y (no bed): the tile's centre, lower when seated. */
function standingGroundY(ch: Character): number {
  const sit = ch.state === CharacterState.TYPE ? POKEMON_SITTING_OFFSET_PX : 0;
  return ch.y + sit + POKEMON_GROUND_OFFSET_PX;
}

/**
 * The reach of a lying Pokémon's body as it shows in bed: the frame its faint
 * holds (or frame 0 of a looping one), in the row it lies in. Null when not
 * drawn as a Pokémon or the frame isn't decoded.
 */
function pokemonBedPose(ch: Character): PoseBox | null {
  if (!isPokemonCharacter(ch) || ch.species === undefined) return null;
  const shiny = ch.shiny === true;
  const anims = getPokemonAnimSource(ch.species, shiny);
  const chosen = anims ? choosePokemonAnim(ch, anims.has) : null;
  const meta = chosen ? getPokemonAnimMeta(ch.species, shiny, chosen.anim) : undefined;
  if (!chosen || !meta) return null;
  const frame = chosen.loop ? 0 : meta.frames - 1;
  return getPokemonPose(ch.species, shiny, chosen.anim, pmdRow(ch, meta.directions), frame);
}

/**
 * Where a character lying in a bed is drawn (bedLie.ts): a Pokémon's lying
 * pose, or theme off its upstream sprite turned on its side. Null when it
 * isn't in a bed (or is opening or closing its capsule).
 */
export function bedLieOf(ch: Character): BedLie | null {
  if (!ch.bedRest || ch.matrixEffect) return null;
  if (isPokemonCharacter(ch)) {
    const pose = pokemonBedPose(ch);
    return pose ? lieInBed(pose, ch.bedRest) : null;
  }
  const sprite = getCharacterSprites(ch.palette, ch.hueShift).walk[Direction.DOWN][1];
  return lieInBed(spritePoseBox(sprite), ch.bedRest);
}

/** World y where a Pokémon's ground point is drawn (in bed, where it lies). */
export function pokemonGroundY(ch: Character): number {
  return bedLieOf(ch)?.y ?? standingGroundY(ch);
}

/** Where the renderer draws a Pokémon's frame: its ground point (world px)
 *  and the quarter turn (in bed, a tall pose lies on its side). */
export function pokemonDrawPlace(ch: Character): { x: number; y: number; turn: QuarterTurn } {
  const lie = bedLieOf(ch);
  if (lie) return { x: lie.x, y: lie.y, turn: lie.turn };
  return { x: ch.x, y: standingGroundY(ch), turn: 0 };
}

/**
 * The reach of a Pokémon's body as drawn now (world px from its ground
 * point), measured in the row it is drawn in: its held faint pose while it
 * lies fainted, its sleeping pose while asleep (both much lower than
 * standing); its standing body otherwise. Null when not drawn as a Pokémon.
 */
function drawnPose(ch: Character): { halfW: number; rise: number } | null {
  const g = pokemonGeometryOf(ch);
  if (!g || ch.species === undefined) return null;
  const shiny = ch.shiny === true;
  const anims = getPokemonAnimSource(ch.species, shiny);
  const chosen = anims ? choosePokemonAnim(ch, anims.has) : null;
  const meta = chosen ? getPokemonAnimMeta(ch.species, shiny, chosen.anim) : undefined;
  if (chosen && meta) {
    const row = pmdRow(ch, meta.directions);
    const pose =
      chosen.situation === 'faint'
        ? getPokemonRestPose(ch.species, shiny, row)
        : chosen.situation === 'sleep'
          ? getPokemonPose(ch.species, shiny, chosen.anim, row, 0)
          : null;
    if (pose) return pose;
  }
  return { halfW: g.bodyHalfW, rise: g.headRise };
}

/**
 * A body as drawn now, in world px: its box (also its click box). Lying in a
 * bed (a Pokémon, or theme off a human), or a Pokémon standing, sitting or
 * lying on the floor; null for an upright human, which keeps the upstream
 * click box and overlay offsets.
 */
export function drawnBody(
  ch: Character,
): { left: number; right: number; top: number; bottom: number } | null {
  const lie = bedLieOf(ch);
  if (lie) {
    return {
      left: lie.x - lie.box.left,
      right: lie.x + lie.box.right,
      top: lie.y - lie.box.rise,
      bottom: lie.y + lie.box.drop,
    };
  }
  const pose = drawnPose(ch);
  if (!pose) return null;
  const groundY = standingGroundY(ch);
  return {
    left: ch.x - pose.halfW,
    right: ch.x + pose.halfW,
    top: groundY - pose.rise,
    bottom: groundY + POKEMON_FEET_BELOW_GROUND_PX,
  };
}

/**
 * World y an overlay hangs from: the status label (`label`) or the speech
 * bubble (`bubble`). Pokémon use their measured body as drawn (lying down
 * when fainted); a human lying in bed its turned sprite; everyone else keeps
 * the upstream offsets, so the theme-off overlay is unchanged.
 */
export function overlayAnchorY(ch: Character, kind: 'label' | 'bubble'): number {
  const body = drawnBody(ch);
  if (body) return body.top - (kind === 'label' ? POKEMON_LABEL_GAP_PX : POKEMON_BUBBLE_GAP_PX);
  const seated = ch.state === CharacterState.TYPE;
  return kind === 'label'
    ? ch.y + (seated ? CHARACTER_SITTING_OFFSET_PX : 0) - TOOL_OVERLAY_VERTICAL_OFFSET
    : ch.y + (seated ? BUBBLE_SITTING_OFFSET_PX : 0) - BUBBLE_VERTICAL_OFFSET_PX;
}

/** World x overlays centre on: the middle of a body lying in a bed (its head
 *  is on the pillow, off the bed's middle), else the character's x. */
export function overlayAnchorX(ch: Character): number {
  const lie = bedLieOf(ch);
  return lie ? lie.x + (lie.box.right - lie.box.left) / 2 : ch.x;
}

/** World y of the top of a character's body as drawn now (for an upright
 *  human, its bubble anchor). */
export function bodyTopY(ch: Character): number {
  return drawnBody(ch)?.top ?? overlayAnchorY(ch, 'bubble');
}

/** World point at a character's chest, the middle of its body as drawn:
 *  where projectiles attach. */
export function characterChest(ch: Character): { x: number; y: number } {
  const body = drawnBody(ch);
  if (body) {
    return {
      x: Math.round((body.left + body.right) / 2),
      y: Math.round((body.top + body.bottom) / 2),
    };
  }
  const seated = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
  return { x: ch.x, y: ch.y + seated - Math.round(BUBBLE_VERTICAL_OFFSET_PX / 2) };
}

/**
 * World point a link on the floor ends at: where the character stands, or,
 * when it is drawn away from its tile's centre (a Pokémon seated at a desk,
 * anyone lying in a bed), the middle of its body, so the line reaches the
 * sprite and not the empty chair under it.
 */
export function linkEnd(ch: Character): { x: number; y: number } {
  const seatedPokemon = ch.state === CharacterState.TYPE && pokemonGeometryOf(ch) !== null;
  if (seatedPokemon || bedLieOf(ch)) return characterChest(ch);
  return { x: ch.x, y: ch.y };
}
