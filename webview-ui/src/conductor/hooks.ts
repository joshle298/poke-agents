/**
 * Small React hooks for the Conductor chrome: a clock for time-derived text
 * (asleep slots, "synced 5s ago") and the window width that picks the party
 * bar and Pokédex layouts.
 */

import { useEffect, useState } from 'react';

import { useConductor } from './conductorStore.js';
import { nextAgentSleepAt } from './party.js';

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
 * Like useNow, and also refreshed the moment the next agent falls asleep
 * (only `agentId`, when given), so a party slot or the Pokédex shows SLP when
 * the office's Pokémon lies down, not up to a tick later. It subscribes to
 * that moment alone, a number: other store changes re-render nothing here.
 */
export function useSleepClock(intervalMs: number, enabled = true, agentId?: number): number {
  const ticked = useNow(intervalMs, enabled);
  const [woke, setWoke] = useState(0);
  const now = Math.max(ticked, woke);
  const at = useConductor((s) => (enabled ? nextAgentSleepAt(s, now, agentId) : null));
  useEffect(() => {
    if (at === null) return;
    // One already past (the facts changed under an older clock) refreshes at once.
    const timer = setTimeout(() => setWoke(Date.now()), Math.max(0, at - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [at, now]);
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
