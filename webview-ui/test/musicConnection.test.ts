import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pollWhileConnected, watchConnection } from '../src/music/connection.js';
import { MUSIC_APP_POLL_MS } from '../src/music/constants.js';
import type { TransportState } from '../src/transport/types.js';

/** A transport that only has a state, changed by the test. */
function fakeTransport(initial: TransportState) {
  const handlers = new Set<(state: TransportState) => void>();
  const port = {
    state: initial,
    onStateChange(handler: (state: TransportState) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    set(state: TransportState) {
      port.state = state;
      for (const handler of handlers) handler(state);
    },
  };
  return port;
}

describe('pollWhileConnected', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks at once and on every tick while the socket is up', () => {
    const transport = fakeTransport('connected');
    const refresh = vi.fn();
    const stop = pollWhileConnected({
      transport,
      refresh,
      hidden: () => false,
      intervalMs: MUSIC_APP_POLL_MS,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(MUSIC_APP_POLL_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(4);
    stop();
    vi.advanceTimersByTime(MUSIC_APP_POLL_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it('sends nothing during an outage, so nothing piles up for the reconnect', () => {
    const transport = fakeTransport('connected');
    const refresh = vi.fn();
    pollWhileConnected({ transport, refresh, hidden: () => false, intervalMs: MUSIC_APP_POLL_MS });
    transport.set('reconnecting');
    vi.advanceTimersByTime(10 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    transport.set('connected');
    vi.advanceTimersByTime(MUSIC_APP_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('skips ticks while the page is hidden', () => {
    const transport = fakeTransport('connected');
    const refresh = vi.fn();
    let hidden = true;
    pollWhileConnected({ transport, refresh, hidden: () => hidden, intervalMs: MUSIC_APP_POLL_MS });
    vi.advanceTimersByTime(MUSIC_APP_POLL_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
    hidden = false;
    vi.advanceTimersByTime(MUSIC_APP_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('watchConnection', () => {
  it('reports each drop and each return after one', () => {
    const transport = fakeTransport('connecting');
    const onDrop = vi.fn();
    const onReturn = vi.fn();
    watchConnection(transport, { onDrop, onReturn });

    // The first connection is not a return.
    transport.set('connected');
    expect(onReturn).not.toHaveBeenCalled();
    transport.set('reconnecting');
    transport.set('reconnecting');
    expect(onDrop).toHaveBeenCalledTimes(1);
    transport.set('connected');
    expect(onReturn).toHaveBeenCalledTimes(1);
    transport.set('disconnected');
    expect(onDrop).toHaveBeenCalledTimes(2);
  });
});
