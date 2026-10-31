/**
 * The synthesized effects' shape (length, click-free envelopes, even
 * loudness), the sound pack list parser, same-origin URLs and the stored
 * volume.
 */

import { describe, expect, it } from 'vitest';

import {
  SOUND_DEFAULT_VOLUME,
  SOUND_FILE_GAIN_MAX,
  SOUND_FILE_TARGET_RMS,
} from '../src/audio/constants.js';
import { loudnessGain } from '../src/audio/loudness.js';
import { isSameOriginUrl } from '../src/audio/sameOrigin.js';
import { hz, recipeDuration, recipePeak, SFX_RECIPES } from '../src/audio/sfxRecipes.js';
import { SFX_CATEGORY, SFX_NAMES } from '../src/audio/soundEvents.js';
import { parseSoundPackList, soundPackFileUrl } from '../src/audio/soundPack.js';
import { parseVolume } from '../src/audio/soundPrefs.js';

describe('synthesized effects', () => {
  it('every effect has a recipe and a category', () => {
    for (const name of SFX_NAMES) {
      expect(SFX_RECIPES[name].voices.length, name).toBeGreaterThan(0);
      expect(SFX_CATEGORY[name], name).toBeDefined();
    }
  });

  it('each lasts at most 1.2 s', () => {
    for (const name of SFX_NAMES) {
      expect(recipeDuration(SFX_RECIPES[name]), name).toBeLessThanOrEqual(1.2);
    }
  });

  it('every voice ramps in and out of silence (no clicks)', () => {
    for (const name of SFX_NAMES) {
      for (const v of SFX_RECIPES[name].voices) {
        expect(v.attack, name).toBeGreaterThanOrEqual(0.002);
        expect(v.release, name).toBeGreaterThanOrEqual(0.01);
        expect(v.attack + v.decay + v.release, name).toBeLessThanOrEqual(v.duration + 1e-9);
        expect(v.sustain, name).toBeGreaterThanOrEqual(0);
        expect(v.sustain, name).toBeLessThanOrEqual(1);
        expect(v.start, name).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('stays in a sane pitch range', () => {
    for (const name of SFX_NAMES) {
      for (const v of SFX_RECIPES[name].voices) {
        for (const f of [v.freq, v.freqEnd ?? v.freq]) {
          expect(f, name).toBeGreaterThanOrEqual(40);
          expect(f, name).toBeLessThanOrEqual(12_000);
        }
      }
    }
  });

  it('peaks at a similar level (within about 6 dB of each other)', () => {
    const peaks = SFX_NAMES.map((name) => [name, recipePeak(SFX_RECIPES[name])] as const);
    for (const [name, peak] of peaks) {
      expect(peak, name).toBeGreaterThanOrEqual(0.25);
      expect(peak, name).toBeLessThanOrEqual(0.5);
    }
  });

  it('hz maps MIDI notes to equal temperament', () => {
    expect(hz(69)).toBe(440);
    expect(hz(81)).toBeCloseTo(880, 6);
  });
});

describe('sound pack list', () => {
  it('keeps well-formed overrides for known effects only', () => {
    expect(
      parseSoundPackList({
        overrides: [
          { event: 'alert', format: 'ogg', size: 10, version: '10-1' },
          { event: 'alert', format: 'mp3', size: 10, version: '10-2' },
          { event: 'levelUp', format: 'wav', size: 20, version: '20-3' },
          { event: 'evil', format: 'ogg', size: 1, version: '1-1' },
          { event: 'done', format: 'exe', size: 1, version: '1-1' },
          { event: 'blip', format: 'ogg', size: 1, version: '../x' },
          null,
        ],
      }),
    ).toEqual([
      { event: 'alert', format: 'ogg', size: 10, version: '10-1' },
      { event: 'levelUp', format: 'wav', size: 20, version: '20-3' },
    ]);
    expect(parseSoundPackList(null)).toEqual([]);
    expect(parseSoundPackList({ overrides: 'no' })).toEqual([]);
  });

  it('builds a versioned same-origin URL', () => {
    expect(soundPackFileUrl({ event: 'ballPop', format: 'mp3', size: 5, version: '5-99' })).toBe(
      '/api/sounds/ballPop?v=5-99',
    );
  });
});

describe('same-origin sound URLs', () => {
  const origin = 'http://127.0.0.1:41510';
  it('accepts relative and same-origin URLs, refuses everything else', () => {
    expect(isSameOriginUrl('/api/pokemon/cry/0025', origin)).toBe(true);
    expect(isSameOriginUrl('http://127.0.0.1:41510/api/sounds/alert', origin)).toBe(true);
    expect(isSameOriginUrl('https://raw.githubusercontent.com/x.ogg', origin)).toBe(false);
    expect(isSameOriginUrl('//evil.example/x.ogg', origin)).toBe(false);
    expect(isSameOriginUrl('data:audio/ogg;base64,AAAA', origin)).toBe(false);
    expect(isSameOriginUrl('/api/pokemon/cry/0025', undefined)).toBe(false);
  });
});

describe('loudness matching for cries and pack files', () => {
  const sine = (amplitude: number, silence = 0) => {
    const out = new Float32Array(44_100 + silence);
    for (let i = 0; i < 44_100; i++)
      out[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / 44_100);
    return out;
  };

  it('brings a file to the target RMS, ignoring its silent tail', () => {
    const gain = loudnessGain(sine(1));
    expect(gain * Math.SQRT1_2).toBeCloseTo(SOUND_FILE_TARGET_RMS, 2);
    expect(loudnessGain(sine(1, 88_200))).toBeCloseTo(gain, 2);
  });

  it('a hot cry is turned down more than a quiet one, within limits', () => {
    expect(loudnessGain(sine(1))).toBeLessThan(loudnessGain(sine(0.25)));
    expect(loudnessGain(sine(0.005))).toBe(SOUND_FILE_GAIN_MAX);
    expect(loudnessGain(new Float32Array(1000))).toBe(1);
  });
});

describe('stored volume', () => {
  it('reads 0..1 and falls back to the default', () => {
    expect(parseVolume('0.25')).toBe(0.25);
    expect(parseVolume('7')).toBe(1);
    expect(parseVolume('-1')).toBe(0);
    expect(parseVolume('loud')).toBe(SOUND_DEFAULT_VOLUME);
    expect(parseVolume('')).toBe(SOUND_DEFAULT_VOLUME);
    expect(parseVolume(null)).toBe(SOUND_DEFAULT_VOLUME);
  });
});
