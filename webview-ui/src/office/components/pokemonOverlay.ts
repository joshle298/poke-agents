/**
 * What the themed overlay label says about a Pokémon: nickname, level,
 * species, status badges and HP. Pure (Node-tested); ToolOverlay renders it.
 */

import {
  HP_COLOR_HIGH,
  HP_COLOR_LOW,
  HP_COLOR_MID,
  HP_HIGH_THRESHOLD,
  HP_LOW_THRESHOLD,
} from '../../constants.js';
import type { PokemonCondition } from '../engine/pokemonAnim.js';
import { pokemonCondition } from '../engine/pokemonAnim.js';
import { hasPokemonIdentity, isPokemonSpriteUnavailable } from '../engine/pokemonCharacter.js';
import { getPokemonSpeciesName } from '../sprites/pokemonSprites.js';
import type { Character } from '../types.js';

/** The overlay is themed for a Pokémon while the theme is on — even before
 *  its sheets decode (an orb). Theme off, sub-agents, and hosts that send
 *  no species (VS Code, `--no-sprites`): the upstream label. */
export function isThemedOverlay(ch: Character): boolean {
  return hasPokemonIdentity(ch) && !ch.isSubagent;
}

export interface PokemonLabel {
  /** Line 1: the nickname, else the species name, else nothing. */
  nickname: string | null;
  /** "Lv 12", when the level is known. */
  level: string | null;
  /** Small text under line 1, when the nickname isn't already the species. */
  species: string | null;
  condition: PokemonCondition;
  /** Its sprites can't load for now: the orb stays closed. */
  spriteUnavailable: boolean;
}

export const CONDITION_BADGE: Record<Exclude<PokemonCondition, null>, string> = {
  asleep: 'SLP',
  fainted: 'FNT',
  needsYou: '!',
};

export function pokemonLabel(ch: Character): PokemonLabel {
  const speciesName =
    ch.species !== undefined
      ? (getPokemonSpeciesName(ch.species, ch.shiny === true) ?? null)
      : null;
  const nickname = ch.label?.trim() || speciesName;
  return {
    nickname: nickname || null,
    level: ch.level !== undefined ? `Lv ${ch.level}` : null,
    species: speciesName && speciesName !== nickname ? speciesName : null,
    condition: pokemonCondition(ch),
    spriteUnavailable: isPokemonSpriteUnavailable(ch),
  };
}

/**
 * The small line above a themed label's nickname: LEAD for a Lead, a child's
 * name only when the nickname line doesn't already show it. A spawned
 * Conductor session's agentName is its session label, which is also its
 * nickname, so it would otherwise read twice.
 */
export function themedRoleLabel(ch: Character, nickname: string | null): string | null {
  if (ch.isTeamLead) return 'LEAD';
  const name = ch.agentName?.trim();
  if (!name || name === nickname?.trim()) return null;
  return name;
}

/** HP = context left: 1 − used/window, clamped to 0..1. */
export function hpFraction(contextTokens: number, maxContextTokens: number): number {
  if (maxContextTokens <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - contextTokens / maxContextTokens));
}

/** Green above half, yellow down to a fifth, red below. */
export function hpColor(hp: number): string {
  if (hp > HP_HIGH_THRESHOLD) return HP_COLOR_HIGH;
  if (hp >= HP_LOW_THRESHOLD) return HP_COLOR_MID;
  return HP_COLOR_LOW;
}
