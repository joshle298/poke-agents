/**
 * Small React hooks for the Conductor chrome: a clock for time-derived text
 * (asleep slots, "synced 5s ago") and the window width that picks the party
 * bar and Pokédex layouts.
 */

import { useEffect, useState } from 'react';

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
