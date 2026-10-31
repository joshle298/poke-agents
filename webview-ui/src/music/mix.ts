/** Crossfade math for the folder player (pure). */

import { MUSIC_CROSSFADE_MAX_SHARE, MUSIC_CROSSFADE_MS } from './constants.js';

/**
 * Equal-power crossfade at `progress` (0..1): the outgoing track's and the
 * incoming track's gain. Their powers sum to 1, so the mix never dips in the
 * middle the way a linear fade does.
 */
export function crossfadeGains(progress: number): { out: number; in: number } {
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 1));
  return { out: Math.cos((p * Math.PI) / 2), in: Math.sin((p * Math.PI) / 2) };
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
