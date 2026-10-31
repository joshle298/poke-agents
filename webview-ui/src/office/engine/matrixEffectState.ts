/**
 * The spawn/despawn effect's STATE half: starting one, advancing its timer,
 * and reporting when it finished.
 *
 * Deliberately separate from `matrixEffect.ts` / `orbEffect.ts`, which
 * draw it: drawing needs a CanvasRenderingContext2D, and OfficeState — a pure
 * state container the Node-runner unit tests import directly — has no
 * business pulling a DOM type into its module graph just to reset three
 * fields.
 *
 * Two looks share the one `matrixEffect` field (its name and values are an
 * e2e contract): the upstream matrix rain, and — for a Pokémon while the
 * theme is on — an orb thrown open on spawn and a beam back into it on
 * despawn. Each has its own duration.
 */

import {
  MATRIX_SPRITE_COLS,
  ORB_RECALL_SEC,
  ORB_SPAWN_SEC,
  ORB_THROW_END,
  ORB_WAIT_MAX_SEC,
} from '../../constants.js';
import type { Character } from '../types.js';
import { MATRIX_EFFECT_DURATION } from '../types.js';
import { hasPokemonIdentity, isPokemonPlaceholder } from './pokemonCharacter.js';
import { isPokemonOffice } from './pokemonTheme.js';

export type SpawnEffectStyle = 'matrix' | 'orb';

/** The orb for a Pokémon while the theme is on (even before its species
 *  or sheets arrive: the orb then lands closed and waits), and for the
 *  greeter in a Pokémon office (Promptling steps out of it). Theme-off
 *  characters, hosts without species and the greeter elsewhere keep the
 *  matrix rain. */
export function spawnEffectStyle(ch: Character): SpawnEffectStyle {
  if (hasPokemonIdentity(ch)) return 'orb';
  return ch.isGreeter && isPokemonOffice() ? 'orb' : 'matrix';
}

/** How long the character's current effect runs. */
export function matrixEffectDurationSec(ch: Character): number {
  if (spawnEffectStyle(ch) === 'matrix') return MATRIX_EFFECT_DURATION;
  return ch.matrixEffect === 'despawn' ? ORB_RECALL_SEC : ORB_SPAWN_SEC;
}

/** Per-column stagger seeds. The rain renderer reuses them modulo their count
 *  for frames wider than MATRIX_SPRITE_COLS. */
export function matrixEffectSeeds(count = MATRIX_SPRITE_COLS): number[] {
  const seeds: number[] = [];
  for (let i = 0; i < count; i++) {
    seeds.push(Math.random());
  }
  return seeds;
}

/** Begin (or restart) a materialization on `ch`. The fields always move
 *  together — setting the effect without fresh seeds replays the last one's
 *  column timing, and without a zeroed timer it finishes early. */
export function startMatrixEffect(ch: Character, kind: 'spawn' | 'despawn'): void {
  ch.matrixEffect = kind;
  ch.matrixEffectTimer = 0;
  ch.matrixEffectSeeds = matrixEffectSeeds();
  ch.spawnHoldSec = undefined;
  ch.orbWaitSec = undefined;
}

/** What one frame of `advanceMatrixEffect` did.
 *  - `none`: no effect running; the caller's normal per-frame logic applies.
 *  - `running`: still materializing — skip the FSM this frame.
 *  - `spawned`: finished appearing; the effect is cleared and the FSM resumes
 *    next frame.
 *  - `despawned`: finished disappearing. The effect is left SET so the
 *    character keeps rendering as gone, and removing it is the caller's job. */
export type MatrixEffectTick = 'none' | 'running' | 'spawned' | 'despawned';

/** Seconds into an orb spawn where the orb has landed, closed. */
export const ORB_LANDED_SEC = ORB_SPAWN_SEC * ORB_THROW_END;

/**
 * Advance the effect by `dt`. An orb whose Pokémon can't be drawn yet
 * (species or sheets still on their way) lands and stays closed: its spawn
 * holds at the landing until the sheets are ready, at most
 * ORB_WAIT_MAX_SEC; after that the spawn ends and the closed orb
 * just stays (OfficeState opens it once the sheets arrive).
 */
export function advanceMatrixEffect(ch: Character, dt: number): MatrixEffectTick {
  if (!ch.matrixEffect) return 'none';
  const waiting =
    ch.matrixEffect === 'spawn' &&
    ch.matrixEffectTimer + dt >= ORB_LANDED_SEC &&
    isPokemonPlaceholder(ch);
  if (waiting) {
    ch.matrixEffectTimer = Math.max(ch.matrixEffectTimer, ORB_LANDED_SEC);
    ch.spawnHoldSec = (ch.spawnHoldSec ?? 0) + dt;
    if (ch.spawnHoldSec < ORB_WAIT_MAX_SEC) return 'running';
    // It goes on resting closed: its wait (and bob) carries on from here,
    // so it opens rather than pops once the sheets arrive.
    ch.orbWaitSec = ch.spawnHoldSec;
  } else {
    ch.matrixEffectTimer += dt;
    if (ch.matrixEffectTimer < matrixEffectDurationSec(ch)) return 'running';
  }
  if (ch.matrixEffect === 'despawn') return 'despawned';
  ch.matrixEffect = null;
  ch.matrixEffectTimer = 0;
  ch.matrixEffectSeeds = [];
  ch.effectOrigin = undefined;
  ch.spawnHoldSec = undefined;
  return 'spawned';
}

/** Open a closed orb in place: the spawn from its landing on (the burst,
 *  then the Pokémon grows out), no throw. */
export function startOrbOpen(ch: Character): void {
  startMatrixEffect(ch, 'spawn');
  ch.matrixEffectTimer = ORB_LANDED_SEC;
  ch.effectOrigin = undefined;
}
