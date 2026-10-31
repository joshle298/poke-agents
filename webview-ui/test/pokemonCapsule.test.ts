/**
 * A Pokémon office never draws an upstream character: theme on in a host
 * that delivers sprites, every agent is a Pokémon, and until its sheets are
 * decoded (or when they can't load) it is our closed capsule, resting where
 * it stands. Its spawn lands the capsule and opens it only once the sheets
 * are ready. The greeter is Promptling. Theme off and hosts without sprites
 * keep the upstream look. Synthetic species, a fake canvas, no art.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import { CAPSULE_SPAWN_SEC, CAPSULE_WAIT_MAX_SEC } from '../src/constants.js';
import { pokemonLabel } from '../src/office/components/pokemonOverlay.js';
import { CAPSULE_LANDED_SEC, spawnEffectStyle } from '../src/office/engine/matrixEffectState.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import {
  drawnBody,
  isPokemonCharacter,
  isPokemonPlaceholder,
  isPokemonSpriteUnavailable,
} from '../src/office/engine/pokemonCharacter.js';
import {
  setPokemonSpritesDelivered,
  setPokemonThemeEnabled,
} from '../src/office/engine/pokemonTheme.js';
import {
  getCharacterDrawStats,
  renderScene,
  resetCharacterDrawStats,
} from '../src/office/engine/renderer.js';
import {
  markPokemonSpeciesFailed,
  setPokemonSpecies,
} from '../src/office/sprites/pokemonSprites.js';
import type { Character } from '../src/office/types.js';
import { CharacterState, TILE_SIZE } from '../src/office/types.js';
import {
  floorLayout,
  flushDecodes,
  installFakeLoader,
  resetPokemonStore,
  speciesMessage,
} from './pokemonFixtures.js';

// ── A canvas just real enough for the renderer ──────────────────

function fakeContext(draws: unknown[]): CanvasRenderingContext2D {
  const noop = () => {};
  return new Proxy(
    { drawImage: (...args: unknown[]) => draws.push(args) },
    {
      get: (target, key) => (key in target ? target[key as 'drawImage'] : noop),
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

const realDocument = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => fakeContext([]) }),
  };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

/** Draw the office once; returns how many characters were drawn as humans. */
function humansDrawn(os: OfficeState): number {
  resetCharacterDrawStats();
  renderScene(fakeContext([]), [], os.getCharacters(), 0, 0, 2, null, null);
  return getCharacterDrawStats().humanDraws;
}

beforeEach(() => {
  resetPokemonStore();
  setPokemonThemeEnabled(true);
  setPokemonSpritesDelivered(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPokemonStore();
  setPokemonThemeEnabled(true);
  setPokemonSpritesDelivered(false);
});

function at(os: OfficeState, id: number, col: number, row: number): Character {
  const ch = os.characters.get(id)!;
  ch.tileCol = col;
  ch.tileRow = row;
  ch.x = col * TILE_SIZE + TILE_SIZE / 2;
  ch.y = row * TILE_SIZE + TILE_SIZE / 2;
  return ch;
}

test('no human, ever: unknown species, loading sheets, failed ones, sub-agents, the greeter', async () => {
  const msg = speciesMessage(25);
  installFakeLoader([msg]);
  const os = new OfficeState(floorLayout());
  os.addAgent(1); // agentCreated without a species yet
  os.addAgent(2);
  os.setAgentIdentity(2, { species: 25 }); // species known, nothing described yet
  os.addAgent(3);
  os.setAgentIdentity(3, { species: 7 });
  markPokemonSpeciesFailed(7, false); // the server couldn't load it
  const sub = os.addSubagent(2, 'task-1'); // the parent's Pokémon
  os.spawnGreeter();
  for (let i = 0; i < 40; i++) {
    os.update(0.05);
    assert.equal(humansDrawn(os), 0, `frame ${i}`);
  }
  for (const id of [1, 2, 3, sub]) {
    assert.equal(isPokemonPlaceholder(os.characters.get(id)!), true, `agent ${id} is a capsule`);
  }
  assert.equal(isPokemonSpriteUnavailable(os.characters.get(3)!), true);
  assert.equal(pokemonLabel(os.characters.get(3)!).spriteUnavailable, true);
  assert.equal(pokemonLabel(os.characters.get(2)!).spriteUnavailable, false, 'still loading');
  assert.equal(spawnEffectStyle(os.greeter!), 'capsule', 'Promptling steps out of a capsule');

  // The sheets arrive: the capsules open into Pokémon, still no human.
  setPokemonSpecies(msg);
  await flushDecodes();
  os.setAgentIdentity(1, { species: 25 });
  for (let i = 0; i < 40; i++) {
    os.update(0.05);
    assert.equal(humansDrawn(os), 0, `after decode, frame ${i}`);
  }
  assert.equal(isPokemonCharacter(os.characters.get(1)!), true);
  assert.equal(isPokemonCharacter(os.characters.get(sub)!), true, 'the sub is its parent’s');
  assert.equal(isPokemonPlaceholder(os.characters.get(3)!), true, 'the failed one stays closed');
});

test('theme off, or a host without sprites (VS Code, --no-sprites): upstream characters', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 0, 0, undefined, true);
  os.setAgentIdentity(1, { species: 25 });
  os.spawnGreeter();
  os.update(1);
  setPokemonThemeEnabled(false);
  assert.equal(humansDrawn(os), 2, 'theme off: the agent and the greeter');
  assert.equal(spawnEffectStyle(os.greeter!), 'matrix');
  setPokemonThemeEnabled(true);
  setPokemonSpritesDelivered(false);
  assert.equal(humansDrawn(os), 2, 'no sprites from this host: as upstream');
});

test('a capsule lands and waits closed for its sheets, then opens where it lies', async () => {
  const msg = speciesMessage(25);
  installFakeLoader([msg]);
  const os = new OfficeState(floorLayout());
  os.addAgent(1);
  os.setAgentIdentity(1, { species: 25 });
  const ch = at(os, 1, 4, 4);
  os.update(CAPSULE_LANDED_SEC + 0.01);
  assert.equal(ch.matrixEffect, 'spawn');
  assert.equal(ch.matrixEffectTimer, CAPSULE_LANDED_SEC, 'landed, held closed');
  os.update(2);
  assert.equal(ch.matrixEffectTimer, CAPSULE_LANDED_SEC, 'still waiting');
  const box = drawnBody(ch)!;
  assert.ok(box.bottom - box.top < 16, 'clicked on as the capsule it is');

  setPokemonSpecies(msg);
  await flushDecodes();
  os.update(0.05);
  assert.ok(ch.matrixEffectTimer > CAPSULE_LANDED_SEC, 'opening');
  os.update(CAPSULE_SPAWN_SEC);
  assert.equal(ch.matrixEffect, null);
  assert.equal(isPokemonCharacter(ch), true);
});

test('past CAPSULE_WAIT_MAX_SEC the spawn ends; the capsule stays put until it can open', async () => {
  const msg = speciesMessage(25);
  installFakeLoader([msg]);
  const os = new OfficeState(floorLayout());
  os.seats.set('desk', { uid: 'desk', seatCol: 1, seatRow: 1, facingDir: 0, assigned: true });
  os.addAgent(1);
  os.setAgentIdentity(1, { species: 25 });
  const ch = at(os, 1, 6, 6);
  ch.seatId = 'desk';
  ch.state = CharacterState.IDLE;
  for (let t = 0; t < CAPSULE_WAIT_MAX_SEC + 1; t += 0.1) os.update(0.1);
  assert.equal(ch.matrixEffect, null, 'the spawn gave up waiting');
  os.setAgentActive(1, true);
  for (let t = 0; t < 5; t += 0.1) os.update(0.1);
  assert.deepEqual([ch.tileCol, ch.tileRow, ch.state], [6, 6, CharacterState.IDLE], 'holds still');
  assert.equal(humansDrawn(os), 0);

  setPokemonSpecies(msg);
  await flushDecodes();
  os.update(0.05);
  assert.equal(ch.matrixEffect, 'spawn', 'opens in place');
  assert.equal(ch.effectOrigin, undefined, 'no throw: it was already lying there');
  os.update(CAPSULE_SPAWN_SEC);
  os.update(0.1);
  assert.equal(ch.state, CharacterState.WALK, 'then off to its desk');
});

test('a restored agent waits as a capsule too, and opens once its sheets decode', async () => {
  const msg = speciesMessage(25);
  installFakeLoader([msg]);
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 0, 0, undefined, true);
  os.setAgentIdentity(1, { species: 25 });
  os.update(0.1);
  const ch = os.characters.get(1)!;
  assert.equal(ch.matrixEffect, null);
  assert.equal(isPokemonPlaceholder(ch), true);
  assert.equal(humansDrawn(os), 0);
  setPokemonSpecies(msg);
  await flushDecodes();
  os.update(0.05);
  assert.equal(ch.matrixEffect, 'spawn');
});
