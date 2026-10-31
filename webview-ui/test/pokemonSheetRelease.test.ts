/**
 * Decoded Pokémon sheets are released once no character has used their
 * species for a while (ImageBitmap.close), kept as metadata for credits and
 * portraits, and decoded again when a character uses the species. Synthetic
 * species and a fake loader; no DOM, no art.
 *
 * Run with: npm test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POKEMON_SHEET_RELEASE_AFTER_MS, POKEMON_SHEET_SWEEP_SEC } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { setPokemonThemeEnabled } from '../src/office/engine/pokemonTheme.js';
import {
  getPokemonSpeciesInfo,
  isPokemonReady,
  listPokemonSpecies,
  setPokemonSpecies,
  sweepPokemonSheets,
} from '../src/office/sprites/pokemonSprites.js';
import {
  DEFAULT_ANIMS,
  floorLayout,
  flushDecodes,
  installFakeLoader,
  resetPokemonStore,
  speciesMessage,
} from './pokemonFixtures.js';

const ANIM_COUNT = Object.keys(DEFAULT_ANIMS).length;

beforeEach(() => {
  resetPokemonStore();
  setPokemonThemeEnabled(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPokemonStore();
  setPokemonThemeEnabled(true);
});

async function loadSpecies(...dexes: number[]) {
  const msgs = dexes.map((dex) => speciesMessage(dex));
  const loader = installFakeLoader(msgs);
  for (const msg of msgs) setPokemonSpecies(msg);
  await flushDecodes();
  return loader;
}

describe('Pokémon sheet release', () => {
  it('closes the sheets of a species nobody has used for the grace period', async () => {
    const { closed } = await loadSpecies(25, 4);
    const os = new OfficeState(floorLayout());
    os.addAgent(1, 0, 0, undefined, true);
    os.setAgentIdentity(1, { species: 25 });

    os.sweepPokemonSheets(0);
    os.sweepPokemonSheets(POKEMON_SHEET_RELEASE_AFTER_MS - 1);
    expect(closed).toEqual([]);
    expect(isPokemonReady(4, false)).toBe(true);

    os.sweepPokemonSheets(POKEMON_SHEET_RELEASE_AFTER_MS);
    expect(closed).toHaveLength(ANIM_COUNT);
    expect(closed.every((url) => url.includes('4-n-'))).toBe(true);
    expect(isPokemonReady(4, false)).toBe(false);
    // Metadata stays: credits list it, portraits keep their URL.
    expect(getPokemonSpeciesInfo(4, false)?.name).toBe('Mon4');
    expect(listPokemonSpecies().map((s) => s.dex)).toContain(4);
    // The species in use is untouched.
    expect(isPokemonReady(25, false)).toBe(true);
  });

  it('decodes a released species again when a character uses it', async () => {
    const { loads } = await loadSpecies(4);
    const os = new OfficeState(floorLayout());
    os.sweepPokemonSheets(0);
    os.sweepPokemonSheets(POKEMON_SHEET_RELEASE_AFTER_MS);
    expect(isPokemonReady(4, false)).toBe(false);

    const before = loads.length;
    os.addAgent(2, 0, 0, undefined, true);
    os.setAgentIdentity(2, { species: 4 });
    await flushDecodes();
    expect(loads.length - before).toBe(ANIM_COUNT);
    expect(isPokemonReady(4, false)).toBe(true);
  });

  it('a character using the species resets its clock', async () => {
    const { closed } = await loadSpecies(4);
    const os = new OfficeState(floorLayout());
    os.sweepPokemonSheets(0);
    os.addAgent(3, 0, 0, undefined, true);
    os.setAgentIdentity(3, { species: 4 });
    os.sweepPokemonSheets(POKEMON_SHEET_RELEASE_AFTER_MS / 2);
    os.removeAgent(3);
    os.update(5); // the recall finishes
    // Unused again from here: the grace period starts over.
    os.sweepPokemonSheets(POKEMON_SHEET_RELEASE_AFTER_MS);
    os.sweepPokemonSheets(POKEMON_SHEET_RELEASE_AFTER_MS * 2 - 1);
    expect(closed).toEqual([]);
    os.sweepPokemonSheets(POKEMON_SHEET_RELEASE_AFTER_MS * 2);
    expect(closed).toHaveLength(ANIM_COUNT);
  });

  it('theme off releases everything after the grace period; theme on decodes what is used', async () => {
    await loadSpecies(25);
    const os = new OfficeState(floorLayout());
    os.addAgent(1, 0, 0, undefined, true);
    os.setAgentIdentity(1, { species: 25 });
    setPokemonThemeEnabled(false);
    os.sweepPokemonSheets(0);
    os.sweepPokemonSheets(POKEMON_SHEET_RELEASE_AFTER_MS);
    expect(isPokemonReady(25, false)).toBe(false);

    setPokemonThemeEnabled(true);
    os.sweepPokemonSheets(POKEMON_SHEET_RELEASE_AFTER_MS + 1);
    await flushDecodes();
    expect(isPokemonReady(25, false)).toBe(true);
  });

  it('a sheet that finishes decoding after its release is closed, not kept', async () => {
    const msg = speciesMessage(7);
    const { closed } = installFakeLoader([msg]);
    setPokemonSpecies(msg); // decodes now in flight
    sweepPokemonSheets(new Set(), 0);
    sweepPokemonSheets(new Set(), POKEMON_SHEET_RELEASE_AFTER_MS);
    await flushDecodes();
    expect(closed).toHaveLength(ANIM_COUNT);
    expect(isPokemonReady(7, false)).toBe(false);
  });

  it('update() sweeps on its own every POKEMON_SHEET_SWEEP_SEC', async () => {
    await loadSpecies(4);
    const os = new OfficeState(floorLayout());
    const sweep = vi.spyOn(os, 'sweepPokemonSheets');
    os.update(POKEMON_SHEET_SWEEP_SEC / 2);
    expect(sweep).not.toHaveBeenCalled();
    os.update(POKEMON_SHEET_SWEEP_SEC / 2);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
