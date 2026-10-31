/**
 * The themed overlay label: nickname + Lv, species, status badge and the HP
 * bar (context left), and the local "Show connections" setting.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  HP_COLOR_HIGH,
  HP_COLOR_LOW,
  HP_COLOR_MID,
  SHOW_CONNECTIONS_STORAGE_KEY,
} from '../src/constants.js';
import {
  hpColor,
  hpFraction,
  isThemedOverlay,
  pokemonLabel,
  themedRoleLabel,
} from '../src/office/components/pokemonOverlay.js';
import { createCharacter } from '../src/office/engine/characters.js';
import { setPokemonThemeEnabled } from '../src/office/engine/pokemonTheme.js';
import { setPokemonSpecies } from '../src/office/sprites/pokemonSprites.js';
import { CharacterState } from '../src/office/types.js';
import { resetPokemonStore, speciesMessage } from './pokemonFixtures.js';

beforeEach(() => {
  resetPokemonStore();
  setPokemonThemeEnabled(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  resetPokemonStore();
});

function pokemon() {
  const ch = createCharacter(1, 0, null, null);
  ch.state = CharacterState.IDLE;
  ch.isActive = false;
  ch.species = 25;
  return ch;
}

test('HP is the context left; green above half, yellow to a fifth, red below', () => {
  assert.equal(hpFraction(0, 200_000), 1);
  assert.equal(hpFraction(150_000, 200_000), 0.25);
  assert.equal(hpFraction(300_000, 200_000), 0, 'never negative');
  assert.equal(hpFraction(10, 0), 0);
  assert.equal(hpColor(0.51), HP_COLOR_HIGH);
  assert.equal(hpColor(0.5), HP_COLOR_MID);
  assert.equal(hpColor(0.2), HP_COLOR_MID);
  assert.equal(hpColor(0.19), HP_COLOR_LOW);
});

test('the label: nickname and Lv on line 1, the species in small text', () => {
  setPokemonSpecies({ ...speciesMessage(25, { name: 'Sparky' }), anims: {} });
  const ch = pokemon();
  ch.label = 'Fix login bug';
  ch.level = 12;
  // A species with no sheets at all can't be drawn: its capsule stays closed.
  assert.deepEqual(pokemonLabel(ch), {
    nickname: 'Fix login bug',
    level: 'Lv 12',
    species: 'Sparky',
    condition: null,
    spriteUnavailable: true,
  });
  ch.label = undefined;
  ch.level = undefined;
  assert.deepEqual(pokemonLabel(ch), {
    nickname: 'Sparky',
    level: null,
    species: null,
    condition: null,
    spriteUnavailable: true,
  });
});

test('a spawned session shows its name once; a Lead says LEAD', () => {
  setPokemonSpecies({ ...speciesMessage(25, { name: 'Sparky' }), anims: {} });
  const child = pokemon();
  // The driver sets a child's agentName to its session label (= its nickname).
  child.label = 'Fix login redirect';
  child.agentName = 'Fix login redirect';
  assert.equal(themedRoleLabel(child, pokemonLabel(child).nickname), null);

  // A teammate name that differs from the nickname still shows.
  child.agentName = 'researcher';
  assert.equal(themedRoleLabel(child, pokemonLabel(child).nickname), 'researcher');

  const lead = pokemon();
  lead.label = 'Plan the auth refactor';
  lead.isTeamLead = true;
  assert.equal(themedRoleLabel(lead, pokemonLabel(lead).nickname), 'LEAD');
});

test('badges: SLP asleep, ! needs you, FNT fainted', () => {
  const ch = pokemon();
  ch.asleep = true;
  assert.equal(pokemonLabel(ch).condition, 'asleep');
  ch.awaitingInput = true;
  assert.equal(pokemonLabel(ch).condition, 'needsYou');
  ch.isErrored = true;
  assert.equal(pokemonLabel(ch).condition, 'fainted');
});

test('themed overlay: theme on and a known species; others stay upstream', () => {
  const ch = pokemon();
  assert.equal(isThemedOverlay(ch), false, 'species 25 was never described by the server');
  setPokemonSpecies({ ...speciesMessage(25), anims: {} });
  assert.equal(isThemedOverlay(ch), true, 'themed before any sheet decodes');
  ch.isSubagent = true;
  assert.equal(isThemedOverlay(ch), false);
  ch.isSubagent = false;
  setPokemonThemeEnabled(false);
  assert.equal(isThemedOverlay(ch), false);
  setPokemonThemeEnabled(true);
  ch.species = undefined;
  assert.equal(isThemedOverlay(ch), false);
});

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

test('"Show connections" defaults on, even without storage', async () => {
  vi.stubGlobal('localStorage', undefined);
  const mod = await import('../src/office/showConnections.js');
  assert.equal(mod.getShowConnections(), true);
});

test('"Show connections" reads and writes its localStorage key and notifies', async () => {
  const storage = fakeStorage({ [SHOW_CONNECTIONS_STORAGE_KEY]: 'false' });
  vi.stubGlobal('localStorage', storage);
  const mod = await import('../src/office/showConnections.js');
  assert.equal(mod.getShowConnections(), false);
  let calls = 0;
  const unsubscribe = mod.subscribeShowConnections(() => calls++);
  mod.setShowConnections(true);
  assert.equal(mod.getShowConnections(), true);
  assert.equal(storage.data.get(SHOW_CONNECTIONS_STORAGE_KEY), 'true');
  assert.equal(calls, 1);
  mod.setShowConnections(true);
  assert.equal(calls, 1, 'no change, no notification');
  unsubscribe();
  mod.setShowConnections(false);
  assert.equal(calls, 1);
});
