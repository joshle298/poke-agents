/**
 * When a session is asleep: the one rule the office (Sleep anim, Zzz, SLP
 * label, no wandering) and the party bar and Pokédex (SLP badge, "Asleep")
 * share, so they never disagree.
 *
 * Asleep = the session is done or idle (no turn running, no tool open, not
 * fainted, not waiting on the user) and nothing has happened in it for
 * SLEEP_AFTER_MS. Both surfaces read the same facts (the party's agent in
 * conductorStore, see conductor/party.ts `agentMsUntilAsleep`) and the wall
 * clock. Plain numbers in and out, no objects: the office asks for every
 * character on every frame. Pure and DOM-free (Node-tested).
 */

import { SLEEP_AFTER_MS, SLEEP_DROWSY_MS } from '../constants.js';

/**
 * Ms until a session falls asleep (0 = asleep now), or null when it can't:
 * it is not `resting` (done or idle), or nothing says when it was last
 * active (`lastActivityAt`, epoch ms; 0 or absent = unknown).
 */
export function msUntilAsleep(
  resting: boolean,
  lastActivityAt: number | undefined,
  now: number,
): number | null {
  if (!resting) return null;
  const last = lastActivityAt ?? 0;
  if (!(last > 0)) return null;
  return Math.max(0, last + SLEEP_AFTER_MS - now);
}

/** Asleep, given what msUntilAsleep said. */
export function isAsleep(msLeft: number | null): boolean {
  return msLeft === 0;
}

/** About to fall asleep (within SLEEP_DROWSY_MS of it), given what
 *  msUntilAsleep said. */
export function isDrowsy(msLeft: number | null): boolean {
  return msLeft !== null && msLeft > 0 && msLeft <= SLEEP_DROWSY_MS;
}
