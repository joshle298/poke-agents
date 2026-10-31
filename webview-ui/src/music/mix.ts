/** Crossfade math for the folder player (pure). */

import { MUSIC_CROSSFADE_MAX_SHARE, MUSIC_CROSSFADE_MS } from './constants.js';

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));
}

/**
 * Equal-power crossfade at `progress` (0..1): the outgoing track's and the
 * incoming track's gain. Their powers sum to 1, so the mix never dips in the
 * middle the way a linear fade does.
 */
export function crossfadeGains(progress: number): { out: number; in: number } {
  const p = clamp01(progress);
  return { out: Math.cos((p * Math.PI) / 2), in: Math.sin((p * Math.PI) / 2) };
}

/**
 * A deck's fade gain `progress` (0..1) into a fade, from the gain `from` it had
 * when the fade began. Outgoing decks fall from there along the equal-power
 * curve; the incoming deck rises from there (equal power when it crosses
 * another deck, linear from silence). A fade that interrupts another (a skip
 * mid-crossfade) therefore never pushes a deck back up.
 */
export function fadeOutGain(from: number, progress: number): number {
  return from * crossfadeGains(progress).out;
}

export function fadeInGain(from: number, progress: number, crossing: boolean): number {
  const rise = crossing ? crossfadeGains(progress).in : clamp01(progress);
  return from + (1 - from) * rise;
}

/** How long the crossfade into the next track lasts for a track of
 *  `durationSec` (short tracks get a shorter one). */
export function crossfadeMsFor(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return MUSIC_CROSSFADE_MS;
  return Math.min(MUSIC_CROSSFADE_MS, durationSec * 1000 * MUSIC_CROSSFADE_MAX_SHARE);
}

/** An <audio> volume from the parts that scale it, clamped to 0..1. */
export function deckVolume(user: number, fade: number, duck: number): number {
  const v = user * fade * duck;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
