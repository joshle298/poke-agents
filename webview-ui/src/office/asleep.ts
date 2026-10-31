/**
 * When a session is asleep: the one rule the office (Sleep anim, Zzz, SLP
 * label, no wandering) and the party bar and Pokédex (SLP badge, "Asleep")
 * share, so they never disagree.
 *
 * Asleep = the session is done or idle (no turn running, no tool open, not
 * fainted, not waiting on the user) and nothing has happened in it for
 * SLEEP_AFTER_MS. Both surfaces read the same facts (the party's agent in
 * conductorStore, see conductor/party.ts `sleepFactsOf`) and the wall clock.
 * Pure and DOM-free (Node-tested).
 */

import { SLEEP_AFTER_MS, SLEEP_DROWSY_MS } from '../constants.js';

export interface SleepFacts {
  /** Done or idle: no turn running, no tool open, not fainted, not needing the user. */
  resting: boolean;
  /** Epoch ms of the newest activity seen (what the provider observed, or a
   *  turn, tool or message this client saw); 0 or absent = unknown. */
  lastActivityAt?: number;
}

/** Ms until it falls asleep (0 = asleep now), or null when it can't: it is
 *  not resting, or nothing says when it was last active. */
export function msUntilAsleep(facts: SleepFacts | null | undefined, now: number): number | null {
  if (!facts?.resting) return null;
  const last = facts.lastActivityAt ?? 0;
  if (!(last > 0)) return null;
  return Math.max(0, last + SLEEP_AFTER_MS - now);
}

export function isAsleep(facts: SleepFacts | null | undefined, now: number): boolean {
  return msUntilAsleep(facts, now) === 0;
}

/** About to fall asleep: resting and within SLEEP_DROWSY_MS of it. */
export function isDrowsy(facts: SleepFacts | null | undefined, now: number): boolean {
  const left = msUntilAsleep(facts, now);
  return left !== null && left > 0 && left <= SLEEP_DROWSY_MS;
}

/** Epoch ms at which the next of these falls asleep, or null when none will
 *  (the party bar re-renders then, so its SLP lands with the office's). */
export function nextSleepAt(
  all: Iterable<SleepFacts | null | undefined>,
  now: number,
): number | null {
  let next: number | null = null;
  for (const facts of all) {
    const left = msUntilAsleep(facts, now);
    if (left === null || left === 0) continue;
    if (next === null || now + left < next) next = now + left;
  }
  return next;
}
