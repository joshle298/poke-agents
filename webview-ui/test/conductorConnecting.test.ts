/**
 * The empty office's "Connecting to Conductor…" card follows the server's
 * newest state: after the socket drops and comes back, the office sends
 * webviewReady again and the server's replay replaces a stale "connecting"
 * (the server broadcasts its status only when it changes, so a page that
 * missed the change kept the card while the server showed 43 sessions). The
 * card counts the seconds, says "Still connecting…" after 20 s, and never
 * shows once the server reports connected or sessions are present.
 *
 * Run with: npm test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConductorStatus, ServerMessage } from '../../core/src/messages.js';
import { ConductorStore } from '../src/conductor/conductorStore.js';
import { emptyOfficeCard, type EmptyOfficeInput } from '../src/conductor/emptyOffice.js';
import { elapsedText } from '../src/conductor/format.js';
import { CONDUCTOR_CONNECTED_NOTICE_MS, CONDUCTOR_SLOW_CONNECT_MS } from '../src/constants.js';
import { startHandshake } from '../src/transport/handshake.js';
import { WebSocketTransport } from '../src/transport/webSocketTransport.js';

const SCOPE = { creator: 'me', activeWithinHours: 6, showIdle: true, maxSessions: 48 } as const;

function status(patch: Partial<ConductorStatus>): ConductorStatus {
  return { type: 'conductorStatus', state: 'connecting', scope: SCOPE, ...patch };
}

class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  /** The server's answer to a webviewReady on this socket (its replay). */
  static onHandshake: ((socket: FakeSocket) => void) | null = null;
  readyState = 0;
  sent: Array<{ type: string }> = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    const msg = JSON.parse(data) as { type: string };
    this.sent.push(msg);
    if (msg.type === 'webviewReady') FakeSocket.onHandshake?.(this);
  }
  close(): void {}

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '' });
  }
  receive(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const latestSocket = () => FakeSocket.instances[FakeSocket.instances.length - 1];
const handshakes = () =>
  FakeSocket.instances.flatMap((s) => s.sent).filter((m) => m.type === 'webviewReady').length;

describe('the handshake after a reconnect', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    FakeSocket.onHandshake = null;
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('replaces a stale "connecting" with the server\'s replay (the stale card)', () => {
    // The server: its newest Conductor status and agents, replayed on every
    // handshake. Broadcasts reach only the sockets open at the time.
    let serverStatus = status({ state: 'connecting' });
    const serverAgents: number[] = [];
    FakeSocket.onHandshake = (socket) => {
      socket.receive({
        type: 'existingAgents',
        agents: serverAgents,
        agentMeta: {},
        directoryNames: {},
        externalAgents: {},
      });
      socket.receive(serverStatus);
    };

    let clock = 1_000_000;
    const store = new ConductorStore({ now: () => clock });
    const transport = new WebSocketTransport('ws://127.0.0.1:41510/ws');
    transport.onMessage((msg) => store.apply(msg));
    const stop = startHandshake(transport);
    transport.connect();
    latestSocket().open();
    const card = () =>
      emptyOfficeCard({
        status: store.getState().status,
        signIn: store.getState().signIn,
        connectingSince: store.getState().connectingSince,
        agentCount: store.getState().agentIds.length,
        transportState: transport.state,
        now: clock,
      });
    expect(handshakes()).toBe(1);
    expect(card()?.kind).toBe('connecting');

    // The socket drops. Meanwhile the server connects and adopts sessions,
    // broadcasting both to nobody, and then sends no status until one changes.
    latestSocket().drop();
    serverStatus = status({ state: 'connected', visibleCount: 43, sessionCount: 60 });
    serverAgents.push(7, 8, 9);
    clock += 30_000;
    expect(card()?.kind).toBe('reconnecting');
    vi.advanceTimersByTime(250);
    latestSocket().open();

    // Back: the office asks again, and the replay is the truth.
    expect(handshakes()).toBe(2);
    expect(store.getState().status?.state).toBe('connected');
    expect(store.getState().agentIds).toEqual([7, 8, 9]);
    expect(card()).toBeNull();
    stop();
    transport.dispose();
  });

  it('sends once when the first connect only opens on a retry', () => {
    const transport = new WebSocketTransport('ws://127.0.0.1:41510/ws');
    const stop = startHandshake(transport);
    transport.connect();
    latestSocket().drop();
    vi.advanceTimersByTime(250);
    latestSocket().open();
    // The first handshake was queued and goes out as the socket opens.
    expect(handshakes()).toBe(1);
    latestSocket().drop();
    vi.advanceTimersByTime(250);
    latestSocket().open();
    expect(handshakes()).toBe(2);
    stop();
    transport.dispose();
  });

  it('stops asking once cleaned up', () => {
    const transport = new WebSocketTransport('ws://127.0.0.1:41510/ws');
    const stop = startHandshake(transport);
    transport.connect();
    latestSocket().open();
    stop();
    latestSocket().drop();
    vi.advanceTimersByTime(250);
    latestSocket().open();
    expect(handshakes()).toBe(1);
    transport.dispose();
  });
});

describe('emptyOfficeCard', () => {
  const base: EmptyOfficeInput = {
    status: null,
    signIn: null,
    connectingSince: 1_000,
    agentCount: 0,
    transportState: 'connected',
    now: 1_000,
  };
  const card = (patch: Partial<EmptyOfficeInput>) => emptyOfficeCard({ ...base, ...patch });

  it('counts the seconds while connecting, and says "Still connecting" after 20 s', () => {
    expect(card({ now: 9_000 })).toEqual({ kind: 'connecting', elapsedMs: 8_000, slow: false });
    expect(card({ status: status({}), now: 1_000 + CONDUCTOR_SLOW_CONNECT_MS })).toEqual({
      kind: 'connecting',
      elapsedMs: CONDUCTOR_SLOW_CONNECT_MS,
      slow: true,
    });
  });

  it('never says connecting once the server reported connected', () => {
    expect(card({ status: status({ state: 'connected' }) })).toEqual({ kind: 'noSessions' });
    expect(card({ status: status({ state: 'unreachable' }) })).toEqual({ kind: 'problem' });
    expect(card({ status: status({ state: 'rateLimited' }) })).toEqual({ kind: 'problem' });
  });

  it('shows nothing once sessions are present, whatever the status says', () => {
    expect(card({ agentCount: 3 })).toBeNull();
    expect(card({ status: status({ state: 'connected', visibleCount: 43 }) })).toBeNull();
    expect(card({ status: status({ state: 'connecting', visibleCount: 2 }) })).toBeNull();
    expect(card({ status: status({ state: 'connected', visibleCount: 0 }) })?.kind).toBe(
      'noSessions',
    );
  });

  it("doesn't repeat a status it may have missed changes to while its socket is down", () => {
    expect(card({ transportState: 'reconnecting' })).toEqual({ kind: 'reconnecting' });
    expect(card({ transportState: 'disconnected' })).toEqual({ kind: 'reconnecting' });
    // The first connect of the page still counts as connecting.
    expect(card({ transportState: 'connecting' })?.kind).toBe('connecting');
  });

  it('shows the Connect card when signed out, and "Connected as" right after a connect', () => {
    expect(card({ status: status({ state: 'authRequired' }) })).toEqual({ kind: 'signIn' });
    expect(card({ status: status({ state: 'unauthorized' }) })).toEqual({ kind: 'signIn' });
    const signIn = {
      action: 'connect' as const,
      ok: true,
      message: 'Connected as a@b.c',
      at: 1_000,
      seq: 1,
    };
    expect(card({ status: status({}), signIn })).toEqual({
      kind: 'justConnected',
      headline: 'Connected as a@b.c',
    });
    expect(
      card({ status: status({}), signIn, now: 1_000 + CONDUCTOR_CONNECTED_NOTICE_MS })?.kind,
    ).toBe('connecting');
  });
});

describe('connectingSince', () => {
  it('counts from page load, keeps counting through connecting, and stops at any other state', () => {
    let clock = 5_000;
    const store = new ConductorStore({ now: () => clock });
    expect(store.getState().connectingSince).toBe(5_000);
    clock = 7_000;
    store.apply(status({ state: 'connecting' }));
    expect(store.getState().connectingSince).toBe(5_000);
    store.apply(status({ state: 'connected' }));
    expect(store.getState().connectingSince).toBeNull();
    // A reconnect (Reconnect in the Mac app, a new key) starts a new count.
    clock = 60_000;
    store.apply(status({ state: 'connecting' }));
    expect(store.getState().connectingSince).toBe(60_000);
    store.apply(status({ state: 'authRequired' }));
    expect(store.getState().connectingSince).toBeNull();
  });
});

describe('elapsedText', () => {
  it('reads seconds, then minutes and seconds, then minutes', () => {
    expect(elapsedText(-5)).toBe('0 s');
    expect(elapsedText(8_400)).toBe('8 s');
    expect(elapsedText(60_000)).toBe('1 min');
    expect(elapsedText(65_000)).toBe('1 min 5 s');
    expect(elapsedText(12 * 60_000 + 30_000)).toBe('12 min');
  });
});
