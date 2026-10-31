/**
 * The office's effects as data: chiptune voices (square, pulse, triangle,
 * noise) with an ADSR envelope, an optional pitch (or filter) slide and
 * vibrato. synth.ts renders them with Web Audio; the Node runner checks
 * their shape (length, envelopes, loudness).
 *
 * Every sound here is an in-house composition built from plain intervals,
 * arpeggios and slides. None reproduces a melody from the Pokémon games
 * (no level-up, Pokémon Center, evolution, item or battle theme).
 */

import type { SfxName } from './soundEvents.js';

/** square = 50 % pulse; pulse25 / pulse12 = 25 % / 12.5 % duty; noise = white
 *  noise through a band-pass filter centred on `freq`. */
export type Wave = 'square' | 'pulse25' | 'pulse12' | 'triangle' | 'noise';

export interface Voice {
  wave: Wave;
  /** Seconds from the start of the effect. */
  start: number;
  /** Seconds, release included. */
  duration: number;
  /** Hz: the pitch, or the noise filter's centre. */
  freq: number;
  /** Hz at the end of the slide (default: no slide). */
  freqEnd?: number;
  /** Slide length in seconds (default: the whole voice). */
  slideTime?: number;
  /** Peak level before the wave's loudness trim (WAVE_LEVEL). */
  gain: number;
  attack: number;
  decay: number;
  /** Fraction of the peak held after the decay. */
  sustain: number;
  release: number;
  vibratoHz?: number;
  vibratoCents?: number;
  /** Band-pass Q for noise. */
  q?: number;
}

export interface SfxRecipe {
  voices: readonly Voice[];
}

/** Loudness trim per wave: a full square is far louder than a triangle at
 *  the same peak, so every voice is scaled by its wave's level. */
export const WAVE_LEVEL: Readonly<Record<Wave, number>> = {
  square: 0.45,
  pulse25: 0.5,
  pulse12: 0.55,
  triangle: 1,
  noise: 0.6,
};

/** MIDI note number to Hz (A4 = 69 = 440 Hz). */
export function hz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

// Note numbers used below.
const C5 = 72;
const E5 = 76;
const G5 = 79;
const A5 = 81;
const B5 = 83;
const D6 = 86;
const E6 = 88;
const G6 = 91;
const A6 = 93;
const C7 = 96;
const E7 = 100;
const G7 = 103;

/** A short chip note with a quick envelope. */
function note(
  wave: Wave,
  midi: number,
  start: number,
  duration: number,
  gain: number,
  extra: Partial<Voice> = {},
): Voice {
  return {
    wave,
    start,
    duration,
    freq: hz(midi),
    gain,
    attack: 0.004,
    decay: Math.min(0.03, duration / 3),
    sustain: 0.7,
    release: Math.min(0.03, duration / 3),
    ...extra,
  };
}

export const SFX_RECIPES: Readonly<Record<SfxName, SfxRecipe>> = {
  // Needs you: a pager-style double blip, low-high, twice.
  alert: {
    voices: [
      note('pulse25', A5, 0, 0.075, 0.75),
      note('pulse25', E6, 0.085, 0.075, 0.75),
      note('pulse25', A5, 0.2, 0.075, 0.75),
      note('pulse25', E6, 0.285, 0.12, 0.75),
    ],
  },
  // Turn finished: two soft triangle notes, a fourth apart.
  done: {
    voices: [
      note('triangle', E5, 0, 0.13, 0.34, { attack: 0.01, decay: 0.05, sustain: 0.6 }),
      note('triangle', A5, 0.13, 0.3, 0.34, {
        attack: 0.01,
        decay: 0.08,
        sustain: 0.5,
        release: 0.14,
      }),
    ],
  },
  // Fainted: a long falling square with a wobble, ending in a soft thud.
  faint: {
    voices: [
      {
        wave: 'square',
        start: 0,
        duration: 0.75,
        freq: 660,
        freqEnd: 110,
        gain: 0.55,
        attack: 0.005,
        decay: 0.1,
        sustain: 0.8,
        release: 0.2,
        vibratoHz: 9,
        vibratoCents: 40,
      },
      {
        wave: 'noise',
        start: 0.7,
        duration: 0.18,
        freq: 300,
        q: 1,
        gain: 0.3,
        attack: 0.003,
        decay: 0.02,
        sustain: 0.6,
        release: 0.15,
      },
    ],
  },
  // Revived: a quick climb up a major-ninth chord, the top note ringing.
  heal: {
    voices: [
      note('triangle', C5, 0, 0.058, 0.38),
      note('triangle', E5, 0.06, 0.058, 0.38),
      note('triangle', G5, 0.12, 0.058, 0.38),
      note('triangle', B5, 0.18, 0.058, 0.38),
      note('triangle', D6, 0.24, 0.058, 0.38),
      note('triangle', E6, 0.3, 0.32, 0.38, {
        decay: 0.06,
        sustain: 0.6,
        release: 0.16,
        vibratoHz: 6,
        vibratoCents: 15,
      }),
      note('pulse12', E6 + 12, 0.3, 0.3, 0.2, { decay: 0.05, sustain: 0.4, release: 0.15 }),
    ],
  },
  // Level up: a broken arpeggio (root, fifth, third, octave), the last held.
  levelUp: {
    voices: [
      note('pulse25', G5, 0, 0.048, 0.7),
      note('pulse25', D6, 0.05, 0.048, 0.7),
      note('pulse25', B5, 0.1, 0.048, 0.7),
      note('pulse25', G6, 0.15, 0.22, 0.7, { decay: 0.05, sustain: 0.6, release: 0.1 }),
      note('triangle', G5, 0.15, 0.22, 0.15, { decay: 0.05, sustain: 0.6, release: 0.1 }),
    ],
  },
  // Evolution: a shimmering glide up two octaves, then three sparkles.
  evolution: {
    voices: [
      {
        wave: 'triangle',
        start: 0,
        duration: 0.86,
        freq: 220,
        freqEnd: 880,
        gain: 0.34,
        attack: 0.25,
        decay: 0.01,
        sustain: 1,
        release: 0.08,
        vibratoHz: 14,
        vibratoCents: 35,
      },
      {
        wave: 'pulse12',
        start: 0,
        duration: 0.86,
        freq: 330,
        freqEnd: 1320,
        gain: 0.25,
        attack: 0.3,
        decay: 0.01,
        sustain: 1,
        release: 0.08,
        vibratoHz: 14,
        vibratoCents: 35,
      },
      note('pulse25', C7, 0.88, 0.05, 0.5),
      note('pulse25', E7, 0.96, 0.05, 0.5),
      note('pulse25', G7, 1.04, 0.12, 0.5, { sustain: 0.5, release: 0.06 }),
    ],
  },
  // Orb throw: a rising band-passed noise whoosh.
  ballThrow: {
    voices: [
      {
        wave: 'noise',
        start: 0,
        duration: 0.26,
        freq: 500,
        freqEnd: 3200,
        q: 2.5,
        gain: 0.7,
        attack: 0.06,
        decay: 0.05,
        sustain: 0.6,
        release: 0.12,
      },
    ],
  },
  // Orb pop: a dropping pop with a click, then two sparkles.
  ballPop: {
    voices: [
      {
        wave: 'square',
        start: 0,
        duration: 0.05,
        freq: 950,
        freqEnd: 180,
        gain: 0.7,
        attack: 0.002,
        decay: 0.01,
        sustain: 0.6,
        release: 0.02,
      },
      {
        wave: 'noise',
        start: 0,
        duration: 0.03,
        freq: 2500,
        q: 0.8,
        gain: 0.25,
        attack: 0.002,
        decay: 0.005,
        sustain: 0.5,
        release: 0.015,
      },
      note('triangle', A6, 0.07, 0.06, 0.35),
      note('triangle', E7, 0.13, 0.12, 0.3, { sustain: 0.5, release: 0.07 }),
    ],
  },
  // Recall: a falling, buzzing zap and a low blip.
  recall: {
    voices: [
      {
        wave: 'square',
        start: 0,
        duration: 0.28,
        freq: 1500,
        freqEnd: 260,
        gain: 0.6,
        attack: 0.004,
        decay: 0.05,
        sustain: 0.7,
        release: 0.08,
        vibratoHz: 28,
        vibratoCents: 60,
      },
      note('triangle', C5, 0.29, 0.07, 0.3),
    ],
  },
  // Message: a falling whoosh, then a small chirp.
  message: {
    voices: [
      {
        wave: 'noise',
        start: 0,
        duration: 0.2,
        freq: 2400,
        freqEnd: 900,
        q: 2,
        gain: 0.55,
        attack: 0.03,
        decay: 0.04,
        sustain: 0.6,
        release: 0.1,
      },
      {
        wave: 'triangle',
        start: 0.2,
        duration: 0.07,
        freq: 1200,
        freqEnd: 1700,
        gain: 0.3,
        attack: 0.004,
        decay: 0.02,
        sustain: 0.7,
        release: 0.03,
      },
    ],
  },
  // UI blip: one short pulse.
  blip: {
    voices: [note('pulse25', D6, 0, 0.05, 0.6, { decay: 0.015, sustain: 0.6, release: 0.02 })],
  },
};

/** Seconds from the first voice's start to the last voice's end. */
export function recipeDuration(recipe: SfxRecipe): number {
  return Math.max(0, ...recipe.voices.map((v) => v.start + v.duration));
}

/** The loudest moment of a recipe, as the sum of the trimmed peaks of the
 *  voices sounding at once (a loudness proxy for keeping effects even). */
export function recipePeak(recipe: SfxRecipe): number {
  const level = (v: Voice) => v.gain * WAVE_LEVEL[v.wave];
  let peak = 0;
  for (const probe of recipe.voices) {
    for (const t of [probe.start, probe.start + probe.attack]) {
      const sum = recipe.voices
        .filter((v) => v.start <= t && t < v.start + v.duration)
        .reduce((total, v) => total + level(v), 0);
      peak = Math.max(peak, sum);
    }
  }
  return peak;
}
