/**
 * A Pokémon office never draws an upstream character: theme on in a host
 * that delivers sprites, every agent is a Pokémon, and until its sheets are
 * decoded (or when they can't load) it is our closed orb, resting where
 * it stands. Its spawn lands the orb and opens it only once the sheets
 * are ready. The greeter is Promptling. Theme off and hosts without sprites
 * keep the upstream look. Synthetic species, a fake canvas, no art.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import {
  ORB_HIT_HALF_WIDTH_PX,
  ORB_HIT_RISE_PX,
  ORB_OPEN_MIN_WAIT_SEC,
  ORB_SPAWN_SEC,
  ORB_WAIT_MAX_SEC,
  POKEMON_EVOLVE_HOLD_MAX_SEC,
  POKEMON_EVOLVE_SEC,
  POKEMON_FEET_BELOW_GROUND_PX,
} from '../src/constants.js';
import { pokemonLabel } from '../src/office/components/pokemonOverlay.js';
import { ORB_LANDED_SEC, spawnEffectStyle } from '../src/office/engine/matrixEffectState.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { evolutionFlashAlpha } from '../src/office/engine/pokemonAnim.js';
import {
  drawnBody,
  isPokemonCharacter,
  isPokemonPlaceholder,
  isPokemonSpriteUnavailable,
} from '../src/office/engine/pokemonCharacter.js';
import type { PokemonFramePick } from '../src/office/engine/pokemonRender.js';
import { resolvePokemonFrame } from '../src/office/engine/pokemonRender.js';
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

function fakeContext(draws: unknown[][]): CanvasRenderingContext2D {
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
    assert.equal(isPokemonPlaceholder(os.characters.get(id)!), true, `agent ${id} is an orb`);
  }
  assert.equal(isPokemonSpriteUnavailable(os.characters.get(3)!), true);
  assert.equal(pokemonLabel(os.characters.get(3)!).spriteUnavailable, true);
  assert.equal(pokemonLabel(os.characters.get(2)!).spriteUnavailable, false, 'still loading');
  assert.equal(spawnEffectStyle(os.greeter!), 'orb', 'Promptling steps out of an orb');

  // The sheets arrive: the orbs open into Pokémon, still no human.
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

test('an orb lands and waits closed for its sheets, then opens where it lies', async () => {
  const msg = speciesMessage(25);
  installFakeLoader([msg]);
  const os = new OfficeState(floorLayout());
  os.addAgent(1);
  os.setAgentIdentity(1, { species: 25 });
  const ch = at(os, 1, 4, 4);
  os.update(ORB_LANDED_SEC + 0.01);
  assert.equal(ch.matrixEffect, 'spawn');
  assert.equal(ch.matrixEffectTimer, ORB_LANDED_SEC, 'landed, held closed');
  os.update(2);
  assert.equal(ch.matrixEffectTimer, ORB_LANDED_SEC, 'still waiting');
  const box = drawnBody(ch)!;
  assert.deepEqual(
    [box.right - box.left, box.bottom - box.top],
    [2 * ORB_HIT_HALF_WIDTH_PX, ORB_HIT_RISE_PX + POKEMON_FEET_BELOW_GROUND_PX],
    'clicked on as the orb it is',
  );

  setPokemonSpecies(msg);
  await flushDecodes();
  os.update(0.05);
  assert.ok(ch.matrixEffectTimer > ORB_LANDED_SEC, 'opening');
  os.update(ORB_SPAWN_SEC);
  assert.equal(ch.matrixEffect, null);
  assert.equal(isPokemonCharacter(ch), true);
});

test('past ORB_WAIT_MAX_SEC the spawn ends; the orb stays put until it can open', async () => {
  const msg = speciesMessage(25);
  installFakeLoader([msg]);
  const os = new OfficeState(floorLayout());
  os.seats.set('desk', { uid: 'desk', seatCol: 1, seatRow: 1, facingDir: 0, assigned: true });
  os.addAgent(1);
  os.setAgentIdentity(1, { species: 25 });
  const ch = at(os, 1, 6, 6);
  ch.seatId = 'desk';
  ch.state = CharacterState.IDLE;
  for (let t = 0; t < ORB_WAIT_MAX_SEC + 1; t += 0.1) os.update(0.1);
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
  os.update(ORB_SPAWN_SEC);
  os.update(0.1);
  assert.equal(ch.state, CharacterState.WALK, 'then off to its desk');
});

test('an orb whose spawn gave up still opens when its sheets land right after', async () => {
  const msg = speciesMessage(25);
  installFakeLoader([msg]);
  const os = new OfficeState(floorLayout());
  os.addAgent(1);
  os.setAgentIdentity(1, { species: 25 });
  const ch = at(os, 1, 4, 4);
  for (let t = 0; t < ORB_LANDED_SEC + ORB_WAIT_MAX_SEC + 0.05; t += 0.05) os.update(0.05);
  assert.equal(ch.matrixEffect, null, 'the spawn gave up waiting');
  os.update(0.05); // a frame later, the sheets land
  setPokemonSpecies(msg);
  await flushDecodes();
  os.update(0.05);
  assert.equal(ch.matrixEffect, 'spawn', 'it waited closed for seconds: it opens');
});

test('a restored agent waits as an orb; a reload’s short wait swaps in place, a long one opens', async () => {
  // A reload decodes cached sheets within a few frames: the agents that
  // were already here just appear, as before the reload. One whose sheets
  // take a while (a first launch) rested visibly closed, and opens.
  const quick = speciesMessage(25);
  const slow = speciesMessage(26);
  installFakeLoader([quick, slow]);
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 0, 0, undefined, true);
  os.addAgent(2, 0, 0, undefined, true);
  os.setAgentIdentity(1, { species: 25 });
  os.setAgentIdentity(2, { species: 26 });
  const reloaded = os.characters.get(1)!;
  const firstLaunch = os.characters.get(2)!;
  os.update(0.05);
  assert.equal(reloaded.matrixEffect, null);
  assert.equal(isPokemonPlaceholder(reloaded), true);
  assert.equal(humansDrawn(os), 0);

  setPokemonSpecies(quick);
  await flushDecodes();
  os.update(0.05);
  assert.equal(isPokemonCharacter(reloaded), true);
  assert.equal(reloaded.matrixEffect, null, 'seen closed for a moment: no orb opening');

  for (let t = 0; t < ORB_OPEN_MIN_WAIT_SEC; t += 0.1) os.update(0.1);
  setPokemonSpecies(slow);
  await flushDecodes();
  os.update(0.05);
  assert.equal(firstLaunch.matrixEffect, 'spawn', 'rested closed a while: it opens');
  assert.equal(firstLaunch.effectOrigin, undefined, 'in place');
  assert.equal(humansDrawn(os), 0);
});

test('evolving into a species still decoding holds the flash white, never an orb', async () => {
  const from = speciesMessage(25);
  const into = speciesMessage(26);
  installFakeLoader([from, into]);
  setPokemonSpecies(from);
  await flushDecodes();
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 0, 0, undefined, true);
  os.setAgentIdentity(1, { species: 25 });
  const ch = at(os, 1, 4, 4);
  os.update(0.05);
  // agentDetails announces the evolution before 26's sheets have decoded.
  os.setAgentIdentity(1, { species: 26 }, { evolve: true });
  for (let t = 0; t < POKEMON_EVOLVE_SEC * 3; t += 0.05) {
    os.update(0.05);
    assert.equal(isPokemonPlaceholder(ch), false, `never an orb (${t.toFixed(2)} s)`);
    assert.equal(humansDrawn(os), 0);
  }
  assert.equal(ch.species, 25, 'not swapped yet');
  assert.equal(ch.evolveTimer, POKEMON_EVOLVE_SEC / 2, 'held at the midpoint');
  assert.equal(evolutionFlashAlpha(ch.evolveTimer), 1, 'solid white');

  setPokemonSpecies(into);
  await flushDecodes();
  for (let t = 0; t < POKEMON_EVOLVE_SEC; t += 0.05) {
    os.update(0.05);
    assert.equal(ch.matrixEffect, null, 'no orb opening after it');
    assert.equal(isPokemonCharacter(ch), true);
  }
  assert.equal(ch.species, 26);
  assert.equal(ch.evolveTimer, undefined, 'the flash ended');

  // A species that never decodes: the flash gives up after the hold and swaps.
  os.setAgentIdentity(1, { species: 27 }, { evolve: true });
  for (let t = 0; t < POKEMON_EVOLVE_HOLD_MAX_SEC + POKEMON_EVOLVE_SEC; t += 0.1) os.update(0.1);
  assert.equal(ch.species, 27);
  assert.equal(ch.evolveTimer, undefined);
});

test('a sub-agent spawned before its parent’s species arrives, or evolves, follows it', async () => {
  const parentMsg = speciesMessage(25);
  const evolvedMsg = speciesMessage(26);
  installFakeLoader([parentMsg, evolvedMsg]);
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 0, 0, undefined, true); // no species yet
  const early = os.addSubagent(1, 'task-early');
  const sub = os.characters.get(early)!;
  assert.equal(sub.species, undefined);
  os.setAgentIdentity(1, { species: 25 });
  assert.equal(sub.species, 25, 'took its parent’s species when it arrived');
  setPokemonSpecies(parentMsg);
  await flushDecodes();
  for (let i = 0; i < 40; i++) os.update(0.05);
  assert.equal(isPokemonCharacter(sub), true);

  // The parent evolves after the sub-agent is out: the sub-agent follows.
  setPokemonSpecies(evolvedMsg);
  await flushDecodes();
  os.setAgentIdentity(1, { species: 26 }, { evolve: true });
  for (let t = 0; t < POKEMON_EVOLVE_SEC + 0.1; t += 0.05) os.update(0.05);
  assert.equal(os.characters.get(1)!.species, 26);
  assert.equal(sub.species, 26, 'the sub-agent evolved with it');
  assert.equal(humansDrawn(os), 0);
});

test('walking while its Walk sheet is still out, a Pokémon walks in its Idle pose', async () => {
  const msg = speciesMessage(25);
  installFakeLoader([msg], { fail: ['Walk'] });
  setPokemonSpecies(msg);
  await flushDecodes();
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 0, 0, undefined, true);
  os.setAgentIdentity(1, { species: 25 });
  const ch = at(os, 1, 4, 4);
  os.update(0.05);
  ch.state = CharacterState.WALK;
  const pick: PokemonFramePick = { anim: '', situation: 'idle', loop: false, col: 0, row: 0 };
  assert.ok(resolvePokemonFrame(ch, pick), 'a frame to draw');
  assert.deepEqual([pick.situation, pick.anim], ['walk', 'Idle']);
  const draws: unknown[][] = [];
  renderScene(fakeContext(draws), [], os.getCharacters(), 0, 0, 2, null, null);
  const sheets = draws.map((d) => (d[0] as { url?: string }).url).filter(Boolean);
  assert.ok(
    sheets.some((url) => url!.endsWith('-Idle')),
    'drawn from its Idle sheet, not as an orb',
  );
});
