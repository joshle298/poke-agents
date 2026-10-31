import Fastify, { type FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { PmdCache } from '../src/pokemon/pmdCache.js';
import { resetLoadedSpecies, setPokemonSpritesEnabled } from '../src/pokemon/pokemonAssets.js';
import { registerPokemonRoutes } from '../src/pokemon/routes.js';
import { privilegedHostnames } from '../src/wsAuth.js';
import { addSyntheticSpecies, FakeUpstream, FALLBACK, PRIMARY } from './pokemonTestUtils.js';

const HOST = '127.0.0.1:3100';

let base: string;
let root: string;
let upstream: FakeUpstream;
let app: FastifyInstance;
let theme: boolean;

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-route-test-'));
  root = path.join(base, 'cache');
  // A file beside the cache that no request may ever reach.
  fs.writeFileSync(path.join(base, 'config.json'), '{"secret":true}');
  upstream = new FakeUpstream();
  addSyntheticSpecies(upstream, 25);
  addSyntheticSpecies(upstream, 25, true);
  theme = true;
  const store = new AgentStateStore();
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
  resetLoadedSpecies();
  app = Fastify();
  registerPokemonRoutes(app, {
    allowedHostnames: privilegedHostnames('127.0.0.1', ['office.example.ts.net']),
    store,
    cache: new PmdCache({ root, fetch: upstream.fetch, hosts: [PRIMARY, FALLBACK] }),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  setPokemonSpritesEnabled(false);
  fs.rmSync(base, { recursive: true, force: true });
});

function get(url: string, host = HOST) {
  return app.inject({ method: 'GET', url, headers: { host } });
}

describe('GET /api/pokemon', () => {
  it('serves a sheet, downloading it on a miss, with cache and nosniff headers', async () => {
    const res = await get('/api/pokemon/0025/Walk-Anim.png');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload).toEqual(upstream.files.get('sprite/0025/Walk-Anim.png')!.body);
    expect(fs.existsSync(path.join(root, 'sprite', '0025', 'Walk-Anim.png'))).toBe(true);

    // Served from the cache the second time.
    const calls = upstream.calls.length;
    expect((await get('/api/pokemon/0025/Walk-Anim.png')).statusCode).toBe(200);
    expect(upstream.calls).toHaveLength(calls);
  });

  it('serves portraits and the shiny variants', async () => {
    const portrait = await get('/api/pokemon/0025/portrait/Normal.png');
    expect(portrait.statusCode).toBe(200);
    expect(portrait.rawPayload).toEqual(upstream.files.get('portrait/0025/Normal.png')!.body);

    expect((await get('/api/pokemon/0025/shiny/Idle-Anim.png')).statusCode).toBe(200);
    expect(fs.existsSync(path.join(root, 'sprite', '0025', '0000', '0001', 'Idle-Anim.png'))).toBe(
      true,
    );
    expect((await get('/api/pokemon/0025/shiny/portrait/Happy.png')).statusCode).toBe(200);
  });

  it('accepts an --allowed-host name and refuses any other Host', async () => {
    expect((await get('/api/pokemon/0025/Walk-Anim.png', 'office.example.ts.net')).statusCode).toBe(
      200,
    );
    const calls = upstream.calls.length;
    const res = await get('/api/pokemon/0025/Idle-Anim.png', 'rebound.example:3100');
    expect(res.statusCode).toBe(403);
    expect(upstream.calls).toHaveLength(calls);
  });

  it('rejects traversal and anything off the allowlist without leaving the cache', async () => {
    const urls = [
      '/api/pokemon/0025/..%2F..%2Fconfig.json',
      '/api/pokemon/0025/..%2F..%2F..%2Fconfig.json',
      '/api/pokemon/0025/portrait/..%2F..%2F..%2Fconfig.json',
      '/api/pokemon/..%2F..%2F/Walk-Anim.png',
      '/api/pokemon/0025/..%2FWalk-Anim.png',
      '/api/pokemon/0025/Walk-Anim.png%00.json',
      '/api/pokemon/0025/AnimData.xml',
      '/api/pokemon/0025/credits.txt',
      '/api/pokemon/0025/Walk-Shadow.png',
      '/api/pokemon/0025/walk-Anim.png',
      '/api/pokemon/0025/portrait/Angry.png',
      '/api/pokemon/0025/portrait/credits.txt',
      '/api/pokemon/0025/shiny/..%2F..%2Fcredits.txt',
      '/api/pokemon/25/Walk-Anim.png',
      '/api/pokemon/1026/Walk-Anim.png',
      '/api/pokemon/0000/Walk-Anim.png',
    ];
    for (const url of urls) {
      const res = await get(url);
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.body, url).not.toContain('secret');
    }
    // Only AnimData.xml was looked up (to check declared anims); no file off the allowlist.
    const fetched = new Set(upstream.calls.map((c) => c.url.slice(PRIMARY.length + 1)));
    expect([...fetched].every((p) => p.endsWith('/AnimData.xml'))).toBe(true);
  });

  it('serves only anims the species declares', async () => {
    const res = await get('/api/pokemon/0025/Hurt-Anim.png');
    expect(res.statusCode).toBe(404);
    expect(upstream.callsFor('sprite/0025/Hurt-Anim.png')).toHaveLength(0);
    // Shoot is a CopyOf alias: it has no sheet of its own to serve.
    expect((await get('/api/pokemon/0025/Shoot-Anim.png')).statusCode).toBe(404);
  });

  it('answers 404 for files upstream does not have', async () => {
    expect((await get('/api/pokemon/0004/Walk-Anim.png')).statusCode).toBe(404);
    expect((await get('/api/pokemon/0025/portrait/Sigh.png')).statusCode).toBe(404);
  });

  it('answers 404 and fetches nothing while sprites or the theme are off', async () => {
    setPokemonSpritesEnabled(false);
    expect((await get('/api/pokemon/0025/Walk-Anim.png')).statusCode).toBe(404);
    setPokemonSpritesEnabled(true);
    theme = false;
    expect((await get('/api/pokemon/0025/Walk-Anim.png')).statusCode).toBe(404);
    expect(upstream.calls).toHaveLength(0);
  });
});
