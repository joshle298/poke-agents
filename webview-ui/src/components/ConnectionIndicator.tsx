import { useEffect, useState } from 'react';

import { transport } from '../transport/index.js';
import type { TransportState } from '../transport/types.js';
import { refusedHostMessage, WebSocketTransport } from '../transport/webSocketTransport.js';

const STATE_LABELS: Partial<Record<TransportState, string>> = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
};

/**
 * Standalone connection status badge. Renders nothing while connected (the happy
 * path, and always in VS Code where the transport is permanently connected), so
 * it is invisible unless the WebSocket drops in standalone mode. A pill with no
 * position of its own: the office stacks it with the other top-centre pills
 * (OfficeTopBar on desktop, the top of the office page on a phone).
 */
export function ConnectionIndicator() {
  const [state, setState] = useState<TransportState>(transport.state);

  useEffect(() => {
    // Re-read on mount in case the state changed before this subscribed.
    setState(transport.state);
    return transport.onStateChange(setState);
  }, []);

  if (state === 'connected') return null;

  const refused = transport instanceof WebSocketTransport && transport.refusedHost;
  const label = refused
    ? refusedHostMessage(window.location.hostname)
    : (STATE_LABELS[state] ?? 'Disconnected');
  const dotClass = state === 'connecting' ? 'bg-status-permission' : 'bg-status-error';

  return (
    <div className="pixel-panel py-6 px-12 flex items-center gap-8 text-sm">
      <span
        className={`w-8 h-8 rounded-full inline-block shrink-0 ${dotClass} ${refused ? '' : 'pixel-pulse'}`}
      />
      {label}
    </div>
  );
}
