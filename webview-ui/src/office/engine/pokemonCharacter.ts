/**
 * Where a character drawn as a Pokémon actually is: its ground point, hit
 * box and head height. DOM-free, shared by OfficeState (hit-testing), the
 * renderer and the DOM overlays, so all three agree on one set of numbers.
 *
 * A character is drawn as a Pokémon only when the theme is on, it has a
 * species, and that species' sheets are decoded and measured. Every helper
 * here returns null otherwise and the caller keeps its upstream geometry.
 */

import {
  BED_SLEEPER_LIFT_PX,
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
import type { Character } from '../types.js';
import { CharacterState, TILE_SIZE } from '../types.js';
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

/** World y where a Pokémon's ground point is drawn. */
export function pokemonGroundY(ch: Character): number {
  const sit = ch.state === CharacterState.TYPE ? POKEMON_SITTING_OFFSET_PX : 0;
  return ch.y + sit + POKEMON_GROUND_OFFSET_PX;
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

/** Click box in world px for a character drawn as a Pokémon, else null. */
export function pokemonHitBox(
  ch: Character,
): { left: number; right: number; top: number; bottom: number } | null {
  const pose = drawnPose(ch);
  if (!pose) return null;
  const groundY = pokemonGroundY(ch);
  return {
    left: ch.x - pose.halfW,
    right: ch.x + pose.halfW,
    top: groundY - pose.rise,
    bottom: groundY + POKEMON_FEET_BELOW_GROUND_PX,
  };
}

/**
 * World y of the top of a character's body as it is drawn now: a Pokémon's
 * measured pose (lying down while fainted), or a human lying in bed (theme
 * off: the sprite turned on its side). Null for an upright human, whose
 * overlays keep the upstream offsets.
 */
function drawnTopY(ch: Character): number | null {
  const pose = drawnPose(ch);
  if (pose) return pokemonGroundY(ch) - pose.rise;
  if (ch.bedRest) return ch.y - BED_SLEEPER_LIFT_PX - TILE_SIZE / 2;
  return null;
}

/**
 * World y an overlay hangs from: the status label (`label`) or the speech
 * bubble (`bubble`). Pokémon use their measured body as drawn (lying down
 * when fainted); a human lying in bed its turned sprite; everyone else keeps
 * the upstream offsets, so the theme-off overlay is unchanged.
 */
export function overlayAnchorY(ch: Character, kind: 'label' | 'bubble'): number {
  const top = drawnTopY(ch);
  if (top !== null) return top - (kind === 'label' ? POKEMON_LABEL_GAP_PX : POKEMON_BUBBLE_GAP_PX);
  const seated = ch.state === CharacterState.TYPE;
  return kind === 'label'
    ? ch.y + (seated ? CHARACTER_SITTING_OFFSET_PX : 0) - TOOL_OVERLAY_VERTICAL_OFFSET
    : ch.y + (seated ? BUBBLE_SITTING_OFFSET_PX : 0) - BUBBLE_VERTICAL_OFFSET_PX;
}

/** World y of the top of a character's body as drawn now (for an upright
 *  human, its bubble anchor). */
export function bodyTopY(ch: Character): number {
  return drawnTopY(ch) ?? overlayAnchorY(ch, 'bubble');
}

/** World point at a character's chest: where links and projectiles attach. */
export function characterChest(ch: Character): { x: number; y: number } {
  const pose = drawnPose(ch);
  if (pose) return { x: ch.x, y: pokemonGroundY(ch) - Math.round(pose.rise / 2) };
  const seated = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
  return { x: ch.x, y: ch.y + seated - Math.round(BUBBLE_VERTICAL_OFFSET_PX / 2) };
}
