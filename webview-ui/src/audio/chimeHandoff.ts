/**
 * Who keeps the office's upstream chime (notificationSound.ts). Claude Code
 * and other upstream agents do. A stream agent (a Conductor session: its
 * character has a providerId) gets its alert, faint and done sounds from
 * usePokemonSounds.ts instead, and must not chime on top of them.
 * useExtensionMessages asks here before playing a chime.
 */

import type { StatusChime } from '../office/chimePolicy.js';

/** The chime an agentStatus plays: chimePolicy's answer, for upstream agents only. */
export function upstreamStatusChime(
  chime: StatusChime,
  providerId: string | undefined,
): StatusChime {
  return providerId === undefined ? chime : null;
}

/** Whether a permission prompt chimes: upstream agents only. */
export function upstreamPermissionChimes(providerId: string | undefined): boolean {
  return providerId === undefined;
}
