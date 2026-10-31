/**
 * Ducking: folder music dips while a Pokémon cry or an alert plays, then comes
 * back. Sound effects call `duckMusic(ms)` when they start; the folder player
 * reads `duckFactor()` on its volume ramp. Overlapping ducks extend each other.
 * Music playing in the Music or Spotify app is not ducked (changing an app's
 * volume behind the user's back would be worse than a moment of overlap).
 *
 * DOM-free: `createDucker` takes the clock, so the curve is unit-tested.
 */

import {
  MUSIC_DUCK_ATTACK_MS,
  MUSIC_DUCK_LEVEL,
  MUSIC_DUCK_MAX_MS,
  MUSIC_DUCK_RELEASE_MS,
} from './constants.js';

export interface Ducker {
  /** Lower the music for `ms` (to `level` of normal, default MUSIC_DUCK_LEVEL). */
  duck(ms: number, level?: number): void;
  /** Volume multiplier right now: 1 when not ducked, down to the level. */
  factor(): number;
  /** Called whenever a duck starts or is extended. */
  subscribe(listener: () => void): () => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createDucker(now: () => number): Ducker {
  let startedAt = 0;
  let holdUntil = 0;
  let level = 1;
  const listeners = new Set<() => void>();

  /** The multiplier a duck reaches `t` ms after it starts, before release. */
  const attacked = (t: number) => 1 - (1 - level) * clamp(t / MUSIC_DUCK_ATTACK_MS, 0, 1);

  const factor = (): number => {
    const t = now();
    if (t < holdUntil) return attacked(t - startedAt);
    const from = attacked(holdUntil - startedAt);
    const released = clamp((t - holdUntil) / MUSIC_DUCK_RELEASE_MS, 0, 1);
    return from + (1 - from) * released;
  };

  return {
    duck(ms, duckLevel = MUSIC_DUCK_LEVEL) {
      if (!Number.isFinite(ms) || ms <= 0) return;
      const t = now();
      const target = clamp(Number.isFinite(duckLevel) ? duckLevel : MUSIC_DUCK_LEVEL, 0, 1);
      const current = factor();
      if (t >= holdUntil) {
        // A new duck starts from wherever the last release has got to.
        level = target;
        startedAt =
          t - MUSIC_DUCK_ATTACK_MS * clamp((1 - current) / Math.max(1 - target, 1e-6), 0, 1);
      } else {
        level = Math.min(level, target);
      }
      holdUntil = Math.max(holdUntil, t + Math.min(ms, MUSIC_DUCK_MAX_MS));
      for (const listener of listeners) listener();
    },
    factor,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const ducker = createDucker(() =>
  typeof performance !== 'undefined' ? performance.now() : Date.now(),
);

/**
 * Lower folder music for `ms` milliseconds while a cry or alert plays. Safe to
 * call at any time (with no music playing it does nothing audible). Called by
 * the sound engine (audio/audioEngine.ts), not by the Jukebox itself.
 */
export function duckMusic(ms: number, level?: number): void {
  ducker.duck(ms, level);
}

export const duckFactor = (): number => ducker.factor();
export const subscribeDuck = (listener: () => void): (() => void) => ducker.subscribe(listener);
