import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { AgentState } from '../src/types.js';

// Isolated HOME: the webviewReady handshake reads ~/.pixel-agents/config.json and layout.json.
let tmpBase: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { createAgentState } = await import('../src/agentState.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const { createHttpServer } = await import('../src/httpServer.js');
const { PmdCache, setPmdCache } = await import('../src/pokemon/pmdCache.js');
const { ensureSpeciesLoaded, resetLoadedSpecies, setPokemonSpritesEnabled, speciesRetryAt } =
  await import('../src/pokemon/pokemonAssets.js');
const { PMD_SPECIES_RETRY_MS } = await import('../src/pokemon/constants.js');
const { createSpeciesDelivery } = await import('../src/pokemon/speciesDelivery.js');
const { addSyntheticSpecies, FakeUpstream, FALLBACK, PRIMARY } =
  await import('./pokemonTestUtils.js');

type Store = InstanceType<typeof AgentStateStore>;
type Message = Record<string, unknown>;

let upstream: InstanceType<typeof FakeUpstream>;

function storeWithTheme(theme?: boolean): Store {
  const store = new AgentStateStore();
  store.setAdapter({
    loadAgents: () => [],
    saveAgents: () => undefined,
    loadSeats: () => ({}),
    saveSeats: () => undefined,
    getSetting: <T>(key: string, fallback: T) =>
      (key.endsWith('pokemonTheme') && theme !== undefined ? theme : fallback) as T,
    setSetting: () => undefined,
  });
  return store;
}

function addAgent(store: Store, id: number, species: number, shiny = false): AgentState {
  const agent = createAgentState({
    id,
    sessionId: `s-${id}`,
    projectDir: '',
    jsonlFile: '',
    isExternal: true,
    pokemonLine: 'test',
    species,
    shiny,
  });
  store.set(id, agent);
  return agent;
}

/** What a socket received, as `type`, `species:<dex>[s]` or `failed:<dex>[s]`. */
function labels(messages: Message[]): string[] {
  return messages.map((m) =>
    m.type === 'pokemonSpeciesLoaded'
      ? `species:${String(m.dex)}${m.shiny ? 's' : ''}`
      : m.type === 'pokemonSpeciesFailed'
        ? `failed:${String(m.dex)}${m.shiny ? 's' : ''}`
        : `${String(m.type)}${typeof m.id === 'number' ? `:${m.id}` : ''}`,
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-delivery-test-'));
  fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
  upstream = new FakeUpstream();
  for (const dex of [4, 7, 25]) addSyntheticSpecies(upstream, dex);
  addSyntheticSpecies(upstream, 25, true);
  setPmdCache(
    new PmdCache({
      root: path.join(tmpBase, 'cache'),
      fetch: upstream.fetch,
      hosts: [PRIMARY, FALLBACK],
    }),
  );
  setPokemonSpritesEnabled(true);
  resetLoadedSpecies();
});

afterEach(() => {
  setPmdCache(null);
  setPokemonSpritesEnabled(false);
  resetLoadedSpecies();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('createSpeciesDelivery', () => {
  it('sends every species in use after existingAgents, cached ones at once', async () => {
    const store = storeWithTheme();
    addAgent(store, 1, 25);
    addAgent(store, 2, 4);
    addAgent(store, 3, 25);
    await ensureSpeciesLoaded(25, false, store);
    const out: Message[] = [];
    const delivery = createSpeciesDelivery(store, (m) => out.push(m));

    delivery.send({ type: 'existingAgents', agents: [1, 2, 3] });
    expect(labels(out)).toEqual(['existingAgents', 'species:25']);
    await settle();
    expect(labels(out)).toEqual(['existingAgents', 'species:25', 'species:4']);
    expect(out[1]).toMatchObject({ type: 'pokemonSpeciesLoaded', dex: 25, name: 'Pikachu' });
  });

  it('sends a loaded species ahead of the agentCreated that introduces it', async () => {
    const store = storeWithTheme();
    await ensureSpeciesLoaded(7, false, store);
    const out: Message[] = [];
    const delivery = createSpeciesDelivery(store, (m) => out.push(m));

    addAgent(store, 1, 7);
    delivery.send({ type: 'agentCreated', id: 1 });
    expect(labels(out)).toEqual(['species:7', 'agentCreated:1']);
  });

  it('sends a species that still has to load right after it arrives', async () => {
    const store = storeWithTheme();
    const out: Message[] = [];
    const delivery = createSpeciesDelivery(store, (m) => out.push(m));

    addAgent(store, 1, 4);
    delivery.send({ type: 'agentCreated', id: 1 });
    expect(labels(out)).toEqual(['agentCreated:1']);
    await settle();
    expect(labels(out)).toEqual(['agentCreated:1', 'species:4']);
  });

  it('retries a species that failed to load for an idle agent, backing off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // Real I/O (the cache writes files) still needs the event loop to turn.
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 20_000 && !done(); i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    try {
      setPmdCache(
        new PmdCache({
          root: path.join(tmpBase, 'cache'),
          fetch: upstream.fetch,
          hosts: [PRIMARY, FALLBACK],
          failureBackoffMs: 0,
          now: () => Date.now(),
        }),
      );
      const store = storeWithTheme();
      addAgent(store, 1, 7);
      upstream.failHosts.add(PRIMARY);
      upstream.failHosts.add(FALLBACK);
      const out: Message[] = [];
      const delivery = createSpeciesDelivery(store, (m) => out.push(m));

      // Offline at startup: the idle agent's species fails (the office is told,
      // so its orb reads "Sprite unavailable") and nothing else will ever
      // ask for it again.
      delivery.send({ type: 'existingAgents', agents: [1] });
      await until(() => speciesRetryAt(7, false) !== undefined);
      await until(() => labels(out).includes('failed:7'));
      expect(labels(out)).toEqual(['existingAgents', 'failed:7']);
      expect(out[1]).toEqual({ type: 'pokemonSpeciesFailed', dex: 7, shiny: false });
      expect(speciesRetryAt(7, false)).toBe(Date.now() + PMD_SPECIES_RETRY_MS);

      // Still offline at the first retry: the wait doubles, and the office
      // isn't told again.
      const firstRetryAt = speciesRetryAt(7, false);
      await vi.advanceTimersByTimeAsync(PMD_SPECIES_RETRY_MS);
      await until(() => speciesRetryAt(7, false) !== firstRetryAt);
      expect(labels(out)).toEqual(['existingAgents', 'failed:7']);
      expect(speciesRetryAt(7, false)).toBe(Date.now() + 2 * PMD_SPECIES_RETRY_MS);

      // Back online: the next retry delivers it without any new message.
      upstream.failHosts.clear();
      await vi.advanceTimersByTimeAsync(2 * PMD_SPECIES_RETRY_MS);
      await until(() => labels(out).includes('species:7'));
      expect(labels(out)).toEqual(['existingAgents', 'failed:7', 'species:7']);
      delivery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends each dex:shiny once per connection', async () => {
    const store = storeWithTheme();
    await ensureSpeciesLoaded(25, false, store);
    await ensureSpeciesLoaded(25, true, store);
    const out: Message[] = [];
    const delivery = createSpeciesDelivery(store, (m) => out.push(m));
    addAgent(store, 1, 25);
    addAgent(store, 2, 25);
    addAgent(store, 3, 25, true);
    for (const id of [1, 2, 3]) delivery.send({ type: 'agentCreated', id });
    delivery.send({ type: 'existingAgents', agents: [1, 2, 3] });
    delivery.send({ type: 'agentDetails', id: 2, label: 'renamed' });
    expect(labels(out)).toEqual([
      'species:25',
      'agentCreated:1',
      'agentCreated:2',
      'species:25s',
      'agentCreated:3',
      'existingAgents',
      'agentDetails:2',
    ]);

    // Another connection gets its own copy.
    const other: Message[] = [];
    createSpeciesDelivery(store, (m) => other.push(m)).send({ type: 'agentCreated', id: 1 });
    expect(labels(other)).toEqual(['species:25', 'agentCreated:1']);
  });

  it('announces an evolved species before the agentDetails that shows it', async () => {
    const store = storeWithTheme();
    await ensureSpeciesLoaded(4, false, store);
    const out: Message[] = [];
    const delivery = createSpeciesDelivery(store, (m) => out.push(m));
    addAgent(store, 1, 4);
    delivery.send({ type: 'agentCreated', id: 1 });

    // The evolution path loads the next species, then broadcasts it.
    await ensureSpeciesLoaded(7, false, store);
    delivery.send({ type: 'agentDetails', id: 1, species: 7, level: 16 });
    expect(labels(out)).toEqual(['species:4', 'agentCreated:1', 'species:7', 'agentDetails:1']);
  });

  it('sends and fetches nothing with the theme off, then catches up when it is on', async () => {
    const store = storeWithTheme(true);
    const out: Message[] = [];
    const delivery = createSpeciesDelivery(store, (m) => out.push(m));
    addAgent(store, 1, 25);

    delivery.send({ type: 'settingsLoaded', pokemonTheme: false });
    delivery.send({ type: 'existingAgents', agents: [1] });
    delivery.send({ type: 'agentCreated', id: 1 });
    await settle();
    expect(labels(out)).toEqual(['settingsLoaded', 'existingAgents', 'agentCreated:1']);
    expect(upstream.calls).toHaveLength(0);

    delivery.send({ type: 'pokemonThemeUpdated', enabled: true });
    await settle();
    expect(labels(out).slice(3)).toEqual(['pokemonThemeUpdated', 'species:25']);
  });

  it('reads the theme from the adapter until the connection is told', async () => {
    const store = storeWithTheme(false);
    const out: Message[] = [];
    const delivery = createSpeciesDelivery(store, (m) => out.push(m));
    addAgent(store, 1, 25);
    delivery.send({ type: 'agentCreated', id: 1 });
    await settle();
    expect(labels(out)).toEqual(['agentCreated:1']);
    expect(upstream.calls).toHaveLength(0);
  });

  it('marks settingsLoaded with pokemonSprites: whether every agent gets a species', () => {
    const store = storeWithTheme();
    const out: Message[] = [];
    createSpeciesDelivery(store, (m) => out.push(m)).send({
      type: 'settingsLoaded',
      pokemonTheme: true,
    });
    expect(out).toEqual([{ type: 'settingsLoaded', pokemonTheme: true, pokemonSprites: true }]);

    setPokemonSpritesEnabled(false);
    const off: Message[] = [];
    createSpeciesDelivery(store, (m) => off.push(m)).send({ type: 'settingsLoaded' });
    expect(off).toEqual([{ type: 'settingsLoaded', pokemonSprites: false }]);
  });

  it('sends and fetches nothing while sprites are off', async () => {
    setPokemonSpritesEnabled(false);
    const store = storeWithTheme();
    const out: Message[] = [];
    const delivery = createSpeciesDelivery(store, (m) => out.push(m));
    addAgent(store, 1, 25);
    delivery.send({ type: 'existingAgents', agents: [1] });
    delivery.send({ type: 'agentCreated', id: 1 });
    await settle();
    expect(labels(out)).toEqual(['existingAgents', 'agentCreated:1']);
    expect(upstream.calls).toHaveLength(0);
  });

  it('drops a pending delivery when the connection closes', async () => {
    const store = storeWithTheme();
    const out: Message[] = [];
    const delivery = createSpeciesDelivery(store, (m) => out.push(m));
    addAgent(store, 1, 4);
    delivery.send({ type: 'agentCreated', id: 1 });
    delivery.dispose();
    await settle();
    expect(labels(out)).toEqual(['agentCreated:1']);
  });
});

describe('standalone /ws species delivery', () => {
  const TOKEN = 'test-token';
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function connect(port: number): Promise<{ socket: WebSocket; messages: Message[] }> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    const messages: Message[] = [];
    socket.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString()) as Message));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return { socket, messages };
  }

  async function waitFor(messages: Message[], predicate: (m: Message[]) => boolean) {
    for (let i = 0; i < 200 && !predicate(messages); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(predicate(messages)).toBe(true);
  }

  it('sends species after existingAgents and ahead of new agents, and serves the sheets', async () => {
    const store = new AgentStateStore();
    addAgent(store, 1, 25);
    await ensureSpeciesLoaded(7, false, store);
    const { app, port } = await createHttpServer({ embedded: false, token: TOKEN, store, port: 0 });
    const { socket, messages } = await connect(port);
    close = async () => {
      socket.terminate();
      await app.close();
    };

    socket.send(JSON.stringify({ type: 'webviewReady' }));
    await waitFor(messages, (m) => labels(m).includes('species:25'));
    const seen = labels(messages);
    expect(seen.indexOf('existingAgents')).toBeLessThan(seen.indexOf('species:25'));

    addAgent(store, 2, 7);
    await waitFor(messages, (m) => labels(m).includes('agentCreated:2'));
    const after = labels(messages);
    expect(after.indexOf('species:7')).toBe(after.indexOf('agentCreated:2') - 1);

    const sheet = messages.find((m) => m.type === 'pokemonSpeciesLoaded' && m.dex === 25) as {
      anims: Record<string, { url: string }>;
    };
    const res = await app.inject({ method: 'GET', url: sheet.anims.Walk.url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('leaves the embedded (VS Code) server without sprites', async () => {
    const store = new AgentStateStore();
    addAgent(store, 1, 25);
    await ensureSpeciesLoaded(25, false, store);
    const { app } = await createHttpServer({ embedded: true, token: TOKEN, store, port: 0 });
    close = () => app.close();
    const res = await app.inject({ method: 'GET', url: '/api/pokemon/0025/Walk-Anim.png' });
    expect(res.statusCode).toBe(404);
  });
});
