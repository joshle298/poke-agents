/**
 * The radio's off switch. `--no-radio` or POKE_AGENTS_RADIO=off turns Poke
 * Agents Radio off; so does the sound switch (`--no-sounds`,
 * POKE_AGENTS_SOUNDS=off), which promises no audio downloads at all. While the
 * radio is off it downloads nothing, the library lists no radio tracks, and
 * the track route answers 404 for them.
 */

import { areSoundsEnabled } from '../audio/sounds.js';

let radioEnabled = process.env.POKE_AGENTS_RADIO !== 'off';

/** Turn the radio on or off (`--no-radio`, POKE_AGENTS_RADIO=off). */
export function setRadioEnabled(enabled: boolean): void {
  radioEnabled = enabled;
}

/** Why the radio is off right now, or null while it may play. */
export function radioOffReason(): string | null {
  if (!areSoundsEnabled()) return 'Sounds are off (--no-sounds), so the radio is off too.';
  if (!radioEnabled) return 'The radio is off (--no-radio).';
  return null;
}
