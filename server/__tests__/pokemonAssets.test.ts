import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { PmdCache, setPmdCache } from '../src/pokemon/pmdCache.js';
import {
  ensureSpeciesLoaded,
  getLoadedSpecies,
  loadSpecies,
  resetLoadedSpecies,
  setPokemonSpritesEnabled,
} from '../src/pokemon/pokemonAssets.js';
import {
  addSyntheticSpecies,
  FakeUpstream,
  FALLBACK,
  PRIMARY,
  solidPng,
} from './pokemonTestUtils.js';

let root: string;
let upstream: FakeUpstream;
let cache: PmdCache;

function storeWithTheme(theme: boolean | undefined): AgentStateStore {
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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-assets-test-'));
  upstream = new FakeUpstream();
  cache = new PmdCache({ root, fetch: upstream.fetch, hosts: [PRIMARY, FALLBACK] });
  setPmdCache(cache);
  setPokemonSpritesEnabled(true);
  resetLoadedSpecies();
});

afterEach(() => {
  setPmdCache(null);
  setPokemonSpritesEnabled(false);
  resetLoadedSpecies();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('loadSpecies', () => {
  it('builds the payload from the cached sheets, portraits and credits', async () => {
    addSyntheticSpecies(upstream, 25);
    const payload = await loadSpecies(25, false);

    expect(payload).not.toBeNull();
    expect(payload!.dex).toBe(25);
    expect(payload!.shiny).toBe(false);
    expect(payload!.name).toBe('Pikachu');
    expect(payload!.shadowSize).toBe(1);
    expect(payload!.anims.Walk).toEqual({
      url: '/api/pokemon/0025/Walk-Anim.png',
      frameWidth: 32,
      frameHeight: 40,
      frames: 4,
      directions: 8,
      durations: [8, 10, 8, 10],
    });
    expect(payload!.anims.Sleep).toMatchObject({ directions: 1, frames: 2 });
    // CopyOf resolves to the target's sheet and timing.
    expect(payload!.anims.Shoot).toMatchObject({
      url: '/api/pokemon/0025/Charge-Anim.png',
      frameWidth: 40,
      durations: [2, 2, 2],
    });
    // Attack's sheet doesn't match its AnimData: skipped, not trusted.
    expect(payload!.anims.Attack).toBeUndefined();
    expect(Object.keys(payload!.anims).sort()).toEqual([
      'Charge',
      'Hop',
      'Idle',
      'Shoot',
      'Sleep',
      'Walk',
    ]);
    expect(payload!.portraits).toEqual({
      Normal: '/api/pokemon/0025/portrait/Normal.png',
      Happy: '/api/pokemon/0025/portrait/Happy.png',
      Worried: '/api/pokemon/0025/portrait/Worried.png',
    });
    expect(payload!.credits).toEqual({
      sprite: ['Alice Example', 'CHUNSOFT'],
      portrait: ['anonymous contributor'],
      pageUrl: 'https://sprites.pmdcollab.org/#/0025',
    });
  });

  it('requests only declared anims and the emotions credits.txt lists', async () => {
    addSyntheticSpecies(upstream, 25);
    await loadSpecies(25, false);
    const requested = upstream.calls.map((c) => c.url.slice(PRIMARY.length + 1));
    expect(requested).not.toContain('sprite/0025/Hurt-Anim.png');
    expect(requested).not.toContain('sprite/0025/Shoot-Anim.png');
    expect(requested).not.toContain('portrait/0025/Determined.png');
    expect(requested.filter((r) => r === 'sprite/0025/Charge-Anim.png')).toHaveLength(1);
    expect(requested.some((r) => r.endsWith('-Shadow.png') || r.endsWith('-Offsets.png'))).toBe(
      false,
    );
  });

  it('carries marker frames for a valid sheet', async () => {
    addSyntheticSpecies(upstream, 25);
    upstream.set('sprite/0025/Attack-Anim.png', solidPng(80 * 3, 80 * 8));
    const payload = await loadSpecies(25, false);
    expect(payload!.anims.Attack).toMatchObject({ frames: 3, hitFrame: 1 });
    expect(payload!.anims.Attack.rushFrame).toBeUndefined();
  });

  it('uses the shiny sheets, falling back to base portraits and credits', async () => {
    addSyntheticSpecies(upstream, 25);
    addSyntheticSpecies(upstream, 25, true);
    for (const key of [...upstream.files.keys()]) {
      if (
        key.startsWith('portrait/0025/0000/0001/') ||
        key === 'sprite/0025/0000/0001/credits.txt'
      ) {
        upstream.files.delete(key);
      }
    }
    const payload = await loadSpecies(25, true, { urlBase: '/sprites' });
    expect(payload!.shiny).toBe(true);
    expect(payload!.anims.Walk.url).toBe('/sprites/0025/shiny/Walk-Anim.png');
    expect(payload!.portraits.Normal).toBe('/sprites/0025/portrait/Normal.png');
    expect(payload!.credits.sprite).toEqual(['Alice Example', 'CHUNSOFT']);
  });

  it('uses shiny portraits when the shiny form has them', async () => {
    addSyntheticSpecies(upstream, 25, true);
    addSyntheticSpecies(upstream, 25);
    const payload = await loadSpecies(25, true);
    expect(payload!.portraits.Normal).toBe('/api/pokemon/0025/shiny/portrait/Normal.png');
  });

  it('returns null without Walk, Idle or the Normal portrait', async () => {
    addSyntheticSpecies(upstream, 4);
    upstream.files.delete('sprite/0004/Idle-Anim.png');
    expect(await loadSpecies(4, false)).toBeNull();

    addSyntheticSpecies(upstream, 7);
    upstream.files.delete('portrait/0007/Normal.png');
    expect(await loadSpecies(7, false)).toBeNull();

    expect(await loadSpecies(1, false)).toBeNull();
  });

  it('fetches nothing while sprites are off', async () => {
    addSyntheticSpecies(upstream, 25);
    setPokemonSpritesEnabled(false);
    expect(await loadSpecies(25, false)).toBeNull();
    expect(upstream.calls).toHaveLength(0);
  });

  it('refuses an invalid dex', async () => {
    expect(await loadSpecies(0, false)).toBeNull();
    expect(await loadSpecies(1026, false)).toBeNull();
    expect(upstream.calls).toHaveLength(0);
  });
});

describe('ensureSpeciesLoaded', () => {
  it('loads a species once per process and remembers it', async () => {
    addSyntheticSpecies(upstream, 25);
    const store = storeWithTheme(undefined);
    expect(getLoadedSpecies(25, false)).toBeUndefined();
    const [a, b] = await Promise.all([
      ensureSpeciesLoaded(25, false, store),
      ensureSpeciesLoaded(25, false, store),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(getLoadedSpecies(25, false)?.name).toBe('Pikachu');
    expect(getLoadedSpecies(25, true)).toBeUndefined();

    const calls = upstream.calls.length;
    expect(await ensureSpeciesLoaded(25, false, store)).toBe(true);
    expect(upstream.calls).toHaveLength(calls);
  });

  it('fetches nothing while the theme is off', async () => {
    addSyntheticSpecies(upstream, 25);
    expect(await ensureSpeciesLoaded(25, false, storeWithTheme(false))).toBe(false);
    expect(upstream.calls).toHaveLength(0);
  });

  it('does not retry a failed species straight away', async () => {
    const store = storeWithTheme(true);
    expect(await ensureSpeciesLoaded(25, false, store)).toBe(false);
    const calls = upstream.calls.length;
    addSyntheticSpecies(upstream, 25);
    expect(await ensureSpeciesLoaded(25, false, store)).toBe(false);
    expect(upstream.calls).toHaveLength(calls);
  });
});
