import { useEffect } from 'react';

import { requestSessionDetail } from '../conductor/actions.js';
import { startVisibleInterval } from '../conductor/visibleInterval.js';
import { POKEDEX_REFRESH_MS } from '../constants.js';

const documentVisibility = {
  isHidden: () => document.visibilityState === 'hidden',
  onChange: (listener: () => void) => {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};

const windowTimers = {
  setInterval: (run: () => void, ms: number) => window.setInterval(run, ms),
  clearInterval: (handle: unknown) => window.clearInterval(handle as number),
};

/**
 * While the Pokédex is open (and `enabled`): requestSessionDetail now and
 * every POKEDEX_REFRESH_MS, paused while the page is hidden. Each request
 * keeps the session in the server's Focus poll tier; closing the Pokédex or
 * hiding the window stops them, so that tier lapses.
 */
export function usePokedexRefresh(agentId: number, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    return startVisibleInterval(
      () => requestSessionDetail(agentId),
      POKEDEX_REFRESH_MS,
      documentVisibility,
      windowTimers,
    );
  }, [agentId, enabled]);
}
