/**
 * Loudness matching for decoded files (cries, sound pack): one gain per file
 * that brings its RMS to the synth's level, so a loud cry and a quiet one,
 * or a user's file, sit at the same level as the effects. Pure.
 */

import {
  SOUND_FILE_GAIN_MAX,
  SOUND_FILE_GAIN_MIN,
  SOUND_FILE_SILENCE,
  SOUND_FILE_TARGET_RMS,
} from './constants.js';

/** Every n-th sample is enough for an RMS estimate. */
const RMS_STRIDE = 4;

/** Gain that brings `samples` (one channel) to SOUND_FILE_TARGET_RMS, measured
 *  over the samples that aren't silence, clamped to a sane range. */
export function loudnessGain(samples: ArrayLike<number>): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < samples.length; i += RMS_STRIDE) {
    const x = samples[i];
    if (Math.abs(x) < SOUND_FILE_SILENCE) continue;
    sum += x * x;
    count++;
  }
  if (count === 0) return 1;
  const rms = Math.sqrt(sum / count);
  return Math.min(SOUND_FILE_GAIN_MAX, Math.max(SOUND_FILE_GAIN_MIN, SOUND_FILE_TARGET_RMS / rms));
}
