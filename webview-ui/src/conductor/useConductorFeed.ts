import { useEffect } from 'react';

import { transport } from '../transport/index.js';
import { conductorStore } from './conductorStore.js';

/**
 * Pipe every ServerMessage into the Conductor store. Call it in App BEFORE
 * useExtensionMessages: effects run in call order, so this listener is
 * registered before that hook sends webviewReady and cannot miss the
 * handshake's replies.
 */
export function useConductorFeed(): void {
  useEffect(() => transport.onMessage((msg) => conductorStore.apply(msg)), []);
}
