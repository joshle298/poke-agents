import { useEffect, useRef } from 'react';

import { conductorStore, useConductor } from '../conductor/conductorStore.js';
import { useNow } from '../conductor/hooks.js';
import { followTarget } from '../conductor/modelPicker.js';
import { FOLLOW_SESSION_WAIT_MS } from '../constants.js';

/** How often the wait for a followed session is checked against its limit. */
const FOLLOW_TICK_MS = 1_000;

/**
 * Switch model: once the new session it started walks into the office, open
 * its Pokédex (`open`), or stop waiting after FOLLOW_SESSION_WAIT_MS.
 */
export function useFollowSession(
  isInOffice: (id: number) => boolean,
  open: (id: number) => void,
): void {
  const follow = useConductor((s) => s.follow);
  const agents = useConductor((s) => s.agents);
  const now = useNow(FOLLOW_TICK_MS, follow !== null);
  const target = followTarget(follow, agents, isInOffice, now, FOLLOW_SESSION_WAIT_MS);
  const latestOpen = useRef(open);
  latestOpen.current = open;

  useEffect(() => {
    if (target === null) return;
    conductorStore.clearFollow();
    if (target !== 'expired') latestOpen.current(target);
  }, [target]);
}
