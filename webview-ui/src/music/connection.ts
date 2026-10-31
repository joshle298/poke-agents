/**
 * The Jukebox and the socket: the app poll pauses while the socket is down,
 * and a drop or a return is reported so the store can react. The transport is
 * injected (only its state is read), so this runs in Node tests.
 */

import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_CONNECTING,
} from '../../../core/src/constants.js';
import type { TransportState } from '../transport/types.js';

export interface TransportStatePort {
  readonly state: TransportState;
  onStateChange(handler: (state: TransportState) => void): () => void;
}

/**
 * The socket is open, or making its first connection (what is sent now goes
 * out as it opens). While it is reconnecting the transport queues every
 * message and sends them all on reconnect, so a poll then would pile up one
 * osascript run per tick of the outage.
 */
export function canSend(state: TransportState): boolean {
  return state === TRANSPORT_STATE_CONNECTED || state === TRANSPORT_STATE_CONNECTING;
}

/** Call `refresh` now and every `intervalMs`, skipping ticks while the page
 *  is hidden or the socket is down. Returns the cleanup. */
export function pollWhileConnected(options: {
  transport: TransportStatePort;
  refresh: () => void;
  hidden: () => boolean;
  intervalMs: number;
}): () => void {
  const tick = () => {
    if (options.hidden() || !canSend(options.transport.state)) return;
    options.refresh();
  };
  tick();
  const timer = setInterval(tick, options.intervalMs);
  return () => clearInterval(timer);
}

/** Report each drop of the socket and each return after one. Returns the
 *  cleanup. */
export function watchConnection(
  transport: TransportStatePort,
  handlers: { onDrop: () => void; onReturn: () => void },
): () => void {
  let wasUp = canSend(transport.state);
  return transport.onStateChange((state) => {
    const up = canSend(state);
    if (!up && wasUp) handlers.onDrop();
    else if (up && !wasUp) handlers.onReturn();
    wasUp = up;
  });
}
