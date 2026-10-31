/**
 * The Pokémon office's domain model: the species store (decode, measure,
 * shiny keyed apart, URL allowlist) and what OfficeState does with it —
 * species hit boxes, the Poké Ball spawn/recall timing behind matrixEffect,
 * the Lead's throw, evolution, faint, sleep and wake. Synthetic species and a
 * fake sheet loader; no DOM, no art.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
  POKEBALL_RECALL_SEC,
  POKEBALL_SPAWN_SEC,
  POKEMON_EVOLVE_SEC,
  POKEMON_FEET_BELOW_GROUND_PX,
  POKEMON_GROUND_OFFSET_PX,
  POKEMON_SLEEP_AFTER_SEC,
} from '../src/constants.js';
import { reconcileExistingAgents } from '../src/office/engine/existingAgents.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { characterChest, isPokemonCharacter } from '../src/office/engine/pokemonCharacter.js';
import { setPokemonThemeEnabled } from '../src/office/engine/pokemonTheme.js';
import {
  computePokemonGeometry,
  getPokemonGeometry,
  getPokemonSpeciesInfo,
  getPokemonSpeciesName,
  isAllowedSpriteUrl,
  isPokemonReady,
  setPokemonSpecies,
} from '../src/office/sprites/pokemonSprites.js';
import type { Character } from '../src/office/types.js';
import { CharacterState, MATRIX_EFFECT_DURATION, TILE_SIZE } from '../src/office/types.js';
import {
  floorLayout,
  flushDecodes,
  IDLE_BOX,
  installFakeLoader,
  resetPokemonStore,
  speciesMessage,
} from './pokemonFixtures.js';

const realRandom = Math.random;

beforeEach(() => {
  resetPokemonStore();
  setPokemonThemeEnabled(true);
  // Refused and failed sheets log a warning; keep the run quiet.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  Math.random = realRandom;
  resetPokemonStore();
  setPokemonThemeEnabled(true);
});

/** Load species `dexes` (plain) through the fake loader and wait for decodes. */
async function loadSpecies(...dexes: number[]): Promise<void> {
  const msgs = dexes.map((dex) => speciesMessage(dex));
  installFakeLoader(msgs);
  for (const msg of msgs) setPokemonSpecies(msg);
  await flushDecodes();
}

/** An agent standing on tile (col,row), already spawned, idle. */
function placeAgent(os: OfficeState, id: number, col: number, row: number): Character {
  os.addAgent(id, 0, 0, undefined, true);
  const ch = os.characters.get(id)!;
  ch.tileCol = col;
  ch.tileRow = row;
  ch.x = col * TILE_SIZE + TILE_SIZE / 2;
  ch.y = row * TILE_SIZE + TILE_SIZE / 2;
  ch.state = CharacterState.IDLE;
  ch.isActive = false;
  ch.path = [];
  return ch;
}

// ── species store ───────────────────────────────────────────────

test('geometry is the opaque box of a frame around the ground point', () => {
  const w = 40;
  const h = 56;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = IDLE_BOX.y0; y <= IDLE_BOX.y1; y++) {
    for (let x = IDLE_BOX.x0; x <= IDLE_BOX.x1; x++) rgba[(y * w + x) * 4 + 3] = 255;
  }
  rgba[(0 * w + 0) * 4 + 3] = 1; // below the alpha threshold: not body
  assert.deepEqual(computePokemonGeometry(rgba, w, h), {
    frameWidth: 40,
    frameHeight: 56,
    anchorX: 20,
    anchorY: 32,
    bodyTop: 20,
    bodyHalfW: 6,
    headRise: 12,
  });
  const empty = computePokemonGeometry(new Uint8ClampedArray(w * h * 4), w, h);
  assert.equal(empty.headRise, 32, 'a blank frame falls back to the whole frame');
});

test('a species becomes ready once Idle is decoded and measured from Idle', async () => {
  const msg = speciesMessage(25, { name: 'Sparky' });
  const { loads } = installFakeLoader([msg]);
  setPokemonSpecies(msg);
  assert.equal(isPokemonReady(25, false), false, 'not before the sheets decode');
  assert.equal(getPokemonSpeciesInfo(25, false)?.name, 'Sparky', 'metadata is there at once');
  await flushDecodes();
  assert.equal(isPokemonReady(25, false), true);
  assert.equal(getPokemonGeometry(25, false)?.headRise, 12, 'measured on Idle, not Walk');
  assert.deepEqual(loads.slice(0, 2), [msg.anims.Idle.url, msg.anims.Walk.url], 'Idle first');
});

test('shiny is a separate species; names fall back across the two', async () => {
  const plain = speciesMessage(25, { name: 'Sparky' });
  installFakeLoader([plain]);
  setPokemonSpecies(plain);
  await flushDecodes();
  assert.equal(isPokemonReady(25, true), false, 'the shiny entry was never sent');
  assert.equal(getPokemonSpeciesName(25, true), 'Sparky');
  assert.equal(getPokemonSpeciesInfo(25, true), undefined);
});

test('a failed Idle hands the measurement to Walk', async () => {
  const msg = speciesMessage(4);
  installFakeLoader([msg], { fail: ['Idle'] });
  setPokemonSpecies(msg);
  await flushDecodes();
  assert.equal(isPokemonReady(4, false), true);
  assert.equal(getPokemonGeometry(4, false)?.frameWidth, 32, 'Walk frame');
  assert.match(String(vi.mocked(console.warn).mock.calls[0]?.[0]), /#4 Idle sheet unavailable/);
});

test('a sheet smaller than its metadata is refused', async () => {
  const msg = speciesMessage(7);
  installFakeLoader([msg], { shrink: ['Idle', 'Walk'] });
  setPokemonSpecies(msg);
  await flushDecodes();
  assert.equal(isPokemonReady(7, false), false);
});

test('sprite URLs: PNG data URLs and same-origin http only', () => {
  const origin = 'http://127.0.0.1:41510';
  assert.equal(isAllowedSpriteUrl('data:image/png;base64,AAAA', undefined), true);
  assert.equal(isAllowedSpriteUrl('/api/pokemon/0025/Walk-Anim.png', origin), true);
  assert.equal(isAllowedSpriteUrl(`${origin}/api/pokemon/0025/Walk-Anim.png`, origin), true);
  assert.equal(isAllowedSpriteUrl('https://raw.githubusercontent.com/x.png', origin), false);
  assert.equal(isAllowedSpriteUrl('//evil.example/x.png', origin), false);
  assert.equal(isAllowedSpriteUrl('data:text/html,<script>', origin), false);
  assert.equal(isAllowedSpriteUrl('/api/pokemon/0025/Walk-Anim.png', undefined), false);
});

test('a refused URL never reaches the loader', async () => {
  const msg = speciesMessage(9);
  msg.anims.Idle.url = 'https://elsewhere.example/Idle-Anim.png';
  const { loads } = installFakeLoader([msg]);
  setPokemonSpecies(msg);
  await flushDecodes();
  assert.ok(!loads.includes(msg.anims.Idle.url));
  assert.equal(getPokemonGeometry(9, false)?.frameWidth, 32, 'Walk measured instead');
});

// ── hit-testing ─────────────────────────────────────────────────

test('a Pokémon is hit on its measured body, an upstream character on 16×24', async () => {
  await loadSpecies(25);
  const os = new OfficeState(floorLayout());
  const ch = placeAgent(os, 1, 5, 5);
  const groundY = ch.y + POKEMON_GROUND_OFFSET_PX;

  // Upstream box first: no species yet.
  assert.equal(os.getCharacterAt(ch.x + CHARACTER_HIT_HALF_WIDTH - 1, ch.y - 2), 1);
  assert.equal(os.getCharacterAt(ch.x, ch.y - CHARACTER_HIT_HEIGHT + 1), 1);

  os.setAgentIdentity(1, { species: 25 });
  assert.equal(isPokemonCharacter(ch), true);
  // Body: 6 px either side of x, from 12 px above the ground point to 2 below.
  assert.equal(os.getCharacterAt(ch.x + 6, groundY - 12), 1);
  assert.equal(os.getCharacterAt(ch.x, groundY + POKEMON_FEET_BELOW_GROUND_PX), 1);
  assert.equal(os.getCharacterAt(ch.x + 7, groundY - 4), null, 'outside the narrower body');
  assert.equal(os.getCharacterAt(ch.x, groundY - 13), null, 'above the head');

  setPokemonThemeEnabled(false);
  assert.equal(os.getCharacterAt(ch.x + 7, ch.y - 4), 1, 'theme off: upstream box again');
});

test('a species that has not decoded keeps the upstream hit box', async () => {
  installFakeLoader([]);
  const os = new OfficeState(floorLayout());
  const ch = placeAgent(os, 1, 5, 5);
  os.setAgentIdentity(1, { species: 151 });
  assert.equal(isPokemonCharacter(ch), false);
  assert.equal(os.getCharacterAt(ch.x + 7, ch.y - 20), 1);
});

// ── Poké Ball spawn / recall behind matrixEffect ────────────────

test('without a species (or theme off) the matrix rain keeps its 0.3 s', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1);
  assert.equal(os.characters.get(1)!.matrixEffect, 'spawn');
  os.update(MATRIX_EFFECT_DURATION + 0.01);
  assert.equal(os.characters.get(1)!.matrixEffect, null);

  setPokemonThemeEnabled(false);
  os.addAgent(2);
  os.setAgentIdentity(2, { species: 25 });
  os.update(MATRIX_EFFECT_DURATION + 0.01);
  assert.equal(os.characters.get(2)!.matrixEffect, null);
});

test('a species the server never described (VS Code, --no-sprites) keeps the matrix rain', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1);
  os.setAgentIdentity(1, { species: 25 });
  os.update(MATRIX_EFFECT_DURATION + 0.01);
  assert.equal(os.characters.get(1)!.matrixEffect, null);
});

test('with a known species the Poké Ball spawn and recall run their own durations', async () => {
  await loadSpecies(25);
  const os = new OfficeState(floorLayout());
  os.addAgent(1);
  os.setAgentIdentity(1, { species: 25 });
  const ch = os.characters.get(1)!;
  os.update(MATRIX_EFFECT_DURATION + 0.01);
  assert.equal(ch.matrixEffect, 'spawn', 'still opening (field name and values unchanged)');
  os.update(POKEBALL_SPAWN_SEC - MATRIX_EFFECT_DURATION);
  assert.equal(ch.matrixEffect, null);

  os.removeAgent(1);
  assert.equal(ch.matrixEffect, 'despawn');
  os.update(POKEBALL_RECALL_SEC - 0.05);
  assert.ok(os.characters.has(1), 'still being recalled');
  os.update(0.1);
  assert.equal(os.characters.has(1), false);
});

test('an agent id that returns during its recall comes back instead of vanishing', async () => {
  await loadSpecies(25);
  for (const themed of [false, true]) {
    setPokemonThemeEnabled(themed);
    const os = new OfficeState(floorLayout());
    os.seats.set('desk', { uid: 'desk', seatCol: 3, seatRow: 3, facingDir: 0, assigned: false });
    os.addAgent(7, 0, 0, 'desk');
    os.setAgentIdentity(7, { species: 25 });
    os.update(1);
    os.removeAgent(7);
    assert.equal(os.characters.get(7)!.matrixEffect, 'despawn');
    assert.equal(os.seats.get('desk')!.assigned, false, 'the recall frees the seat');

    // agentCreated for the same id while the recall plays (stable Conductor ids).
    os.addAgent(7, 0, 0, 'desk');
    os.setAgentIdentity(7, { species: 25 });
    for (let i = 0; i < 10; i++) os.update(0.1);

    const ch = os.characters.get(7);
    assert.ok(ch, `themed=${themed}: the returning agent is still in the office`);
    assert.equal(ch.matrixEffect, null);
    assert.equal(ch.seatId, 'desk');
    assert.equal(os.seats.get('desk')!.assigned, true, 'its seat is taken again');
  }
});

test('a child created with a Lead is thrown from the Lead; otherwise the ball drops', () => {
  const os = new OfficeState(floorLayout());
  const lead = placeAgent(os, 1, 2, 2);
  os.addAgent(2);
  os.setSpawnOrigin(2, 1);
  assert.deepEqual(os.characters.get(2)!.effectOrigin, characterChest(lead));

  os.addAgent(3);
  assert.equal(os.characters.get(3)!.effectOrigin, undefined, 'no Lead: drops from above');
  os.addAgent(4, 0, 0, undefined, true);
  os.setSpawnOrigin(4, 1);
  assert.equal(os.characters.get(4)!.effectOrigin, undefined, 'restored agents skip the throw');
  os.setSpawnOrigin(3, 99);
  assert.equal(os.characters.get(3)!.effectOrigin, undefined, 'missing Lead');

  os.update(POKEBALL_SPAWN_SEC + 0.01);
  assert.equal(os.characters.get(2)!.effectOrigin, undefined, 'cleared once spawned');
});

test('a sub-agent is the same Pokémon, thrown out of its parent', () => {
  const os = new OfficeState(floorLayout());
  const parent = placeAgent(os, 1, 3, 3);
  os.setAgentIdentity(1, { species: 133, shiny: true });
  const subId = os.addSubagent(1, 'tool-1');
  const sub = os.characters.get(subId)!;
  assert.equal(sub.species, 133);
  assert.equal(sub.shiny, true);
  assert.deepEqual(sub.effectOrigin, characterChest(parent));
});

test('the greeter keeps the matrix rain', () => {
  const os = new OfficeState(floorLayout());
  os.spawnGreeter();
  os.update(MATRIX_EFFECT_DURATION + 0.01);
  assert.equal(os.greeter!.matrixEffect, null);
});

// ── identity and evolution ──────────────────────────────────────

test('identity: absent fields keep what is known', () => {
  const os = new OfficeState(floorLayout());
  const ch = placeAgent(os, 1, 3, 3);
  os.setAgentIdentity(1, {
    species: 1,
    shiny: false,
    level: 3,
    label: 'Fix login',
    providerId: 'conductor',
  });
  os.setAgentIdentity(1, { level: 4 });
  assert.equal(ch.level, 4);
  assert.equal(ch.label, 'Fix login');
  assert.equal(ch.species, 1);
  assert.equal(ch.providerId, 'conductor');
});

test('evolution: a drawn Pokémon flashes and swaps species at the midpoint', async () => {
  await loadSpecies(1, 2);
  const os = new OfficeState(floorLayout());
  const ch = placeAgent(os, 1, 3, 3);
  os.setAgentIdentity(1, { species: 1 });
  os.setAgentIdentity(1, { species: 2 }, { evolve: true });
  assert.equal(ch.species, 1, 'not yet');
  assert.equal(ch.nextSpecies, 2);
  assert.equal(ch.evolveTimer, 0);

  os.setAgentIdentity(1, { species: 2 }, { evolve: true });
  assert.equal(ch.evolveTimer, 0, 'a repeat of the same target does not restart the flash');

  os.update(POKEMON_EVOLVE_SEC / 2 - 0.05);
  assert.equal(ch.species, 1);
  os.update(0.1);
  assert.equal(ch.species, 2, 'swapped mid-flash');
  assert.equal(ch.nextSpecies, undefined);
  assert.notEqual(ch.evolveTimer, undefined, 'the flash is still fading');
  os.update(POKEMON_EVOLVE_SEC / 2);
  assert.equal(ch.evolveTimer, undefined);
});

test('evolution swaps at once for new characters, theme off, or undecoded species', async () => {
  await loadSpecies(1);
  const os = new OfficeState(floorLayout());
  const ch = placeAgent(os, 1, 3, 3);
  os.setAgentIdentity(1, { species: 1 }, { evolve: true });
  assert.equal(ch.species, 1, 'first species: no flash');
  assert.equal(ch.evolveTimer, undefined);

  setPokemonThemeEnabled(false);
  os.setAgentIdentity(1, { species: 2 }, { evolve: true });
  assert.equal(ch.species, 2, 'theme off');
  assert.equal(ch.evolveTimer, undefined);

  setPokemonThemeEnabled(true);
  os.setAgentIdentity(1, { species: 3 }, { evolve: true });
  assert.equal(ch.species, 3, 'species 2 never decoded, so nothing was drawn to flash');
});

// ── conditions: faint, sleep, wake ──────────────────────────────

test('an error faints the Pokémon (Hurt first) until the agent turns active', async () => {
  await loadSpecies(25);
  const os = new OfficeState(floorLayout());
  const ch = placeAgent(os, 1, 3, 3);
  os.setAgentIdentity(1, { species: 25 });
  os.setAgentAwaitingInput(1, true);
  os.setAgentError(1, 'Rate limited');
  assert.equal(ch.isErrored, true);
  assert.equal(ch.errorMessage, 'Rate limited');
  assert.equal(ch.awaitingInput, false);
  assert.equal(ch.pmdAnim, 'hurt');

  os.setAgentActive(1, true);
  assert.equal(ch.isErrored, false);
  assert.equal(ch.errorMessage, undefined);
});

test('a sleeping or fainted Pokémon stays put; an upstream character wanders', async () => {
  await loadSpecies(25);
  Math.random = () => 0; // wander target: tile (0,0)
  const os = new OfficeState(floorLayout());
  const ch = placeAgent(os, 1, 6, 6);
  os.setAgentIdentity(1, { species: 25 });
  ch.idleSec = POKEMON_SLEEP_AFTER_SEC;
  ch.wanderTimer = 0;
  for (let i = 0; i < 20; i++) os.update(0.1);
  assert.equal(ch.state, CharacterState.IDLE);
  assert.deepEqual([ch.tileCol, ch.tileRow], [6, 6], 'asleep in place');

  ch.idleSec = 0;
  os.setAgentError(1, 'boom');
  ch.wanderTimer = 0;
  os.update(0.1);
  assert.equal(ch.state, CharacterState.IDLE, 'fainted in place');

  setPokemonThemeEnabled(false);
  ch.wanderTimer = 0;
  os.update(0.1);
  assert.equal(ch.state, CharacterState.WALK, 'theme off: the upstream wander runs');
});

test('woken from sleep, a Pokémon plays Wake before walking to its desk', async () => {
  await loadSpecies(25);
  const os = new OfficeState(floorLayout());
  const ch = placeAgent(os, 1, 6, 6);
  os.setAgentIdentity(1, { species: 25 });
  os.seats.set('desk', { uid: 'desk', seatCol: 1, seatRow: 1, facingDir: 0, assigned: true });
  ch.seatId = 'desk';
  ch.idleSec = POKEMON_SLEEP_AFTER_SEC + 1;

  os.setAgentActive(1, true);
  assert.equal(ch.pmdAnim, 'wake');
  os.update(0.05);
  assert.equal(ch.state, CharacterState.IDLE, 'holds still while waking');
  os.update(0.2); // Wake is 10 ticks ≈ 0.17 s
  assert.equal(ch.pmdAnim, null);
  os.update(0.05);
  assert.equal(ch.state, CharacterState.WALK, 'then heads for its desk');
});

test('one-shots only start on characters drawn as Pokémon', () => {
  const os = new OfficeState(floorLayout());
  const ch = placeAgent(os, 1, 3, 3);
  os.playTurnEnd(1);
  assert.equal(ch.pmdAnim ?? null, null, 'upstream character: nothing to play');
});

test('a tool burst is ignored mid-walk so it never stalls the walk to the desk', async () => {
  await loadSpecies(25);
  const os = new OfficeState(floorLayout());
  const ch = placeAgent(os, 1, 3, 3);
  os.setAgentIdentity(1, { species: 25 });
  ch.state = CharacterState.WALK;
  os.playToolBurst(1);
  assert.equal(ch.pmdAnim ?? null, null);
  ch.state = CharacterState.TYPE;
  ch.isActive = true;
  os.playToolBurst(1);
  assert.equal(ch.pmdAnim, 'toolBurst', 'seated: the burst plays (Charge, no Shoot here)');
});

// ── restore ─────────────────────────────────────────────────────

test('existingAgents carries each restored agent’s Pokémon', () => {
  const os = new OfficeState(floorLayout());
  const added = reconcileExistingAgents(
    os,
    [5, 6],
    { 5: { palette: 1, hueShift: 0, species: 7, shiny: true }, 6: { palette: 2 } },
    {},
    true,
    [],
  );
  assert.equal(added, true);
  assert.equal(os.characters.get(5)!.species, 7);
  assert.equal(os.characters.get(5)!.shiny, true);
  assert.equal(os.characters.get(6)!.species, undefined);
  assert.equal(os.characters.get(5)!.matrixEffect, null, 'restored agents skip the spawn');
});
