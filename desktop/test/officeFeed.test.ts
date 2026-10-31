import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { AgentStateStore } from '../../server/src/agentStateStore.js';
import { type StandaloneOffice, startStandalone } from '../../server/src/standalone.js';
import type { AgentState } from '../../server/src/types.js';
import {
  feedFromStore,
  type FeedSocket,
  type OfficeMessage,
  subscribeToOffice,
} from '../src/officeFeed.js';

// The office writes its token and registry entry under ~/.pixel-agents.
const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-desktop-feed-'));
process.env.HOME = home;
process.env.POKE_AGENTS_SPRITES = 'off';

after(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('feedFromStore', () => {
  it('passes the store’s events on as the office’s messages, until unsubscribed', () => {
    const store = new AgentStateStore();
    const seen: OfficeMessage[] = [];
    const unsubscribe = feedFromStore(store, (m) => seen.push(m));
    store.set(7, { id: 7, label: 'Fix login', species: 25, providerId: 'conductor' } as AgentState);
    store.broadcast({ type: 'agentStatus', id: 7, status: 'waiting', awaitingInput: true });
    store.delete(7);
    unsubscribe();
    store.broadcast({ type: 'agentStatus', id: 7, status: 'active' });

    assert.equal(seen.length, 3);
    assert.deepEqual(
      seen.map((m) => m.type),
      ['agentCreated', 'agentStatus', 'agentClosed'],
    );
    assert.equal(seen[0].label, 'Fix login');
    assert.equal(seen[0].species, 25);
  });
});

/** A socket the test drives by hand. */
class FakeSocket implements FeedSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

describe('subscribeToOffice', () => {
  function setup() {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const seen: OfficeMessage[] = [];
    let connects = 0;
    const subscription = subscribeToOffice({
      url: 'ws://127.0.0.1:41510/ws',
      listener: (m) => seen.push(m),
      onConnect: () => connects++,
      retryMs: 2_000,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => timers.splice(0),
    });
    return { subscription, sockets, timers, seen, connects: () => connects };
  }

  it('asks for the office’s state on connect and passes JSON messages on', () => {
    const { sockets, seen, connects } = setup();
    sockets[0].onopen?.();
    assert.equal(connects(), 1);
    assert.deepEqual(sockets[0].sent, [JSON.stringify({ type: 'webviewReady' })]);
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'agentClosed', id: 3 }) });
    sockets[0].onmessage?.({ data: 'not json' });
    sockets[0].onmessage?.({ data: '[1,2]' });
    sockets[0].onmessage?.({ data: new Uint8Array(2) });
    assert.deepEqual(seen, [{ type: 'agentClosed', id: 3 }]);
  });

  it('reconnects after the office drops the socket, and stops when closed', () => {
    const { subscription, sockets, timers, connects } = setup();
    sockets[0].onopen?.();
    sockets[0].onclose?.();
    assert.equal(timers.length, 1, 'one retry scheduled');
    timers.shift()?.();
    assert.equal(sockets.length, 2);
    sockets[1].onopen?.();
    assert.equal(connects(), 2);

    subscription.close();
    assert.ok(sockets[1].closed);
    sockets[1].onclose?.();
    assert.equal(timers.length, 0, 'no retry after close()');
  });

  describe('against a running office', () => {
    let office: StandaloneOffice;
    let port: number;

    before(async () => {
      port = await new Promise<number>((resolve) => {
        const probe = net.createServer().listen(0, '127.0.0.1', () => {
          const address = probe.address();
          probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
        });
      });
      office = await startStandalone({
        distRoot: path.join(__dirname, '../../dist'),
        port,
        conductor: false,
        claude: false,
      });
    });

    after(async () => {
      await office?.stop();
    });

    it('watches without the token and receives the office’s replay and broadcasts', async () => {
      const seen: OfficeMessage[] = [];
      let resolveSettings: () => void = () => undefined;
      const settings = new Promise<void>((resolve) => (resolveSettings = resolve));
      const subscription = subscribeToOffice({
        url: `ws://127.0.0.1:${port}/ws`,
        listener: (m) => {
          seen.push(m);
          if (m.type === 'settingsLoaded') resolveSettings();
        },
        retryMs: 60_000,
      });
      try {
        await settings; // the webviewReady replay reached us
        office.store.broadcast({ type: 'agentToolPermission', id: 4 });
        const deadline = Date.now() + 5_000;
        while (!seen.some((m) => m.type === 'agentToolPermission') && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(seen.some((m) => m.type === 'agentToolPermission' && m.id === 4));
        assert.ok(seen.some((m) => m.type === 'existingAgents'));
      } finally {
        subscription.close();
      }
    });
  });
});
