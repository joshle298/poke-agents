/**
 * Area roles and where characters go in the Pokémon Town: working agents sit
 * at the Lab's desks, idle ones walk out to the Meadow and wander only there,
 * asleep ones nap where they lie, fainted ones walk to the Pokémon Center and
 * rest until revived, then go back to their desks. A layout without roles (the
 * classic office) leaves every character to the upstream FSM.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import {
  AREA_DEFAULT_COLORS,
  POKEMON_SLEEP_AFTER_SEC,
  TOWN_MEADOW_DELAY_SEC,
  TOWN_USER_WALK_HOLD_SEC,
} from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { choosePokemonAnim } from '../src/office/engine/pokemonAnim.js';
import { setPokemonThemeEnabled } from '../src/office/engine/pokemonTheme.js';
import { pickTownTile, townGoalFor } from '../src/office/engine/townBehavior.js';
import { areaRoleTiles, tileKey } from '../src/office/layout/areaRoles.js';
import { setPokemonSpecies } from '../src/office/sprites/pokemonSprites.js';
import type { Character, OfficeLayout } from '../src/office/types.js';
import { CharacterState, TileType } from '../src/office/types.js';
import {
  flushDecodes,
  installFakeLoader,
  resetPokemonStore,
  speciesMessage,
} from './pokemonFixtures.js';
import {
  CLASSIC_LAYOUT_PATH,
  loadBundledCatalog,
  readBundledLayout,
  TOWN_LAYOUT_PATH,
} from './worldFixtures.js';

const realRandom = Math.random;
const DT = 0.1;

/** Seeded Math.random, so wander targets are the same on every run. */
function seedRandom(seed: number): void {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(os: OfficeState, seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds; t += DT) {
    os.update(DT);
    each?.();
  }
}

/** A working agent seated at its desk in the town. */
function seatedAgent(os: OfficeState, id: number): Character {
  os.addAgent(id, 0, 0, undefined, true);
  const ch = os.characters.get(id)!;
  assert.ok(ch.seatId, 'seated at creation');
  assert.equal(ch.state, CharacterState.TYPE);
  return ch;
}

const at = (ch: Character) => tileKey(ch.tileCol, ch.tileRow);

let town: OfficeLayout;

beforeAll(() => {
  loadBundledCatalog();
  town = readBundledLayout(TOWN_LAYOUT_PATH);
});

beforeEach(() => {
  seedRandom(7);
  setPokemonThemeEnabled(false);
});

afterEach(() => {
  Math.random = realRandom;
  resetPokemonStore();
  setPokemonThemeEnabled(true);
  vi.restoreAllMocks();
});

// ── Area roles ──────────────────────────────────────────────────

function smallLayout(): OfficeLayout {
  const cols = 4;
  const rows = 2;
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
    areas: [
      { label: 'Grass', color: AREA_DEFAULT_COLORS[0], role: 'meadow' },
      { label: 'Field', color: AREA_DEFAULT_COLORS[1], role: 'meadow' },
      { label: 'Desks', color: AREA_DEFAULT_COLORS[2] },
      { label: 'Clinic', color: AREA_DEFAULT_COLORS[3], role: 'center' },
    ],
    areaTiles: ['Grass', 'Field', null, 'Desks', null, null, 'Clinic', 'Clinic'],
  };
}

test('area roles merge every Area with the role and ignore plain Areas', () => {
  const roles = areaRoleTiles(smallLayout())!;
  assert.deepEqual([...roles.meadow].sort(), ['0,0', '1,0']);
  assert.deepEqual([...roles.center].sort(), ['2,1', '3,1']);
});

test('a layout without role areas has no town', () => {
  const plain = { ...smallLayout(), areas: [{ label: 'Desks', color: AREA_DEFAULT_COLORS[2] }] };
  assert.equal(areaRoleTiles(plain), null);
  assert.equal(areaRoleTiles({ ...smallLayout(), areas: undefined }), null);
  assert.equal(areaRoleTiles({ ...smallLayout(), areaTiles: [] }), null);
  assert.equal(new OfficeState(readBundledLayout(CLASSIC_LAYOUT_PATH)).town, null);
});

test('townGoalFor: working, fainted, needs-you and idle characters', () => {
  const roles = areaRoleTiles(smallLayout());
  const base = { isActive: false, isSubagent: false, bubbleType: null } as const;
  assert.equal(townGoalFor({ ...base, isActive: true }, roles), null, 'working: its seat');
  assert.equal(townGoalFor({ ...base, isSubagent: true }, roles), null, 'sub-agents: upstream');
  assert.equal(townGoalFor({ ...base, isErrored: true }, roles), 'center');
  assert.equal(townGoalFor({ ...base, awaitingInput: true }, roles), 'stay');
  assert.equal(townGoalFor({ ...base, bubbleType: 'permission' }, roles), 'stay');
  assert.equal(townGoalFor(base, roles), 'meadow');
  assert.equal(townGoalFor(base, null), null, 'no roles: upstream');
  const meadowOnly = { meadow: roles!.meadow, center: new Set<string>() };
  assert.equal(townGoalFor({ ...base, isErrored: true }, meadowOnly), null, 'no Center');
  const centerOnly = { meadow: new Set<string>(), center: roles!.center };
  assert.equal(townGoalFor(base, centerOnly), null, 'no Meadow');
});

test('pickTownTile prefers a tile nobody stands on or is heading to', () => {
  const tiles = [
    { col: 0, row: 0 },
    { col: 1, row: 0 },
  ];
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(pickTownTile(tiles, new Set(['0,0'])), { col: 1, row: 0 });
  }
  assert.ok(pickTownTile(tiles, new Set(['0,0', '1,0'])), 'all taken: any tile');
  assert.equal(pickTownTile([], new Set()), null);
});

// ── The town, live ──────────────────────────────────────────────

test('an idle agent leaves its desk for the Meadow and wanders only inside it', () => {
  const os = new OfficeState(town);
  const roles = os.town!.roles;
  const ch = seatedAgent(os, 1);
  assert.ok(!roles.meadow.has(at(ch)), 'the desk is not in the Meadow');
  os.setAgentActive(1, false);
  run(os, TOWN_MEADOW_DELAY_SEC - 0.5);
  assert.equal(ch.townGoal, 'meadow');
  assert.ok(!roles.meadow.has(at(ch)), 'pauses before walking out');
  run(os, 30);
  assert.ok(roles.meadow.has(at(ch)), `in the Meadow after the walk (at ${at(ch)})`);
  const visited = new Set<string>();
  run(os, 120, () => {
    if (ch.state !== CharacterState.WALK) {
      visited.add(at(ch));
      assert.ok(roles.meadow.has(at(ch)), `stops only in the Meadow (at ${at(ch)})`);
    }
    const end = ch.path[ch.path.length - 1];
    if (end) assert.ok(roles.meadow.has(tileKey(end.col, end.row)), 'heads only into the Meadow');
  });
  assert.ok(visited.size > 1, 'it wanders');
});

test('a fainted agent walks to the Pokémon Center, rests there, and goes back to work when revived', () => {
  const os = new OfficeState(town);
  const roles = os.town!.roles;
  const ch = seatedAgent(os, 1);
  const seat = os.seats.get(ch.seatId!)!;
  os.setAgentActive(1, false);
  os.setAgentError(1, 'overloaded');
  run(os, 30);
  assert.equal(ch.townGoal, 'center');
  assert.ok(roles.center.has(at(ch)), `in the Center (at ${at(ch)})`);
  const resting = at(ch);
  run(os, 60, () => assert.equal(at(ch), resting, 'rests in place until revived'));
  // Revived: the next turn starts.
  os.setAgentActive(1, true);
  assert.equal(ch.isErrored, false);
  run(os, 30);
  assert.equal(ch.townGoal, undefined, 'working agents follow the upstream FSM');
  assert.equal(at(ch), tileKey(seat.seatCol, seat.seatRow), 'back at its desk');
  assert.equal(ch.state, CharacterState.TYPE);
});

test('two fainted agents rest on different Center tiles', () => {
  const os = new OfficeState(town);
  const a = seatedAgent(os, 1);
  const b = seatedAgent(os, 2);
  for (const id of [1, 2]) {
    os.setAgentActive(id, false);
    os.setAgentError(id);
  }
  run(os, 40);
  assert.ok(os.town!.roles.center.has(at(a)) && os.town!.roles.center.has(at(b)));
  assert.notEqual(at(a), at(b));
});

test('an agent waiting for the user stays at its desk', () => {
  const os = new OfficeState(town);
  const ch = seatedAgent(os, 1);
  const desk = at(ch);
  os.setAgentActive(1, false);
  os.setAgentAwaitingInput(1, true);
  run(os, 30, () => assert.equal(at(ch), desk));
  assert.equal(ch.townGoal, 'stay');
  assert.equal(ch.state, CharacterState.TYPE, 'still seated');
});

test('an agent without a seat appears in the Meadow', () => {
  const os = new OfficeState(town);
  const seats = os.seats.size;
  for (let id = 1; id <= seats + 2; id++) os.addAgent(id, 0, 0, undefined, true);
  const extra = [...os.characters.values()].filter((ch) => !ch.seatId);
  assert.equal(extra.length, 2);
  for (const ch of extra) assert.ok(os.town!.roles.meadow.has(at(ch)), `at ${at(ch)}`);
});

test('an asleep Pokémon naps where it lies in the Meadow', async () => {
  setPokemonThemeEnabled(true);
  const msg = speciesMessage(25);
  installFakeLoader([msg]);
  setPokemonSpecies(msg);
  await flushDecodes();
  const os = new OfficeState(town);
  const ch = seatedAgent(os, 1);
  os.setAgentIdentity(1, { species: 25 });
  os.setAgentActive(1, false);
  run(os, 40);
  assert.ok(os.town!.roles.meadow.has(at(ch)), `in the Meadow (at ${at(ch)})`);
  ch.idleSec = POKEMON_SLEEP_AFTER_SEC;
  run(os, 2); // finish any stroll
  const nap = at(ch);
  run(os, 60, () => assert.equal(at(ch), nap, 'asleep: stays put'));
});

test('a fainted Pokémon walks to the Center with its walk, then faints', () => {
  const has = () => true;
  const ch = {
    isErrored: true,
    state: CharacterState.WALK,
    townGoal: 'center',
    pmdAnim: null,
  } as unknown as Character;
  assert.equal(choosePokemonAnim(ch, has)?.situation, 'walk');
  assert.equal(choosePokemonAnim({ ...ch, state: CharacterState.IDLE }, has)?.situation, 'faint');
  assert.equal(choosePokemonAnim({ ...ch, townGoal: undefined }, has)?.situation, 'faint');
});

test('the classic office keeps the upstream wander: no town goals, anywhere walkable', () => {
  const os = new OfficeState(readBundledLayout(CLASSIC_LAYOUT_PATH));
  const ch = seatedAgent(os, 1);
  os.setAgentActive(1, false);
  os.setAgentError(1);
  run(os, 60, () => assert.equal(ch.townGoal, undefined));
  assert.equal(os.town, null);
});

test('a character the user walks out of the Meadow stays a while, then heads back', () => {
  const os = new OfficeState(town);
  const ch = seatedAgent(os, 1);
  os.setAgentActive(1, false);
  run(os, 40);
  assert.ok(os.town!.roles.meadow.has(at(ch)));
  // A tile on the main street, outside every role area.
  const street = { col: 16, row: 14 };
  assert.ok(os.walkToTile(1, street.col, street.row));
  run(os, 15);
  assert.equal(at(ch), tileKey(street.col, street.row), 'holds the spot it was sent to');
  run(os, TOWN_USER_WALK_HOLD_SEC + 20);
  assert.ok(os.town!.roles.meadow.has(at(ch)), 'then goes back to the Meadow');
});
