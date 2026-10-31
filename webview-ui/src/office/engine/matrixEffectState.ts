/**
 * The spawn/despawn effect's STATE half: starting one, advancing its timer,
 * and reporting when it finished.
 *
 * Deliberately separate from `matrixEffect.ts` / `pokeballEffect.ts`, which
 * draw it: drawing needs a CanvasRenderingContext2D, and OfficeState — a pure
 * state container the Node-runner unit tests import directly — has no
 * business pulling a DOM type into its module graph just to reset three
 * fields.
 *
 * Two looks share the one `matrixEffect` field (its name and values are an
 * e2e contract): the upstream matrix rain, and — for a Pokémon while the
 * theme is on — a Poké Ball thrown open on spawn and a red recall on
 * despawn. Each has its own duration.
 */

import { MATRIX_SPRITE_COLS, POKEBALL_RECALL_SEC, POKEBALL_SPAWN_SEC } from '../../constants.js';
import type { Character } from '../types.js';
import { MATRIX_EFFECT_DURATION } from '../types.js';
import { hasPokemonIdentity } from './pokemonCharacter.js';

export type SpawnEffectStyle = 'matrix' | 'pokeball';

/** Poké Ball for a known Pokémon while the theme is on (even before its
 *  sheets decode — the ball then opens on the upstream character). The
 *  greeter, theme-off characters and hosts without species keep the matrix
 *  rain. */
export function spawnEffectStyle(ch: Character): SpawnEffectStyle {
  return hasPokemonIdentity(ch) ? 'pokeball' : 'matrix';
}

/** How long the character's current effect runs. */
export function matrixEffectDurationSec(ch: Character): number {
  if (spawnEffectStyle(ch) === 'matrix') return MATRIX_EFFECT_DURATION;
  return ch.matrixEffect === 'despawn' ? POKEBALL_RECALL_SEC : POKEBALL_SPAWN_SEC;
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

/** Begin (or restart) a materialization on `ch`. The three fields always move
 *  together — setting the effect without fresh seeds replays the last one's
 *  column timing, and without a zeroed timer it finishes early. */
export function startMatrixEffect(ch: Character, kind: 'spawn' | 'despawn'): void {
  ch.matrixEffect = kind;
  ch.matrixEffectTimer = 0;
  ch.matrixEffectSeeds = matrixEffectSeeds();
}

/** What one frame of `advanceMatrixEffect` did.
 *  - `none`: no effect running; the caller's normal per-frame logic applies.
 *  - `running`: still materializing — skip the FSM this frame.
 *  - `spawned`: finished appearing; the effect is cleared and the FSM resumes
 *    next frame.
 *  - `despawned`: finished disappearing. The effect is left SET so the
 *    character keeps rendering as gone, and removing it is the caller's job. */
export type MatrixEffectTick = 'none' | 'running' | 'spawned' | 'despawned';

export function advanceMatrixEffect(ch: Character, dt: number): MatrixEffectTick {
  if (!ch.matrixEffect) return 'none';
  ch.matrixEffectTimer += dt;
  if (ch.matrixEffectTimer < matrixEffectDurationSec(ch)) return 'running';
  if (ch.matrixEffect === 'despawn') return 'despawned';
  ch.matrixEffect = null;
  ch.matrixEffectTimer = 0;
  ch.matrixEffectSeeds = [];
  ch.effectOrigin = undefined;
  return 'spawned';
}
