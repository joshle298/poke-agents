import { describe, expect, it, vi } from 'vitest';

import {
  MUSIC_CROSSFADE_MS,
  MUSIC_DUCK_ATTACK_MS,
  MUSIC_DUCK_LEVEL,
  MUSIC_DUCK_MAX_MS,
  MUSIC_DUCK_RELEASE_MS,
} from '../src/music/constants.js';
import { createDucker } from '../src/music/duck.js';
import { crossfadeGains, crossfadeMsFor, deckVolume } from '../src/music/mix.js';

function clocked() {
  let t = 10_000;
  const ducker = createDucker(() => t);
  return {
    ducker,
    at: (ms: number) => {
      t = 10_000 + ms;
      return ducker.factor();
    },
  };
}

describe('duckMusic', () => {
  it('leaves the music alone until asked', () => {
    const { at } = clocked();
    expect(at(0)).toBe(1);
  });

  it('dips quickly, holds, then comes back slowly', () => {
    const { ducker, at } = clocked();
    at(0);
    ducker.duck(1_000);
    expect(at(MUSIC_DUCK_ATTACK_MS / 2)).toBeCloseTo(1 - (1 - MUSIC_DUCK_LEVEL) / 2);
    expect(at(MUSIC_DUCK_ATTACK_MS)).toBeCloseTo(MUSIC_DUCK_LEVEL);
    expect(at(999)).toBeCloseTo(MUSIC_DUCK_LEVEL);
    expect(at(1_000 + MUSIC_DUCK_RELEASE_MS / 2)).toBeCloseTo((1 + MUSIC_DUCK_LEVEL) / 2);
    expect(at(1_000 + MUSIC_DUCK_RELEASE_MS)).toBe(1);
  });

  it('lets overlapping cries extend the duck and keeps the deepest level', () => {
    const { ducker, at } = clocked();
    at(0);
    ducker.duck(500, 0.5);
    at(300);
    ducker.duck(500, 0.2);
    expect(at(700)).toBeCloseTo(0.2);
    expect(at(799)).toBeCloseTo(0.2);
    expect(at(800 + MUSIC_DUCK_RELEASE_MS)).toBe(1);
  });

  it('starts a new duck from where the last release had got to (no jump)', () => {
    const { ducker, at } = clocked();
    at(0);
    ducker.duck(200);
    const mid = at(200 + MUSIC_DUCK_RELEASE_MS / 2);
    ducker.duck(200);
    expect(at(200 + MUSIC_DUCK_RELEASE_MS / 2)).toBeCloseTo(mid);
    expect(at(200 + MUSIC_DUCK_RELEASE_MS / 2 + MUSIC_DUCK_ATTACK_MS)).toBeCloseTo(
      MUSIC_DUCK_LEVEL,
    );
  });

  it('caps a duck, ignores nonsense and tells subscribers', () => {
    const { ducker, at } = clocked();
    const listener = vi.fn();
    const off = ducker.subscribe(listener);
    at(0);
    ducker.duck(0);
    ducker.duck(-5);
    ducker.duck(Number.NaN);
    expect(listener).not.toHaveBeenCalled();
    expect(at(10)).toBe(1);
    ducker.duck(10 * 60_000, 7);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(at(MUSIC_DUCK_ATTACK_MS)).toBe(1); // a level above 1 is clamped: no change
    off();
    ducker.duck(100);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(at(10 + MUSIC_DUCK_MAX_MS + MUSIC_DUCK_RELEASE_MS)).toBe(1);
  });
});

describe('crossfade math', () => {
  it('keeps the combined power constant through an equal-power fade', () => {
    for (const p of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
      const { out, in: incoming } = crossfadeGains(p);
      expect(out * out + incoming * incoming).toBeCloseTo(1);
    }
    expect(crossfadeGains(0)).toEqual({ out: 1, in: 0 });
    expect(crossfadeGains(1).in).toBeCloseTo(1);
    expect(crossfadeGains(5).in).toBeCloseTo(1);
    expect(crossfadeGains(Number.NaN).in).toBeCloseTo(1);
  });

  it('shortens the crossfade for short tracks', () => {
    expect(crossfadeMsFor(180)).toBe(MUSIC_CROSSFADE_MS);
    expect(crossfadeMsFor(3)).toBe(1_000);
    expect(crossfadeMsFor(Number.NaN)).toBe(MUSIC_CROSSFADE_MS);
  });

  it('multiplies volume, fade and duck into 0..1', () => {
    expect(deckVolume(0.5, 1, 1)).toBe(0.5);
    expect(deckVolume(0.8, 0.5, 0.25)).toBeCloseTo(0.1);
    expect(deckVolume(2, 1, 1)).toBe(1);
    expect(deckVolume(Number.NaN, 1, 1)).toBe(0);
  });
});
