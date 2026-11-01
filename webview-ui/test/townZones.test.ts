/**
 * The zoned Pokémon Town (a Lab and fields among its Area roles): working
 * Leads sit at the Lab's desks, every other working session at a seat in an
 * outdoor work area, or stands and works on a free field (else Meadow) tile
 * when those are taken, and never at a Lab desk; with no Leads the Lab stays
 * empty. Idle sessions still wander the Meadow and fainted ones rest in the
 * Center. Layouts without a Lab or fields keep their rules (townBehavior.test).
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterEach, beforeAll, beforeEach, test } from 'vitest';

import {
  AREA_DEFAULT_COLORS,
  TOWN_MEADOW_DELAY_ZONED_SEC,
  TOWN_SPAWN_GRACE_SEC,
} from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { setPokemonThemeEnabled } from '../src/office/engine/pokemonTheme.js';
import type { SeatHolder } from '../src/office/engine/townBehavior.js';
import {
  pickMeadowTile,
  pickWorkTile,
  townGoalFor,
  zonedSeatMove,
} from '../src/office/engine/townBehavior.js';
import {
  areaRoleTiles,
  isZonedTown,
  tileKey,
  townCameraHome,
} from '../src/office/layout/areaRoles.js';
import type { Character, OfficeLayout } from '../src/office/types.js';
import { CharacterState } from '../src/office/types.js';
import {
  LEGACY_TOWN_LAYOUT_PATH,
  loadBundledCatalog,
  readBundledLayout,
  TOWN_LAYOUT_PATH,
} from './worldFixtures.js';

const realRandom = Math.random;
const DT = 0.1;

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

function run(os: OfficeState, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) os.update(DT);
}

const at = (ch: Character) => tileKey(ch.tileCol, ch.tileRow);

/** A working session, past its spawn grace. */
function worker(os: OfficeState, id: number): Character {
  os.addAgent(id, 0, 0, undefined, true);
  run(os, TOWN_SPAWN_GRACE_SEC + DT);
  return os.characters.get(id)!;
}

/** Seated at its own seat and working there. */
function seatedAt(os: OfficeState, ch: Character): boolean {
  if (!ch.seatId) return false;
  const seat = os.seats.get(ch.seatId)!;
  return at(ch) === tileKey(seat.seatCol, seat.seatRow) && ch.state === CharacterState.TYPE;
}

let town: OfficeLayout;

beforeAll(() => {
  loadBundledCatalog();
  town = readBundledLayout(TOWN_LAYOUT_PATH);
});

beforeEach(() => {
  seedRandom(11);
  setPokemonThemeEnabled(false);
});

afterEach(() => {
  Math.random = realRandom;
  setPokemonThemeEnabled(true);
});

// ── The rules on their own ──────────────────────────────────────

test('only a town with a Lab or fields is zoned; the v0.4 town and roleless layouts are not', () => {
  assert.equal(isZonedTown(areaRoleTiles(town)), true);
  assert.equal(isZonedTown(areaRoleTiles(readBundledLayout(LEGACY_TOWN_LAYOUT_PATH))), false);
  assert.equal(isZonedTown(null), false);
});

test('townGoalFor: a working session with no seat works standing, only in a zoned town', () => {
  const zoned = areaRoleTiles(town)!;
  const legacy = areaRoleTiles(readBundledLayout(LEGACY_TOWN_LAYOUT_PATH))!;
  const working = {
    isActive: true,
    isSubagent: false,
    isErrored: false,
    awaitingInput: false,
    bubbleType: null,
  } as const;
  assert.equal(townGoalFor({ ...working, seatId: null }, zoned), 'work');
  assert.equal(townGoalFor({ ...working, seatId: 's1' }, zoned), null, 'seated: its seat');
  assert.equal(townGoalFor({ ...working, seatId: null }, legacy), null, 'v0.4 town: as before');
  assert.equal(townGoalFor({ ...working, isSubagent: true, seatId: null }, zoned), null);
  assert.equal(townGoalFor({ ...working, isActive: false, seatId: null }, zoned), 'meadow');
});

test('zonedSeatMove: Leads in the Lab, everyone else outdoors', () => {
  const zones = { lab: new Set(['L1', 'L2']), field: new Set(['F1', 'F2']) };
  const first = (free: string[]) => free[0] ?? null;
  const me = { id: 1, isActive: true, isTeamLead: false, seatId: null, isSubagent: false };
  const busy = (id: number, isTeamLead = false) => ({
    id,
    isActive: true,
    isTeamLead,
    townGoal: undefined,
  });
  const away = (id: number, isTeamLead = false) => ({
    id,
    isActive: false,
    isTeamLead,
    townGoal: 'meadow' as const,
  });
  const seats = (holders: Record<string, SeatHolder['holder']>): SeatHolder[] =>
    ['L1', 'L2', 'F1', 'F2'].map((uid) => ({ uid, holder: holders[uid] ?? null }));

  // A working session takes a free outdoor seat, never the Lab.
  assert.deepEqual(zonedSeatMove(me, seats({}), zones, first), { kind: 'move', uid: 'F1' });
  // The fields full of working sessions: it keeps no seat and works standing...
  const fullField = seats({ F1: busy(2), F2: busy(3) });
  assert.deepEqual(zonedSeatMove(me, fullField, zones, first), { kind: 'keep' });
  // ...unless someone holding one is away in the Meadow.
  const awayField = seats({ F1: busy(2), F2: away(3) });
  assert.deepEqual(zonedSeatMove(me, awayField, zones, first), { kind: 'move', uid: 'F2' });
  // A non-Lead on a Lab seat leaves it, for a field seat or for none.
  const onLab = { ...me, seatId: 'L1' };
  assert.deepEqual(zonedSeatMove(onLab, seats({ L1: me }), zones, first), {
    kind: 'move',
    uid: 'F1',
  });
  assert.deepEqual(
    zonedSeatMove(onLab, seats({ L1: me, F1: busy(2), F2: busy(3) }), zones, first),
    {
      kind: 'release',
    },
  );
  // Not even idle may it keep a Lab seat.
  assert.deepEqual(
    zonedSeatMove({ ...onLab, isActive: false }, seats({ L1: me }), zones, first).kind,
    'move',
  );

  // A working Lead takes a Lab seat: free, else a non-Lead's, else an away Lead's.
  const lead = { ...me, isTeamLead: true, seatId: 'F1' };
  assert.deepEqual(zonedSeatMove(lead, seats({ F1: me }), zones, first), {
    kind: 'move',
    uid: 'L1',
  });
  assert.deepEqual(
    zonedSeatMove(lead, seats({ F1: me, L1: busy(2, true), L2: busy(3) }), zones, first),
    { kind: 'move', uid: 'L2' },
  );
  assert.deepEqual(
    zonedSeatMove(lead, seats({ F1: me, L1: busy(2, true), L2: away(3, true) }), zones, first),
    { kind: 'move', uid: 'L2' },
  );
  // The Lab full of working Leads: it stays at its outdoor seat.
  assert.deepEqual(
    zonedSeatMove(lead, seats({ F1: me, L1: busy(2, true), L2: busy(3, true) }), zones, first),
    { kind: 'keep' },
  );
  // An idle Lead keeps its claim until it works again; a sub-agent is never moved.
  assert.deepEqual(zonedSeatMove({ ...lead, isActive: false }, seats({ F1: me }), zones, first), {
    kind: 'keep',
  });
  assert.deepEqual(zonedSeatMove({ ...me, isSubagent: true }, seats({}), zones, first), {
    kind: 'keep',
  });
  // A working non-Lead with a seat outside every zone gives it up.
  const elsewhere = { ...me, seatId: 'X1' };
  const withOther = [...fullField, { uid: 'X1', holder: me }];
  assert.deepEqual(zonedSeatMove(elsewhere, withOther, zones, first), { kind: 'release' });
});

test('pickWorkTile: a free field tile apart from everyone, else the Meadow', () => {
  const field = [
    { col: 0, row: 0 },
    { col: 1, row: 0 },
  ];
  const meadow = [{ col: 9, row: 9 }];
  const world = { fieldTiles: field, meadowTiles: meadow };
  assert.deepEqual(
    pickWorkTile(world, new Set(['1,0']), () => 0),
    { col: 9, row: 9 },
    'spread',
  );
  assert.deepEqual(
    pickWorkTile(world, new Set(['9,9', '5,5']), () => 0),
    { col: 0, row: 0 },
  );
  assert.deepEqual(
    pickWorkTile(world, new Set(['0,0', '9,9']), () => 0),
    { col: 1, row: 0 },
  );
});

test('pickMeadowTile: in a zoned town a stroll stays in its part of the Meadow', () => {
  const west = [{ col: 2, row: 2 }];
  const east = [{ col: 40, row: 2 }];
  const meadowTiles = [...west, ...east];
  const here = { col: 3, row: 3 };
  // Zoned: the near part first, whatever the draw; the far one when it is full.
  for (const r of [0, 0.99]) {
    assert.deepEqual(
      pickMeadowTile({ meadowTiles, zoned: true }, here, 8, new Set(), () => r),
      west[0],
    );
  }
  assert.deepEqual(
    pickMeadowTile({ meadowTiles, zoned: true }, here, 8, new Set(['2,2']), () => 0),
    east[0],
  );
  // Not zoned (the v0.4 town): anywhere in the Meadow, as before.
  assert.deepEqual(
    pickMeadowTile({ meadowTiles, zoned: false }, here, 8, new Set(), () => 0.99),
    east[0],
  );
});

test('the camera home is the middle of the Lab and the largest field', () => {
  const layout = {
    cols: 10,
    areas: [
      { label: 'Lab', color: AREA_DEFAULT_COLORS[0], role: 'lab' as const },
      { label: 'Big', color: AREA_DEFAULT_COLORS[0], role: 'field' as const },
      { label: 'Small', color: AREA_DEFAULT_COLORS[0], role: 'field' as const },
    ],
    areaTiles: Array.from({ length: 30 }, (_, i) => {
      const col = i % 10;
      if (i < 10) return col < 2 ? 'Lab' : col < 6 ? 'Big' : null;
      return col === 9 ? 'Small' : null;
    }),
  };
  assert.deepEqual(townCameraHome(layout), { col: 3, row: 0.5 });
});

// ── In the bundled town ─────────────────────────────────────────

test('working sessions sit outdoors, never in the Lab; with no Leads the Lab stays empty', () => {
  const os = new OfficeState(town);
  const t = os.town!;
  const chars = Array.from({ length: 12 }, (_, i) => worker(os, i + 1));
  run(os, 30);
  for (const ch of chars) {
    assert.ok(ch.seatId && t.fieldSeats.has(ch.seatId), `${ch.id} has an outdoor seat`);
    assert.ok(seatedAt(os, ch), `${ch.id} sits at it, working`);
    assert.ok(!t.roles.lab.has(at(ch)), `${ch.id} is not in the Lab`);
  }
  assert.ok([...os.characters.values()].every((c) => !t.labSeats.has(c.seatId ?? '')));
});

test('a working Lead walks to a Lab desk; when it rests, its desk waits for it', () => {
  const os = new OfficeState(town);
  const t = os.town!;
  for (let id = 1; id <= 4; id++) worker(os, id);
  os.setTeamInfo(2, undefined, undefined, true);
  run(os, 40);
  const lead = os.characters.get(2)!;
  assert.ok(lead.seatId && t.labSeats.has(lead.seatId), 'a Lab seat');
  assert.ok(seatedAt(os, lead), 'sitting at it, working');
  const desk = lead.seatId;
  for (const id of [1, 3, 4]) {
    assert.ok(!t.labSeats.has(os.characters.get(id)!.seatId ?? ''), `${id} stays outdoors`);
  }
  // Idle, it goes out to the Meadow; its claim stays put for its next turn.
  os.setAgentActive(2, false);
  run(os, 40);
  assert.ok(t.roles.meadow.has(at(lead)), 'in the Meadow');
  assert.equal(lead.seatId, desk);
  os.setAgentActive(2, true);
  run(os, 60);
  assert.ok(seatedAt(os, lead) && lead.seatId === desk, 'back at its Lab desk');
});

test('more working sessions than outdoor seats: the rest work standing, never in the Lab', () => {
  const os = new OfficeState(town);
  const t = os.town!;
  const n = t.fieldSeats.size + 5;
  for (let id = 1; id <= n; id++) os.addAgent(id, 0, 0, undefined, true);
  run(os, 60);
  const chars = [...os.characters.values()];
  const seated = chars.filter((c) => c.seatId !== null);
  const standing = chars.filter((c) => c.seatId === null);
  assert.equal(seated.length, t.fieldSeats.size, 'every outdoor seat is taken');
  assert.ok(
    seated.every((c) => t.fieldSeats.has(c.seatId!)),
    'outdoor seats only',
  );
  assert.equal(standing.length, 5);
  const fieldTiles = new Set(t.fieldTiles.map((x) => tileKey(x.col, x.row)));
  for (const ch of standing) {
    assert.equal(ch.townGoal, 'work');
    assert.equal(ch.state, CharacterState.TYPE, `${ch.id} works where it stands`);
    assert.ok(fieldTiles.has(at(ch)) || t.roles.meadow.has(at(ch)), `${ch.id} on a work tile`);
    assert.ok(!t.roles.lab.has(at(ch)), `${ch.id} not in the Lab`);
  }
  const spots = new Set(standing.map(at));
  assert.equal(spots.size, standing.length, 'each on its own tile');
  // One of the seated ones goes idle: a standing one takes its seat.
  const leaving = seated[0];
  const freed = leaving.seatId;
  os.setAgentActive(leaving.id, false);
  run(os, 40);
  const taker = standing.find((c) => c.seatId === freed);
  assert.ok(taker, 'a standing worker took the freed seat');
  assert.ok(seatedAt(os, taker), 'and sits there working');
});

test('a short rest between turns stays at its seat; a longer one walks out to the Meadow', () => {
  const os = new OfficeState(town);
  const ch = worker(os, 1);
  run(os, 20);
  const seat = os.seats.get(ch.seatId!)!;
  const atSeat = () => at(ch) === tileKey(seat.seatCol, seat.seatRow);
  assert.ok(seatedAt(os, ch));
  // Idle for a moment, then working again: it never left its seat.
  os.setAgentActive(1, false);
  run(os, TOWN_MEADOW_DELAY_ZONED_SEC - 2);
  assert.ok(atSeat(), 'still at its seat');
  os.setAgentActive(1, true);
  run(os, 2);
  assert.ok(seatedAt(os, ch), 'working there again');
  // Idle for longer: out to the Meadow.
  os.setAgentActive(1, false);
  run(os, TOWN_MEADOW_DELAY_ZONED_SEC + 30);
  assert.ok(os.town!.roles.meadow.has(at(ch)), 'in the Meadow');
});

test('a non-Lead restored onto a Lab seat moves outdoors', () => {
  const os = new OfficeState(town);
  const [uid] = os.town!.labSeats;
  os.addAgent(1, 0, 0, uid, true);
  const ch = os.characters.get(1)!;
  assert.equal(ch.seatId, uid, 'a saved seat is honoured at first');
  run(os, 40);
  assert.ok(ch.seatId && os.town!.fieldSeats.has(ch.seatId), 'then it moves to an outdoor seat');
  assert.ok(seatedAt(os, ch));
});

test('idle sessions wander the Meadow, fainted ones rest in a Center bed', () => {
  const os = new OfficeState(town);
  const t = os.town!;
  for (let id = 1; id <= 3; id++) worker(os, id);
  os.setAgentActive(1, false);
  os.setAgentActive(2, false);
  os.setAgentError(2, 'overloaded');
  run(os, 60);
  const idle = os.characters.get(1)!;
  const fainted = os.characters.get(2)!;
  assert.ok(t.roles.meadow.has(at(idle)), 'idle: in the Meadow');
  assert.ok(t.roles.center.has(at(fainted)), 'fainted: in the Center');
  assert.ok(fainted.bedRest, 'in a bed');
  assert.ok(seatedAt(os, os.characters.get(3)!), 'the third keeps working outdoors');
});

test('a seatless session that turns out idle as it is created appears in the Meadow', () => {
  const os = new OfficeState(town);
  const n = os.town!.fieldSeats.size;
  for (let id = 1; id <= n; id++) worker(os, id);
  os.addAgent(n + 1, 0, 0, undefined, false);
  const late = os.characters.get(n + 1)!;
  assert.equal(late.seatId, null);
  os.setAgentActive(n + 1, false);
  os.update(DT);
  assert.ok(os.town!.roles.meadow.has(at(late)), 'placed in the Meadow');
});
