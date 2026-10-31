import { TRANSPORT_STATE_CONNECTED } from '../../../core/src/constants.js';
import type { MessageTransport } from './types.js';

/**
 * The webviewReady handshake: sent once when the office starts listening, and
 * again every time an open socket comes back after a drop (a restarted
 * server, a laptop waking, another office taking the port over), so the
 * server replays the office as it is now: agents, their state, the Conductor
 * status and the session list.
 *
 * Without the second handshake a reconnected page heard only broadcasts, and
 * the server broadcasts the Conductor status only when it changes: a page
 * that missed a change kept showing "Connecting to Conductor…" while the
 * server had long been connected with its sessions in the office.
 *
 * A socket that never opened is not a drop: the first handshake is still
 * queued in the transport and goes out when it opens. VS Code's transport
 * never drops, so it sends once. Returns the cleanup.
 */
export function startHandshake(
  transport: Pick<MessageTransport, 'send' | 'onStateChange' | 'state'>,
): () => void {
  transport.send({ type: 'webviewReady' });
  let open = transport.state === TRANSPORT_STATE_CONNECTED;
  let dropped = false;
  return transport.onStateChange((state) => {
    if (state === TRANSPORT_STATE_CONNECTED) {
      if (dropped) transport.send({ type: 'webviewReady' });
      dropped = false;
      open = true;
    } else {
      if (open) dropped = true;
      open = false;
    }
  });
}
