/**
 * Small React hooks for the Conductor chrome: a clock for time-derived text
 * (asleep slots, "synced 5s ago") and the window width that picks the party
 * bar and Pokédex layouts.
 */

import { useEffect, useState } from 'react';

import { nextSleepAt } from '../office/asleep.js';
import { useConductor } from './conductorStore.js';
import { sleepFactsOf } from './party.js';

/** Date.now(), refreshed every `intervalMs` while mounted (and `enabled`). */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

/**
 * Like useNow, and also refreshed the moment the next agent falls asleep, so
 * a party slot or Pokédex shows SLP when the office's Pokémon lies down, not
 * up to a tick later.
 */
export function useSleepClock(intervalMs: number, enabled = true): number {
  const ticked = useNow(intervalMs, enabled);
  const [woke, setWoke] = useState(0);
  const now = Math.max(ticked, woke);
  const agents = useConductor((s) => s.agents);
  useEffect(() => {
    if (!enabled) return;
    // The next fall asleep after the time shown; one already past (the facts
    // changed under an older clock) refreshes at once.
    const at = nextSleepAt(Object.values(agents).map(sleepFactsOf), now);
    if (at === null) return;
    const timer = setTimeout(() => setWoke(Date.now()), Math.max(0, at - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [agents, now, enabled]);
  return now;
}

/** window.innerWidth, kept current on resize. */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}
