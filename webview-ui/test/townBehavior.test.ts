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

import type { AgentLink } from '../../core/src/messages.js';
import {
  AREA_DEFAULT_COLORS,
  POKEMON_SLEEP_AFTER_SEC,
  TOWN_MEADOW_DELAY_SEC,
  TOWN_SPAWN_GRACE_SEC,
  TOWN_USER_WALK_HOLD_SEC,
} from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { choosePokemonAnim } from '../src/office/engine/pokemonAnim.js';
import { setPokemonThemeEnabled } from '../src/office/engine/pokemonTheme.js';
import {
  centerRestTiers,
  pickTieredTile,
  pickTownTile,
  stepTownCharacter,
  townGoalFor,
  townRoomNeeded,
  townSeatMove,
} from '../src/office/engine/townBehavior.js';
import { areaRoleTiles, centerClearance, tileKey } from '../src/office/layout/areaRoles.js';
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

/** A working agent seated at its desk in the town, past its spawn grace. */
function seatedAgent(os: OfficeState, id: number): Character {
  os.addAgent(id, 0, 0, undefined, true);
  const ch = os.characters.get(id)!;
  assert.ok(ch.seatId, 'seated at creation');
  assert.equal(ch.state, CharacterState.TYPE);
  run(os, TOWN_SPAWN_GRACE_SEC + DT);
  assert.equal(ch.townSpawnGrace, undefined);
  return ch;
}

const at = (ch: Character) => tileKey(ch.tileCol, ch.tileRow);

/** In the Meadow, or on its way to a Meadow tile (crossing the south path). */
function inMeadow(os: OfficeState, ch: Character): boolean {
  const meadow = os.town!.roles.meadow;
  const end = ch.path[ch.path.length - 1];
  return end ? meadow.has(tileKey(end.col, end.row)) : meadow.has(at(ch));
}

/** Run until none of `chars` is mid-walk (the Meadow's two halves sit either
 *  side of the south path, so a wanderer may be crossing it). */
function settle(os: OfficeState, ...chars: Character[]): void {
  for (let t = 0; t < 30 && chars.some((c) => c.state === CharacterState.WALK); t += DT) {
    os.update(DT);
  }
}

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
  const meadowOnly = { ...roles!, center: new Set<string>() };
  assert.equal(townGoalFor({ ...base, isErrored: true }, meadowOnly), null, 'no Center');
  const centerOnly = { ...roles!, meadow: new Set<string>() };
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
  settle(os, ch);
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
  const desks = os.seats.size - os.town!.lecternSeats.size;
  for (let id = 1; id <= desks + 2; id++) os.addAgent(id, 0, 0, undefined, true);
  const extra = [...os.characters.values()].filter((ch) => !ch.seatId);
  assert.equal(extra.length, 2, 'the lectern is kept for Leads');
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
  settle(os, ch);
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
  settle(os, ch);
  assert.ok(os.town!.roles.meadow.has(at(ch)));
  // A tile on the main street, outside every role area.
  const street = { col: 16, row: 16 };
  assert.ok(os.walkToTile(1, street.col, street.row));
  run(os, 15);
  assert.equal(at(ch), tileKey(street.col, street.row), 'holds the spot it was sent to');
  run(os, TOWN_USER_WALK_HOLD_SEC + 20);
  settle(os, ch);
  assert.ok(os.town!.roles.meadow.has(at(ch)), 'then goes back to the Meadow');
});

// ── Arriving, beds, desks and the lectern ───────────────────────

test('a session that turns out idle or fainted as it is created appears in its area', () => {
  const os = new OfficeState(town);
  const { roles, restSpots } = os.town!;
  os.addAgent(1, 0, 0); // with the spawn effect, as a new session arrives
  os.addAgent(2, 0, 0);
  const idle = os.characters.get(1)!;
  const fainted = os.characters.get(2)!;
  const desk = idle.seatId;
  os.setAgentActive(1, false);
  os.setAgentActive(2, false);
  os.setAgentError(2, 'overloaded');
  os.update(DT);
  assert.ok(idle.matrixEffect, 'still opening its Poké Ball');
  assert.ok(roles.meadow.has(at(idle)), `opens in the Meadow (at ${at(idle)})`);
  assert.equal(idle.seatId, desk, 'keeps its desk for when it works');
  const beds = new Set(restSpots.map((t) => tileKey(t.col, t.row)));
  assert.ok(beds.has(at(fainted)), `opens on a Center bed (at ${at(fainted)})`);
  run(os, 20, () => {
    const end = idle.path[idle.path.length - 1];
    if (end) assert.ok(roles.meadow.has(tileKey(end.col, end.row)), 'heads only into the Meadow');
    else assert.ok(roles.meadow.has(at(idle)), 'never walks in from the Lab');
  });
});

test('a session that is working as it is created stays at its desk', () => {
  const os = new OfficeState(town);
  os.addAgent(1, 0, 0);
  const ch = os.characters.get(1)!;
  const seat = os.seats.get(ch.seatId!)!;
  run(os, TOWN_SPAWN_GRACE_SEC + 1);
  assert.equal(at(ch), tileKey(seat.seatCol, seat.seatRow));
  // Going idle later is an ordinary walk out, not a jump.
  os.setAgentActive(1, false);
  os.update(DT);
  assert.equal(at(ch), tileKey(seat.seatCol, seat.seatRow), 'no jump once settled');
});

test('the Center has beds; a fainted agent lies on the most central side of one', () => {
  const os = new OfficeState(town);
  const world = os.town!;
  assert.ok(world.restSpots.length >= 4, `${world.restSpots.length} bed tiles`);
  const tiers = centerRestTiers(world, 0);
  const clear = (t: { col: number; row: number }) =>
    world.centerClearance.get(tileKey(t.col, t.row))!;
  assert.ok(tiers[0].length >= 4, 'one tile per bed first');
  for (const t of tiers[0]) assert.equal(clear(t), 1, 'the side away from the wall');
  const ch = seatedAgent(os, 1);
  os.setAgentActive(1, false);
  os.setAgentError(1);
  run(os, 30);
  assert.ok(
    tiers[0].some((t) => tileKey(t.col, t.row) === at(ch)),
    `rests on a bed (at ${at(ch)})`,
  );
});

test('a wide fainted sprite rests clear of the Center walls', () => {
  const os = new OfficeState(town);
  const world = os.town!;
  // Spills two tiles each side: no bed fits, so the widest Center tiles.
  const tiers = centerRestTiers(world, 2);
  for (const tier of tiers) {
    for (const t of tier) assert.ok(world.centerClearance.get(tileKey(t.col, t.row))! >= 2);
  }
  const ch = seatedAgent(os, 1);
  os.setAgentActive(1, false);
  os.setAgentError(1);
  ch.townGoal = 'center';
  const occupied = () => new Set<string>();
  for (let t = 0; t < 40; t += DT) {
    stepTownCharacter(ch, DT, 'center', world, { asleep: false, occupied, clearance: 2 });
  }
  assert.ok(world.roles.center.has(at(ch)), `in the Center (at ${at(ch)})`);
  assert.ok(world.centerClearance.get(at(ch))! >= 2, `clear of the walls (at ${at(ch)})`);
  // Moved onto a bed by hand, it gets up and finds a wider spot.
  const bed = world.restSpots[0];
  Object.assign(ch, {
    tileCol: bed.col,
    tileRow: bed.row,
    x: bed.col * 16 + 8,
    y: bed.row * 16 + 8,
    townRetryTimer: 0,
  });
  for (let t = 0; t < 30; t += DT) {
    stepTownCharacter(ch, DT, 'center', world, { asleep: false, occupied, clearance: 2 });
  }
  assert.ok(world.centerClearance.get(at(ch))! >= 2, `moved off the bed (at ${at(ch)})`);
});

test('a wide fainted Pokémon (measured on its Faint pose) rests clear of the walls', async () => {
  setPokemonThemeEnabled(true);
  const wide = speciesMessage(493, {
    anims: {
      Idle: {
        frameWidth: 40,
        frameHeight: 56,
        durations: [40],
        box: { x0: 8, y0: 20, x1: 31, y1: 35 },
      },
      Faint: { frameWidth: 96, frameHeight: 64, durations: [4, 4, 4] },
    },
  });
  // The held (last) Faint frame of the Down row reaches 44 px each side.
  installFakeLoader([wide], { boxes: { Faint: { x0: 192 + 4, y0: 30, x1: 192 + 91, y1: 45 } } });
  setPokemonSpecies(wide);
  await flushDecodes();
  const os = new OfficeState(town);
  const ch = seatedAgent(os, 1);
  os.setAgentIdentity(1, { species: 493 });
  os.setAgentActive(1, false);
  os.setAgentError(1);
  run(os, 40);
  assert.ok(os.town!.roles.center.has(at(ch)), `in the Center (at ${at(ch)})`);
  // 44 px each side: two tiles of Center beside it (a few px may touch a wall).
  assert.equal(townRoomNeeded(44), 2);
  assert.ok(os.town!.centerClearance.get(at(ch))! >= 2, `two tiles from each wall (at ${at(ch)})`);
  assert.ok(
    !os.town!.restSpots.some((t) => tileKey(t.col, t.row) === at(ch)),
    'no bed is wide enough',
  );
});

test('a working agent with no desk takes the desk of one that is away in the Meadow', () => {
  const os = new OfficeState(town);
  const desks = os.seats.size - os.town!.lecternSeats.size;
  for (let id = 1; id <= desks; id++) seatedAgent(os, id);
  for (let id = 1; id <= desks; id++) os.setAgentActive(id, false);
  run(os, 40);
  for (let id = 1; id <= desks; id++) {
    assert.ok(inMeadow(os, os.characters.get(id)!), `${id} is in the Meadow`);
  }
  // Two more sessions: no free desk, so they appear in the Meadow, seatless.
  os.addAgent(desks + 1, 0, 0, undefined, true);
  os.addAgent(desks + 2, 0, 0, undefined, true);
  const late = os.characters.get(desks + 1)!;
  assert.equal(late.seatId, null);
  run(os, TOWN_SPAWN_GRACE_SEC + DT);
  // It starts working: it claims a desk someone napping in the Meadow held.
  os.setAgentActive(desks + 1, true);
  run(os, 40);
  assert.ok(late.seatId, 'has a desk');
  assert.ok(!os.town!.lecternSeats.has(late.seatId), 'not the lectern');
  const seat = os.seats.get(late.seatId)!;
  assert.equal(at(late), tileKey(seat.seatCol, seat.seatRow), 'sitting at it');
  assert.equal(late.state, CharacterState.TYPE, 'working at the desk, not in the Meadow');
  const holders = [...os.characters.values()].filter((c) => c.seatId === late.seatId);
  assert.equal(holders.length, 1, 'the desk has one holder');
  const unseated = [...os.characters.values()].filter((c) => !c.seatId);
  assert.equal(
    unseated.length,
    2,
    'the one it displaced is now seatless (plus the other late one)',
  );
  assert.ok(unseated.every((c) => !c.isActive));
});

test('Leads take the lectern; other sessions never sit there', () => {
  const os = new OfficeState(town);
  const lectern = os.town!.lecternSeats;
  assert.equal(lectern.size, 2);
  for (let id = 1; id <= 6; id++) seatedAgent(os, id);
  for (const ch of os.characters.values()) assert.ok(!lectern.has(ch.seatId!), 'desks first');
  // Agent 3 turns out to be a Lead while working: it walks to the lectern.
  os.setTeamInfo(3, undefined, undefined, true);
  run(os, 30);
  const lead = os.characters.get(3)!;
  assert.ok(lead.seatId && lectern.has(lead.seatId), 'on the lectern');
  const seat = os.seats.get(lead.seatId)!;
  assert.equal(at(lead), tileKey(seat.seatCol, seat.seatRow));
  assert.equal(lead.state, CharacterState.TYPE);
  // A Lead that is away gets the other lectern seat without walking in.
  os.setAgentActive(4, false);
  run(os, 30);
  const away = os.characters.get(4)!;
  assert.ok(inMeadow(os, away));
  os.setTeamInfo(4, undefined, undefined, true);
  os.update(DT);
  assert.ok(away.seatId && lectern.has(away.seatId), 'its claim moved to the lectern');
  assert.ok(inMeadow(os, away), 'still in the Meadow, not walking in');
  // A third Lead keeps its desk: the lectern is full of Leads.
  os.setTeamInfo(5, undefined, undefined, true);
  run(os, 5);
  assert.ok(!lectern.has(os.characters.get(5)!.seatId!));
});

test('a non-Lead restored onto a lectern seat moves to a desk', () => {
  const os = new OfficeState(town);
  const [uid] = os.town!.lecternSeats;
  os.addAgent(1, 0, 0, uid, true);
  const ch = os.characters.get(1)!;
  assert.equal(ch.seatId, uid, 'a saved seat is honoured at first');
  run(os, 20);
  assert.ok(ch.seatId && !os.town!.lecternSeats.has(ch.seatId), 'then it moves to a desk');
});

test('townSeatMove: the seat rules on their own', () => {
  const lectern = new Set(['L1']);
  const first = (free: string[]) => free[0] ?? null;
  const away = { id: 9, isActive: false, isTeamLead: false, townGoal: 'meadow' as const };
  const busy = { id: 8, isActive: true, isTeamLead: false, townGoal: undefined };
  const base = { id: 1, isActive: true, isTeamLead: false, seatId: null, isSubagent: false };
  const seats = [
    { uid: 'L1', holder: null },
    { uid: 'D1', holder: busy },
    { uid: 'D2', holder: away },
  ];
  assert.equal(townSeatMove(base, seats, lectern, first), 'D2', 'an away desk when none is free');
  const allBusy = [seats[0], seats[1], { uid: 'D2', holder: { ...busy, id: 7 } }];
  assert.equal(townSeatMove(base, allBusy, lectern, first), null, 'never a working one');
  assert.equal(townSeatMove({ ...base, isTeamLead: true }, seats, lectern, first), 'L1');
  assert.equal(townSeatMove({ ...base, isActive: false }, seats, lectern, first), null);
  assert.equal(townSeatMove({ ...base, isSubagent: true }, seats, lectern, first), null);
});

test('pickTieredTile takes the first tier with room, else the first tier', () => {
  const a = { col: 0, row: 0 };
  const b = { col: 1, row: 0 };
  const c = { col: 2, row: 0 };
  assert.deepEqual(pickTieredTile([[a], [b, c]], new Set(['0,0', '1,0'])), c);
  assert.deepEqual(pickTieredTile([[a], [b]], new Set(['0,0', '1,0'])), a);
  assert.equal(pickTieredTile([[], []], new Set()), null);
});

test('centerClearance counts Center tiles to the nearer side', () => {
  const row = new Set(['0,0', '1,0', '2,0', '3,0', '4,0']);
  const clear = centerClearance(row);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((c) => clear.get(`${c},0`)),
    [0, 1, 2, 1, 0],
  );
});

test('editing the town keeps characters that are away where they are', () => {
  const os = new OfficeState(town);
  const ch = seatedAgent(os, 1);
  os.setAgentActive(1, false);
  run(os, 30);
  settle(os, ch);
  const spot = at(ch);
  assert.ok(os.town!.roles.meadow.has(spot));
  os.rebuildFromLayout({ ...town });
  assert.equal(at(ch), spot, 'not snapped back to its desk');
  assert.ok(ch.seatId, 'still holds its desk');
});

test('in the town, links are faint unless their family is hovered or selected', () => {
  const os = new OfficeState(town);
  for (let id = 1; id <= 4; id++) seatedAgent(os, id);
  os.setTeamInfo(2, undefined, 'a', false, 1);
  os.setTeamInfo(3, undefined, 'b', false, 1);
  const link = (fromId: number, toId: number, kind: AgentLink['kind']): AgentLink => ({
    fromId,
    toId,
    kind,
    count: 1,
    lastAt: 0,
  });
  os.setLinks([link(1, 2, 'spawned'), link(1, 3, 'spawned'), link(4, 2, 'messaged')]);
  const dims = () =>
    os.getLinkSegments().map((l) => `${l.from.id}-${l.to.id}:${l.dim ? 'dim' : 'lit'}`);
  assert.deepEqual(dims(), ['1-2:dim', '1-3:dim', '4-2:dim']);
  os.hoveredAgentId = 3; // a child: its Lead's whole fan lights up
  assert.deepEqual(dims(), ['1-2:lit', '1-3:lit', '4-2:dim']);
  os.hoveredAgentId = null;
  os.selectedAgentId = 4;
  assert.deepEqual(dims(), ['1-2:dim', '1-3:dim', '4-2:lit']);
  const classic = new OfficeState(readBundledLayout(CLASSIC_LAYOUT_PATH));
  for (let id = 1; id <= 2; id++) classic.addAgent(id, 0, 0, undefined, true);
  classic.setLinks([link(1, 2, 'spawned')]);
  assert.equal(classic.getLinkSegments()[0].dim, undefined, 'the classic office is unchanged');
});

test('a wide Pokémon at a desk beside a wall moves to a desk with room', async () => {
  setPokemonThemeEnabled(true);
  // Standing body reaches 30 px each side of its ground point.
  const wide = speciesMessage(130, {
    anims: {
      Idle: {
        frameWidth: 64,
        frameHeight: 56,
        durations: [40],
        box: { x0: 2, y0: 10, x1: 61, y1: 35 },
      },
    },
  });
  installFakeLoader([wide]);
  setPokemonSpecies(wide);
  await flushDecodes();
  const os = new OfficeState(town);
  const room = os.town!.seatRoom;
  const cramped = [...os.seats.keys()].find((uid) => room.get(uid) === 0)!;
  assert.ok(cramped, 'the Lab has desks against its side walls');
  os.addAgent(1, 0, 0, cramped, true);
  os.setAgentIdentity(1, { species: 130 });
  const ch = os.characters.get(1)!;
  run(os, 20);
  assert.ok(ch.seatId && room.get(ch.seatId)! >= townRoomNeeded(30), `roomier desk (${ch.seatId})`);
  const seat = os.seats.get(ch.seatId)!;
  assert.equal(at(ch), tileKey(seat.seatCol, seat.seatRow), 'working there');
  assert.equal(os.seats.get(cramped)!.assigned, false, 'the cramped desk is free again');
});
