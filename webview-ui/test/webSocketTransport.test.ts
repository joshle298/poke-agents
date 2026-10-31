/**
 * The standalone socket stops reconnecting when the server refuses the page's
 * address (a DNS name it doesn't allow), and keeps reconnecting after any
 * other close.
 *
 * Run with: npm test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { refusedHostMessage, WebSocketTransport } from '../src/transport/webSocketTransport.js';

class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(): void {}
  close(): void {}
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WebSocketTransport', () => {
  it('stays disconnected after a "forbidden host" close instead of retrying', () => {
    const transport = new WebSocketTransport('ws://my-mac.local:41510/ws');
    const states: string[] = [];
    transport.onStateChange((s) => states.push(s));
    transport.connect();
    FakeSocket.instances[0].onclose?.({ code: 4003, reason: 'forbidden host' });

    expect(transport.refusedHost).toBe(true);
    expect(transport.state).toBe('disconnected');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(states).toEqual(['disconnected']);
    transport.dispose();
  });

  it('reconnects after any other close, including a forbidden origin', () => {
    const transport = new WebSocketTransport('ws://127.0.0.1:41510/ws');
    transport.connect();
    FakeSocket.instances[0].onclose?.({ code: 4003, reason: 'forbidden origin' });
    expect(transport.refusedHost).toBe(false);
    expect(transport.state).toBe('reconnecting');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
    transport.dispose();
  });

  it('names the flag and the address in the message', () => {
    expect(refusedHostMessage('my-mac.local')).toBe(
      "This address isn't allowed. Restart poke-agents with --allowed-host my-mac.local.",
    );
  });
});
