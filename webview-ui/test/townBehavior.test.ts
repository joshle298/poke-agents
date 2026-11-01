/**
 * Area roles and where characters go in the Pokémon Town as v0.4 shipped it
 * (a Lab of desks with a lectern, no `lab` or `field` roles: what a user who
 * edited that town keeps): working agents sit at the Lab's desks, idle ones
 * walk out to the Meadow and wander only there, asleep ones nap where they
 * lie, fainted ones walk to the Pokémon Center and rest until revived, then go
 * back to their desks. A layout without roles (the classic office) leaves
 * every character to the upstream FSM. The zoned town (Leads in the Lab,
 * everyone else outdoors) is in townZones.test.ts.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import type { AgentLink } from '../../core/src/messages.js';
import {
  AREA_DEFAULT_COLORS,
  BED_BOARD_PX,
  BED_PILLOW_INSET_PX,
  SLEEP_AFTER_MS,
  SLEEP_DROWSY_MS,
  TOWN_MEADOW_DELAY_SEC,
  TOWN_SPAWN_GRACE_SEC,
  TOWN_SPREAD_TILES,
  TOWN_USER_WALK_HOLD_SEC,
} from '../src/constants.js';
import { msUntilAsleep } from '../src/office/asleep.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { choosePokemonAnim } from '../src/office/engine/pokemonAnim.js';
import {
  bedLieOf,
  bodyTopY,
  drawnBody,
  linkEnd,
  pokemonDrawPlace,
  pokemonGroundY,
} from '../src/office/engine/pokemonCharacter.js';
import { setPokemonThemeEnabled } from '../src/office/engine/pokemonTheme.js';
import type { RestFit, TownBed } from '../src/office/engine/townBehavior.js';
import {
  centerRestTiers,
  pickTieredTile,
  pickTownTile,
  stepTownCharacter,
  townGoalFor,
  townPath,
  townRoomNeeded,
  townSeatMove,
} from '../src/office/engine/townBehavior.js';
import { areaRoleTiles, centerClearance, tileKey } from '../src/office/layout/areaRoles.js';
import { setPokemonSpecies } from '../src/office/sprites/pokemonSprites.js';
import type { Character, OfficeLayout } from '../src/office/types.js';
import { CharacterState, Direction, TileType } from '../src/office/types.js';
import {
  DEFAULT_ANIMS,
  flushDecodes,
  installFakeLoader,
  resetPokemonStore,
  speciesMessage,
} from './pokemonFixtures.js';
import {
  CLASSIC_LAYOUT_PATH,
  LEGACY_TOWN_LAYOUT_PATH,
  loadBundledCatalog,
  readBundledLayout,
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
  town = readBundledLayout(LEGACY_TOWN_LAYOUT_PATH);
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

/** The office's sleep facts for agent 1 on a test clock that `run` advances. */
function sleepClock(os: OfficeState) {
  const clock = {
    now: 5_000_000,
    facts: null as { resting: boolean; lastActivityAt: number } | null,
  };
  os.wallClock = () => clock.now;
  os.setSleepClock((id, now) =>
    id === 1 && clock.facts
      ? msUntilAsleep(clock.facts.resting, clock.facts.lastActivityAt, now)
      : null,
  );
  return clock;
}

function runClocked(os: OfficeState, clock: { now: number }, seconds: number, each?: () => void) {
  for (let t = 0; t < seconds; t += DT) {
    clock.now += DT * 1000;
    os.update(DT);
    each?.();
  }
}

test('an asleep Pokémon naps where it lies in the Meadow', async () => {
  setPokemonThemeEnabled(true);
  const msg = speciesMessage(25);
  installFakeLoader([msg]);
  setPokemonSpecies(msg);
  await flushDecodes();
  const os = new OfficeState(town);
  const clock = sleepClock(os);
  const ch = seatedAgent(os, 1);
  os.setAgentIdentity(1, { species: 25 });
  os.setAgentActive(1, false);
  clock.facts = { resting: true, lastActivityAt: clock.now };
  runClocked(os, clock, 40);
  settle(os, ch);
  assert.ok(os.town!.roles.meadow.has(at(ch)), `in the Meadow (at ${at(ch)})`);
  clock.now += SLEEP_AFTER_MS;
  runClocked(os, clock, 0.2);
  assert.equal(ch.asleep, true);
  const nap = { tile: at(ch), x: ch.x, y: ch.y };
  runClocked(os, clock, 120, () =>
    assert.deepEqual({ tile: at(ch), x: ch.x, y: ch.y }, nap, 'asleep: never moves'),
  );
  assert.equal(choosePokemonAnim(ch, () => true)?.anim, 'Sleep');
});

test('about to fall asleep at its desk, a Pokémon walks to the Meadow first, then never moves', async () => {
  setPokemonThemeEnabled(true);
  const msg = speciesMessage(25);
  installFakeLoader([msg]);
  setPokemonSpecies(msg);
  await flushDecodes();
  const os = new OfficeState(town);
  const clock = sleepClock(os);
  const ch = seatedAgent(os, 1);
  os.setAgentIdentity(1, { species: 25 });
  os.setAgentActive(1, false);
  // Done long ago but only now let go of its desk: drowsy at once.
  clock.facts = { resting: true, lastActivityAt: clock.now - SLEEP_AFTER_MS + SLEEP_DROWSY_MS };
  let asleepAt: string | null = null;
  runClocked(os, clock, SLEEP_DROWSY_MS / 1000 + 30, () => {
    if (!ch.asleep) return;
    asleepAt ??= at(ch);
    assert.equal(at(ch), asleepAt, 'once asleep it never moves');
    assert.notEqual(ch.state, CharacterState.WALK);
  });
  assert.equal(ch.asleep, true);
  assert.ok(os.town!.roles.meadow.has(at(ch)), `asleep in the Meadow (at ${at(ch)})`);
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
  const { roles, beds } = os.town!;
  os.addAgent(1, 0, 0); // with the spawn effect, as a new session arrives
  os.addAgent(2, 0, 0);
  const idle = os.characters.get(1)!;
  const fainted = os.characters.get(2)!;
  const desk = idle.seatId;
  os.setAgentActive(1, false);
  os.setAgentActive(2, false);
  os.setAgentError(2, 'overloaded');
  os.update(DT);
  assert.ok(idle.matrixEffect, 'still opening its orb');
  assert.ok(roles.meadow.has(at(idle)), `opens in the Meadow (at ${at(idle)})`);
  assert.equal(idle.seatId, desk, 'keeps its desk for when it works');
  const bedSpots = new Set(beds.map((b) => tileKey(b.rest.col, b.rest.row)));
  assert.ok(bedSpots.has(at(fainted)), `opens on a Center bed (at ${at(fainted)})`);
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

test('the Center has beds; a fainted agent lies in one, its head on the pillow', () => {
  const os = new OfficeState(town);
  const world = os.town!;
  assert.equal(world.beds.length, 4, 'four beds');
  for (const bed of world.beds) {
    // The pillow is at the wall end; the sleeper stands at the other end.
    const clear = (col: number) => world.centerClearance.get(tileKey(col, bed.rest.row))!;
    const pillowCol = bed.pillow === 'left' ? bed.rest.col - 2 : bed.rest.col + 2;
    assert.equal(clear(pillowCol), 0, 'the pillow end is against a side wall');
    assert.equal(clear(bed.rest.col), 2, 'the sleeper stands at the foot, two tiles in');
    assert.deepEqual([bed.w, bed.h], [48, 32], 'three tiles long, two deep');
    assert.equal(bed.midX, bed.x + bed.w / 2);
    assert.ok(bed.blanket, 'a blanket to tuck it in');
  }
  const tiers = centerRestTiers(world);
  assert.equal(tiers[0].length, 4, 'every bed first');
  const ch = seatedAgent(os, 1);
  os.setAgentActive(1, false);
  os.setAgentError(1);
  run(os, 30);
  const bed = world.beds.find((b) => tileKey(b.rest.col, b.rest.row) === at(ch));
  assert.ok(bed, `rests on a bed (at ${at(ch)})`);
  assert.equal(ch.bedRest, bed, 'lies in it');
  assert.equal(ch.x, bed.midX, 'on the bed, not on its tile');
  assert.equal(ch.dir, bed.pillow === 'left' ? Direction.LEFT : Direction.RIGHT, 'head to pillow');
  // Revived, it gets out of bed and walks back to work from its tile.
  os.setAgentActive(1, true);
  os.update(DT);
  assert.equal(ch.bedRest, undefined, 'out of bed');
  run(os, 20);
  const seat = os.seats.get(ch.seatId!)!;
  assert.equal(at(ch), tileKey(seat.seatCol, seat.seatRow), 'back at its desk');
});

test('fainted agents spread over the beds before sharing a stack', () => {
  const os = new OfficeState(town);
  for (let id = 1; id <= 2; id++) seatedAgent(os, id);
  for (let id = 1; id <= 2; id++) {
    os.setAgentActive(id, false);
    os.setAgentError(id);
  }
  run(os, 40);
  const bedOf = (id: number) => os.characters.get(id)!.bedRest as TownBed | undefined;
  const [a, b] = [bedOf(1), bedOf(2)];
  assert.ok(a && b && a !== b, 'two beds');
  assert.ok(a.above !== b && a.below !== b, 'not one above the other');
});

test('centerRestTiers: a tall sleeper never lies over a taken bed, nor anyone under one', () => {
  const os = new OfficeState(town);
  const world = os.town!;
  const lower = world.beds.find((b) => b.above)!;
  const upper = lower.above!;
  assert.ok(Number.isFinite(lower.headroom) && lower.headroom > 0, `headroom ${lower.headroom}`);
  const key = (b: TownBed) => tileKey(b.rest.col, b.rest.row);
  const spots = (tiers: Array<Array<{ col: number; row: number }>>) =>
    new Set(tiers.flat().map((t) => tileKey(t.col, t.row)));
  const tall: RestFit = { halfW: 8, rise: lower.headroom + 1 };
  const short: RestFit = { halfW: 8, rise: 4 };
  // The bed above is taken: a tall sleeper skips the bed under it.
  const upperTaken = new Map([[key(upper), 4]]);
  assert.ok(!spots(centerRestTiers(world, tall, upperTaken)).has(key(lower)));
  assert.ok(spots(centerRestTiers(world, short, upperTaken)).has(key(lower)), 'a short one fits');
  // A tall sleeper lies below: nobody takes the bed it covers.
  const lowerTakenTall = new Map([[key(lower), lower.headroom + 1]]);
  assert.ok(!spots(centerRestTiers(world, short, lowerTakenTall)).has(key(upper)));
  const lowerTakenShort = new Map([[key(lower), 4]]);
  assert.ok(spots(centerRestTiers(world, short, lowerTakenShort)).has(key(upper)));
  // Beds whose stack is empty come first.
  const first = centerRestTiers(world, short, lowerTakenShort)[0];
  assert.ok(!first.some((t) => tileKey(t.col, t.row) === key(upper)), 'a lone bed first');
});

test('a wide fainted sprite rests on the floor, clear of the Center walls', () => {
  const os = new OfficeState(town);
  const world = os.town!;
  // Reaches 40 px each side: wider than any bed, two tiles of room needed.
  const wide: RestFit = { halfW: 40, rise: 10 };
  assert.equal(townRoomNeeded(40), 2);
  const tiers = centerRestTiers(world, wide);
  for (const tier of tiers) {
    for (const t of tier) {
      assert.ok(world.centerClearance.get(tileKey(t.col, t.row))! >= 2);
      assert.ok(!world.bedTiles.has(tileKey(t.col, t.row)), 'not on a bed');
    }
  }
  const ch = seatedAgent(os, 1);
  os.setAgentActive(1, false);
  os.setAgentError(1);
  ch.townGoal = 'center';
  const occupied = () => new Set<string>();
  for (let t = 0; t < 40; t += DT) {
    stepTownCharacter(ch, DT, 'center', world, { asleep: false, occupied, fit: wide });
  }
  assert.ok(world.roles.center.has(at(ch)), `in the Center (at ${at(ch)})`);
  assert.ok(world.centerClearance.get(at(ch))! >= 2, `clear of the walls (at ${at(ch)})`);
  assert.equal(ch.bedRest, undefined, 'not in a bed');
  // Moved onto a bed by hand, it gets up and finds a wider spot.
  const bed = world.beds[0].rest;
  Object.assign(ch, {
    tileCol: bed.col,
    tileRow: bed.row,
    x: bed.col * 16 + 8,
    y: bed.row * 16 + 8,
    townRetryTimer: 0,
  });
  for (let t = 0; t < 30; t += DT) {
    stepTownCharacter(ch, DT, 'center', world, { asleep: false, occupied, fit: wide });
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
  assert.equal(ch.bedRest, undefined, 'no bed is wide enough');
});

test("a sleeper's FNT chip hangs just over its lying pose, in the row it lies in", async () => {
  setPokemonThemeEnabled(true);
  // Standing, the body rises 12 px; lying (the held Faint frame) only 6 px,
  // 20 px each side, in the Down, Right and Left rows.
  const mon = speciesMessage(25, {
    anims: { ...DEFAULT_ANIMS, Faint: { frameWidth: 48, frameHeight: 64, durations: [4, 4, 4] } },
  });
  const lying = (row: number) => ({
    x0: 96 + 4,
    y0: row * 64 + 30,
    x1: 96 + 43,
    y1: row * 64 + 37,
  });
  installFakeLoader([mon], { boxes: { Faint: [lying(0), lying(2), lying(6)] } });
  setPokemonSpecies(mon);
  await flushDecodes();
  const os = new OfficeState(town);
  const ch = seatedAgent(os, 1);
  os.setAgentIdentity(1, { species: 25 });
  os.setAgentActive(1, false);
  os.setAgentError(1);
  run(os, 30);
  assert.ok(ch.bedRest, `in bed (at ${at(ch)})`);
  ch.pmdAnim = null; // the hurt flinch is over: the held faint shows
  const ground = pokemonGroundY(ch);
  assert.equal(bodyTopY(ch), ground - 6, 'the top of the lying pose');
  assert.notEqual(bodyTopY(ch), ground - 12, 'not the standing head a row above');
  const box = drawnBody(ch)!;
  assert.equal(box.right - box.left, 40, 'the click box is the lying pose too');
  // A wide pose lies as drawn. 40 px is longer than the mattress between the
  // boards (38 px): it lies centred, over both boards alike.
  const bed = ch.bedRest;
  assert.equal(pokemonDrawPlace(ch).turn, 0, 'not turned');
  assert.equal(bed.w - 2 * BED_BOARD_PX, 38);
  assert.equal(box.left - bed.x, bed.x + bed.w - box.right, 'centred');
  assert.ok(box.top >= bed.y && box.bottom <= bed.y + bed.h, 'within the bed, top to bottom');
});

test('a Pokémon whose faint is an upright frame lies on its side in bed, head to the pillow', async () => {
  setPokemonThemeEnabled(true);
  // No Faint: the faint falls back to Sleep, held on its last frame: an
  // upright coil 16 wide and 28 tall (32×40 frames, ground point 24 px down:
  // it rises 22 px and drops 6).
  const anims = Object.fromEntries(Object.entries(DEFAULT_ANIMS).filter(([n]) => n !== 'Faint'));
  const coil = speciesMessage(148, { anims });
  installFakeLoader([coil], { boxes: { Sleep: { x0: 32 + 8, y0: 2, x1: 32 + 23, y1: 29 } } });
  setPokemonSpecies(coil);
  await flushDecodes();
  const os = new OfficeState(town);
  const ch = seatedAgent(os, 1);
  os.setAgentIdentity(1, { species: 148 });
  os.setAgentActive(1, false);
  os.setAgentError(1);
  run(os, 30);
  const bed = ch.bedRest;
  assert.ok(bed, `in bed (at ${at(ch)})`);
  ch.pmdAnim = null;
  const lie = bedLieOf(ch)!;
  assert.equal(lie.turn, bed.pillow === 'left' ? -1 : 1, 'turned, its top to the pillow');
  assert.equal(pokemonDrawPlace(ch).turn, lie.turn, 'drawn turned');
  const box = drawnBody(ch)!;
  assert.equal(box.right - box.left, 28, 'lying, it is as long as it stood tall');
  assert.equal(box.bottom - box.top, 16, 'and as deep as it was wide');
  assert.ok(box.left >= bed.x + BED_BOARD_PX, 'inside the head board');
  assert.ok(box.right <= bed.x + bed.w - BED_BOARD_PX, 'inside the foot board');
  assert.ok(box.top >= bed.y, 'not over the head board');
  const head = bed.pillow === 'left' ? box.left : box.right;
  const pillowEdge =
    bed.pillow === 'left' ? bed.x + BED_PILLOW_INSET_PX : bed.x + bed.w - BED_PILLOW_INSET_PX;
  assert.equal(head, pillowEdge, 'its head on the pillow');
});

test('a link ends on a seated Pokémon’s body, not on the chair under it', async () => {
  setPokemonThemeEnabled(true);
  installFakeLoader([speciesMessage(25)]);
  setPokemonSpecies(speciesMessage(25));
  await flushDecodes();
  const os = new OfficeState(town);
  const ch = seatedAgent(os, 1);
  os.setAgentIdentity(1, { species: 25 });
  assert.equal(ch.state, CharacterState.TYPE, 'seated');
  const end = linkEnd(ch);
  assert.equal(end.x, ch.x);
  assert.ok(end.y < ch.y, `on the body (${end.y}), above the chair's centre (${ch.y})`);
  assert.ok(end.y > bodyTopY(ch), 'below the top of its head');
  // Theme off, a seated human sits over its own tile: the link ends there.
  setPokemonThemeEnabled(false);
  assert.deepEqual(linkEnd(ch), { x: ch.x, y: ch.y });
});

test("an asleep Pokémon's bubble sits on its sleeping pose, not its standing head", async () => {
  setPokemonThemeEnabled(true);
  // Sleep frames are 32×40 (ground point 24 px down); the curled body rises 6 px.
  installFakeLoader([speciesMessage(25)], { boxes: { Sleep: { x0: 8, y0: 18, x1: 23, y1: 25 } } });
  setPokemonSpecies(speciesMessage(25));
  await flushDecodes();
  const os = new OfficeState(town);
  const ch = seatedAgent(os, 1);
  os.setAgentIdentity(1, { species: 25 });
  os.setAgentActive(1, false);
  run(os, 40);
  settle(os, ch);
  ch.asleep = true;
  assert.equal(bodyTopY(ch), pokemonGroundY(ch) - 6);
});

test('theme off, a fainted human lies in bed too, on the mattress, head on the pillow', () => {
  const os = new OfficeState(town);
  const ch = seatedAgent(os, 1);
  os.setAgentActive(1, false);
  os.setAgentError(1);
  run(os, 30);
  const bed = ch.bedRest;
  assert.ok(bed, `in bed (at ${at(ch)})`);
  assert.equal(ch.x, bed.midX);
  // Turned on its side: longer than deep, between the boards, its head on the
  // pillow and its feet clear of the foot board.
  const lie = bedLieOf(ch)!;
  assert.equal(lie.turn, bed.pillow === 'left' ? -1 : 1);
  const box = drawnBody(ch)!;
  assert.ok(box.right - box.left > box.bottom - box.top, 'lying down');
  assert.ok(box.left >= bed.x + BED_BOARD_PX && box.right <= bed.x + bed.w - BED_BOARD_PX);
  assert.ok(box.top >= bed.y, 'its hair under the top of the head board');
  if (bed.pillow === 'left') assert.equal(box.left, bed.x + BED_PILLOW_INSET_PX);
  else assert.equal(box.right, bed.x + bed.w - BED_PILLOW_INSET_PX);
  assert.equal(bodyTopY(ch), box.top, 'its overlays hang over the lying body');
});

test('town walks keep out from under the forest: into the garden by its opening', () => {
  const os = new OfficeState(town);
  const world = os.town!;
  const walker = { tileCol: 24, tileRow: 22 } as Character;
  const path = townPath(walker, { col: 27, row: 22 }, world);
  assert.ok(path.length > 0, 'a way in');
  for (const t of path) {
    assert.ok(!world.pathBlocked.has(tileKey(t.col, t.row)), `(${t.col},${t.row}) is open ground`);
    assert.ok(t.row <= 22, `(${t.col},${t.row}) is not in the forest`);
  }
  assert.ok(
    path.some((t) => t.col === 25 && t.row === 19),
    'through the opening by the signpost',
  );
  // Already in under the canopy (a right-click walk), it still finds its way out.
  const lost = { tileCol: 26, tileRow: 24 } as Character;
  assert.ok(world.pathBlocked.has(tileKey(26, 24)), 'the forest edge is off the town paths');
  assert.ok(townPath(lost, { col: 27, row: 22 }, world).length > 0, 'and out again');
});

test('pickTownTile prefers a tile two or more from everyone, then any free one', () => {
  const tiles = [0, 1, 2, 3, 4, 5].map((col) => ({ col, row: 0 }));
  const occupied = new Set(['0,0', '5,0']);
  for (let i = 0; i < 20; i++) {
    const t = pickTownTile(tiles, occupied)!;
    assert.ok(t.col >= 2 && t.col <= 3, `spread out (${t.col})`);
  }
  const crowded = new Set(['0,0', '2,0', '4,0']);
  for (let i = 0; i < 20; i++) {
    const t = pickTownTile(tiles, crowded)!;
    assert.ok(!crowded.has(tileKey(t.col, t.row)), 'still a free tile');
  }
});

test('idle Pokémon spread out over the Meadow instead of clumping', () => {
  const os = new OfficeState(town);
  const n = 8;
  const chars = Array.from({ length: n }, (_, i) => seatedAgent(os, i + 1));
  for (let id = 1; id <= n; id++) os.setAgentActive(id, false);
  // Where each settles: the tile it is walking to, else the one it stands on.
  const settled = (ch: Character) =>
    ch.path[ch.path.length - 1] ?? { col: ch.tileCol, row: ch.tileRow };
  const meadow = os.town!.roles.meadow;
  run(os, 120, () => {
    for (const a of chars) {
      const sa = settled(a);
      if (!meadow.has(tileKey(sa.col, sa.row))) continue; // still on its way out
      for (const b of chars) {
        const sb = settled(b);
        if (a.id >= b.id || !meadow.has(tileKey(sb.col, sb.row))) continue;
        const d = Math.max(Math.abs(sa.col - sb.col), Math.abs(sa.row - sb.row));
        assert.ok(
          d >= TOWN_SPREAD_TILES,
          `${sa.col},${sa.row} and ${sb.col},${sb.row}: ${d} apart`,
        );
      }
    }
  });
  for (const ch of chars) assert.ok(inMeadow(os, ch), `in the Meadow (at ${at(ch)})`);
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
