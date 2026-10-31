import Fastify, { type FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { CryCache } from '../src/audio/cryCache.js';
import { registerSoundRoutes } from '../src/audio/routes.js';
import { setSoundsEnabled } from '../src/audio/sounds.js';
import { parseArgs } from '../src/cli.js';
import { PmdCache } from '../src/pokemon/pmdCache.js';
import {
  loadSpecies,
  resetLoadedSpecies,
  setPokemonSpritesEnabled,
} from '../src/pokemon/pokemonAssets.js';
import { registerPokemonRoutes } from '../src/pokemon/routes.js';
import type { AgentState } from '../src/types.js';
import { privilegedHostnames } from '../src/wsAuth.js';
import {
  CRY_BASE,
  FakeCryUpstream,
  syntheticMp3,
  syntheticMp3Frame,
  syntheticOgg,
  syntheticWav,
} from './audioTestUtils.js';
import { addSyntheticSpecies, FakeUpstream, PRIMARY } from './pokemonTestUtils.js';

const HOST = '127.0.0.1:41510';
/** Caterpie: a valid dex the species catalog never assigns. */
const OFF_CATALOG_DEX = 10;

let base: string;
let packDir: string;
let cryRoot: string;
let cries: FakeCryUpstream;
let sprites: FakeUpstream;
let store: AgentStateStore;
let app: FastifyInstance;
let theme: boolean;

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-route-test-'));
  packDir = path.join(base, 'sounds');
  cryRoot = path.join(base, 'cache', 'cries');
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(path.join(base, 'cache'), { recursive: true });
  // Files beside the served directories that no request may ever reach.
  fs.writeFileSync(path.join(base, 'config.json'), '{"secret":true}');
  fs.writeFileSync(path.join(base, 'cache', 'secret.ogg'), syntheticOgg('secret'));
  cries = new FakeCryUpstream();
  cries.set('latest', 25, syntheticOgg('pika'), '"e25"');
  cries.set('latest', OFF_CATALOG_DEX, syntheticOgg('caterpie'));
  sprites = new FakeUpstream();
  addSyntheticSpecies(sprites, 25);
  theme = true;
  store = new AgentStateStore();
  store.setAdapter({
    loadAgents: () => [],
    saveAgents: () => undefined,
    loadSeats: () => ({}),
    saveSeats: () => undefined,
    getSetting: <T>(key: string, fallback: T) =>
      (key.endsWith('pokemonTheme') ? theme : fallback) as T,
    setSetting: () => undefined,
  });
  setPokemonSpritesEnabled(true);
  setSoundsEnabled(true);
  resetLoadedSpecies();
  app = Fastify();
  const allowedHostnames = privilegedHostnames('127.0.0.1', ['office.example.ts.net']);
  // Both route sets, as httpServer registers them: the cry route must not be
  // swallowed by /api/pokemon/:dex4/:file, nor shadow it.
  registerPokemonRoutes(app, {
    allowedHostnames,
    store,
    cache: new PmdCache({
      root: path.join(base, 'cache', 'pmd'),
      fetch: sprites.fetch,
      hosts: [PRIMARY],
    }),
  });
  registerSoundRoutes(app, {
    allowedHostnames,
    store,
    cryCache: new CryCache({ root: cryRoot, fetch: cries.fetch, base: CRY_BASE }),
    soundPackDir: packDir,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  setPokemonSpritesEnabled(false);
  setSoundsEnabled(true);
  cries.releaseAll();
  fs.rmSync(base, { recursive: true, force: true });
});

function get(url: string, host = HOST) {
  return app.inject({ method: 'GET', url, headers: { host } });
}

function addAgentWithSpecies(id: number, species: number): void {
  store.set(id, { id, species } as unknown as AgentState);
}

describe('GET /api/pokemon/cry/:dex4', () => {
  it('serves the cry as audio/ogg, downloading it once, with cache and nosniff headers', async () => {
    const res = await get('/api/pokemon/cry/0025');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/ogg');
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload).toEqual(syntheticOgg('pika'));
    expect(fs.existsSync(path.join(cryRoot, '0025.ogg'))).toBe(true);

    expect((await get('/api/pokemon/cry/0025')).statusCode).toBe(200);
    expect(cries.calls).toHaveLength(1);
  });

  it('serves an MP3 cry (stored under its upstream .ogg name) as audio/mpeg', async () => {
    cries.set('latest', 4, syntheticMp3Frame());
    const res = await get('/api/pokemon/cry/0004');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.rawPayload).toEqual(syntheticMp3Frame());
  });

  it('leaves the sprite route working beside it', async () => {
    const res = await get('/api/pokemon/0025/Walk-Anim.png');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(cries.calls).toHaveLength(0);
  });

  it('accepts an --allowed-host name and refuses any other Host', async () => {
    expect((await get('/api/pokemon/cry/0025', 'office.example.ts.net')).statusCode).toBe(200);
    const calls = cries.calls.length;
    const res = await get('/api/pokemon/cry/0025', 'rebound.example:41510');
    expect(res.statusCode).toBe(403);
    expect(cries.calls).toHaveLength(calls);
  });

  it('rejects traversal and malformed dex numbers without touching upstream', async () => {
    const urls = [
      '/api/pokemon/cry/..%2F..%2Fconfig.json',
      '/api/pokemon/cry/..%2Fsecret',
      '/api/pokemon/cry/0025.ogg',
      '/api/pokemon/cry/0025%00',
      '/api/pokemon/cry/25',
      '/api/pokemon/cry/0000',
      '/api/pokemon/cry/1026',
      '/api/pokemon/cry/-025',
      '/api/pokemon/cry/',
    ];
    for (const url of urls) {
      const res = await get(url);
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.body, url).not.toContain('secret');
    }
    expect(cries.calls).toHaveLength(0);
  });

  it('serves only species the catalog can assign or an agent shows', async () => {
    expect((await get(`/api/pokemon/cry/00${OFF_CATALOG_DEX}`)).statusCode).toBe(404);
    expect(cries.calls).toHaveLength(0);
    addAgentWithSpecies(1, OFF_CATALOG_DEX);
    const res = await get(`/api/pokemon/cry/00${OFF_CATALOG_DEX}`);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(syntheticOgg('caterpie'));
  });

  it('answers 404 for a cry upstream does not have', async () => {
    expect((await get('/api/pokemon/cry/0004')).statusCode).toBe(404);
  });

  it('answers 404 and fetches nothing while sounds, sprites or the theme are off', async () => {
    setSoundsEnabled(false);
    expect((await get('/api/pokemon/cry/0025')).statusCode).toBe(404);
    setSoundsEnabled(true);
    setPokemonSpritesEnabled(false);
    expect((await get('/api/pokemon/cry/0025')).statusCode).toBe(404);
    setPokemonSpritesEnabled(true);
    theme = false;
    expect((await get('/api/pokemon/cry/0025')).statusCode).toBe(404);
    expect(cries.calls).toHaveLength(0);
  });
});

describe('cry URL in the species payload', () => {
  it('carries the same-origin cry URL while sounds are on, and none while off', async () => {
    const cache = new PmdCache({
      root: path.join(base, 'cache', 'pmd'),
      fetch: sprites.fetch,
      hosts: [PRIMARY],
    });
    expect((await loadSpecies(25, false, { cache }))?.cry).toBe('/api/pokemon/cry/0025');
    setSoundsEnabled(false);
    const payload = await loadSpecies(25, false, { cache });
    expect(payload).not.toBeNull();
    expect(payload).not.toHaveProperty('cry');
  });
});

describe('sound pack routes', () => {
  it('lists the overrides present, allowlisted names only, ogg preferred', async () => {
    fs.writeFileSync(path.join(packDir, 'alert.mp3'), syntheticMp3());
    fs.writeFileSync(path.join(packDir, 'alert.ogg'), syntheticOgg('alert'));
    fs.writeFileSync(path.join(packDir, 'levelUp.wav'), syntheticWav());
    fs.writeFileSync(path.join(packDir, 'evil.ogg'), syntheticOgg());
    fs.writeFileSync(path.join(packDir, 'done.flac'), syntheticOgg());
    const res = await get('/api/sounds');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { overrides } = res.json() as {
      overrides: Array<{ event: string; format: string; size: number; version: string }>;
    };
    expect(overrides.map((o) => `${o.event}.${o.format}`)).toEqual(['alert.ogg', 'levelUp.wav']);
    expect(overrides[0].size).toBe(syntheticOgg('alert').length);
    expect(overrides[0].version).toMatch(/^\d+-\d+$/);
  });

  it('lists nothing when the folder does not exist', async () => {
    fs.rmSync(packDir, { recursive: true });
    const res = await get('/api/sounds');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ overrides: [] });
  });

  it('serves an override with its content type and nosniff', async () => {
    fs.writeFileSync(path.join(packDir, 'ballPop.mp3'), syntheticMp3());
    const res = await get('/api/sounds/ballPop');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.rawPayload).toEqual(syntheticMp3());
  });

  it('refuses a file whose bytes do not match its format, or that is too large', async () => {
    fs.writeFileSync(path.join(packDir, 'alert.ogg'), '#!/bin/sh\necho not audio\n');
    fs.writeFileSync(
      path.join(packDir, 'done.wav'),
      Buffer.concat([syntheticWav(), Buffer.alloc(2 * 1024 * 1024)]),
    );
    expect((await get('/api/sounds/alert')).statusCode).toBe(404);
    expect((await get('/api/sounds/done')).statusCode).toBe(404);
    expect((await get('/api/sounds')).json()).toEqual({ overrides: [] });
  });

  it.skipIf(process.platform === 'win32')('never follows a symlink out of the folder', async () => {
    fs.symlinkSync(path.join(base, 'cache', 'secret.ogg'), path.join(packDir, 'recall.ogg'));
    expect((await get('/api/sounds/recall')).statusCode).toBe(404);
    expect((await get('/api/sounds')).json()).toEqual({ overrides: [] });
  });

  it('rejects traversal and names off the allowlist', async () => {
    fs.writeFileSync(path.join(packDir, 'alert.ogg'), syntheticOgg());
    fs.writeFileSync(path.join(packDir, 'levelup.ogg'), syntheticOgg());
    const urls = [
      '/api/sounds/..%2F..%2Fconfig.json',
      '/api/sounds/..%2Fcache%2Fsecret',
      '/api/sounds/alert.ogg',
      '/api/sounds/Alert',
      '/api/sounds/levelup',
      '/api/sounds/constructor',
      '/api/sounds/__proto__',
      '/api/sounds/alert%00',
    ];
    for (const url of urls) {
      const res = await get(url);
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.body, url).not.toContain('secret');
    }
  });

  it('refuses any other Host and answers 404 while sounds are off', async () => {
    fs.writeFileSync(path.join(packDir, 'alert.ogg'), syntheticOgg());
    expect((await get('/api/sounds', 'rebound.example')).statusCode).toBe(403);
    expect((await get('/api/sounds/alert', 'rebound.example')).statusCode).toBe(403);
    setSoundsEnabled(false);
    expect((await get('/api/sounds')).statusCode).toBe(404);
    expect((await get('/api/sounds/alert')).statusCode).toBe(404);
  });
});

describe('--no-sounds', () => {
  it('parses the flag', () => {
    expect(parseArgs([]).sounds).toBe(true);
    expect(parseArgs(['--no-sounds']).sounds).toBe(false);
  });
});
