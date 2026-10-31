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
import type { PokemonGeometry } from '../sprites/pokemonSprites.js';
import {
  getPokemonAnimSource,
  getPokemonGeometry,
  getPokemonSpeciesInfo,
  isPokemonReady,
} from '../sprites/pokemonSprites.js';
import type { Character } from '../types.js';
import { CharacterState } from '../types.js';
import type { PokemonAnimSource } from './pokemonAnim.js';
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

/** Click box in world px for a character drawn as a Pokémon, else null. */
export function pokemonHitBox(
  ch: Character,
): { left: number; right: number; top: number; bottom: number } | null {
  const g = pokemonGeometryOf(ch);
  if (!g) return null;
  const groundY = pokemonGroundY(ch);
  return {
    left: ch.x - g.bodyHalfW,
    right: ch.x + g.bodyHalfW,
    top: groundY - g.headRise,
    bottom: groundY + POKEMON_FEET_BELOW_GROUND_PX,
  };
}

/**
 * World y an overlay hangs from: the status label (`label`) or the speech
 * bubble (`bubble`). Pokémon use their measured head height; everyone else
 * keeps the upstream offsets, so the theme-off overlay is unchanged.
 */
export function overlayAnchorY(ch: Character, kind: 'label' | 'bubble'): number {
  const g = pokemonGeometryOf(ch);
  const seated = ch.state === CharacterState.TYPE;
  if (!g) {
    return kind === 'label'
      ? ch.y + (seated ? CHARACTER_SITTING_OFFSET_PX : 0) - TOOL_OVERLAY_VERTICAL_OFFSET
      : ch.y + (seated ? BUBBLE_SITTING_OFFSET_PX : 0) - BUBBLE_VERTICAL_OFFSET_PX;
  }
  const headY = pokemonGroundY(ch) - g.headRise;
  return headY - (kind === 'label' ? POKEMON_LABEL_GAP_PX : POKEMON_BUBBLE_GAP_PX);
}

/** World point at a character's chest: where links and projectiles attach. */
export function characterChest(ch: Character): { x: number; y: number } {
  const g = pokemonGeometryOf(ch);
  if (g) return { x: ch.x, y: pokemonGroundY(ch) - Math.round(g.headRise / 2) };
  const seated = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
  return { x: ch.x, y: ch.y + seated - Math.round(BUBBLE_VERTICAL_OFFSET_PX / 2) };
}
