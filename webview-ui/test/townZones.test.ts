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
  TOWN_MEADOW_DELAY_LEAD_SEC,
  TOWN_MEADOW_DELAY_SEC,
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
  townMeadowDelay,
  townWorkTiles,
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

test('zonedSeatMove: a seat someone is still on is never taken', () => {
  const zones = { lab: new Set(['L1']), field: new Set(['F1', 'F2']) };
  const first = (free: string[]) => free[0] ?? null;
  const me = { id: 1, isActive: true, isTeamLead: false, seatId: null, isSubagent: false };
  const resting = { id: 2, isActive: false, isTeamLead: false, townGoal: 'meadow' as const };
  const busy = { id: 3, isActive: true, isTeamLead: false, townGoal: undefined };
  // Its holder idle (resting there before the walk out, or asleep there): kept.
  const onIt: SeatHolder[] = [
    { uid: 'L1', holder: null },
    { uid: 'F1', holder: resting, occupied: true },
    { uid: 'F2', holder: busy },
  ];
  assert.deepEqual(zonedSeatMove(me, onIt, zones, first), { kind: 'keep' });
  // Once it has walked off, its seat is free for a worker.
  const left = onIt.map((s) => ({ ...s, occupied: false }));
  assert.deepEqual(zonedSeatMove(me, left, zones, first), { kind: 'move', uid: 'F1' });
  // A seat nobody holds but someone still sits on (its claim moved on) is
  // not free either; nor is a Lab desk a non-Lead still sits at.
  const stayed: SeatHolder[] = [
    { uid: 'L1', holder: { ...busy, id: 4 }, occupied: true },
    { uid: 'F1', holder: null, occupied: true },
    { uid: 'F2', holder: busy },
  ];
  assert.deepEqual(zonedSeatMove(me, stayed, zones, first), { kind: 'keep' });
  const lead = { ...me, isTeamLead: true, seatId: 'F2' };
  assert.deepEqual(zonedSeatMove(lead, stayed, zones, first), { kind: 'keep' });
});

test("townWorkTiles: field tiles off the seats' sides, Meadow tiles near a field", () => {
  // A field row with a seat at (2,0); the Meadow at cols 5 and 12.
  const field = [0, 1, 3, 4].map((col) => ({ col, row: 0 }));
  const meadow = [
    { col: 5, row: 0 },
    { col: 12, row: 0 },
  ];
  const tiles = townWorkTiles(field, meadow, new Set(['2,0']), 4);
  assert.deepEqual(tiles.fieldStandTiles, [
    { col: 0, row: 0 },
    { col: 4, row: 0 },
  ]);
  assert.deepEqual(tiles.meadowWorkTiles, [{ col: 5, row: 0 }]);
});

test('pickWorkTile: by the work, never scattered across the Meadow', () => {
  const tile = (col: number, row = 0) => ({ col, row });
  const world = {
    fieldTiles: [tile(0), tile(1), tile(2), tile(3)],
    fieldStandTiles: [tile(0), tile(2)],
    meadowWorkTiles: [tile(6)],
    meadowTiles: [tile(6), tile(20)],
  };
  const pick = (taken: string[]) => pickWorkTile(world, new Set(taken), () => 0);
  // A stand tile two or more from everyone.
  assert.deepEqual(pick(['9,9']), tile(0));
  // Nobody that far apart: a stand tile with nobody beside it comes before
  // the Meadow (seated workers sit two tiles apart, so this is the usual case).
  assert.deepEqual(pick(['1,1']), tile(0));
  assert.deepEqual(
    pick(['0,1', '3,0']),
    tile(6),
    'every stand tile has a neighbour: the Meadow by the work',
  );
  // The stand tiles taken: the Meadow near a field, not the far Meadow.
  assert.deepEqual(pick(['0,0', '2,0']), tile(6));
  // Those taken too: any free field tile, and only then the far Meadow.
  assert.deepEqual(pick(['0,0', '2,0', '6,0']), tile(1));
  assert.deepEqual(pick(['0,0', '1,0', '2,0', '3,0', '6,0']), tile(20));
});

test('townMeadowDelay: longer in a zoned town, longest for a Lead there', () => {
  assert.equal(townMeadowDelay(false, false), TOWN_MEADOW_DELAY_SEC);
  assert.equal(townMeadowDelay(false, true), TOWN_MEADOW_DELAY_SEC, 'the v0.4 town as before');
  assert.equal(townMeadowDelay(true, false), TOWN_MEADOW_DELAY_ZONED_SEC);
  assert.equal(townMeadowDelay(true, true), TOWN_MEADOW_DELAY_LEAD_SEC);
  assert.ok(TOWN_MEADOW_DELAY_LEAD_SEC > TOWN_MEADOW_DELAY_ZONED_SEC);
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

test('the camera home keeps the Lab whole when the window is too narrow for both', () => {
  const lab = areaRoleTiles(town)!.lab;
  const cols = [...lab].map((k) => Number(k.split(',')[0]));
  const labLo = Math.min(...cols);
  const labHi = Math.max(...cols) + 1;
  const wide = townCameraHome(town, { cols: 40, rows: 30 })!;
  assert.deepEqual(wide, townCameraHome(town), 'room for both: the middle of both');
  // 28 tiles (900 px at zoom 2): the Lab and a tile and a half beside it on
  // screen, and the rest of the view on the Work Yard.
  const narrow = townCameraHome(town, { cols: 28, rows: 22 })!;
  assert.ok(narrow.col - 14 <= labLo - 1.5, `left edge ${narrow.col - 14}`);
  assert.ok(narrow.col + 14 >= labHi + 1.5, `right edge ${narrow.col + 14}`);
  assert.ok(narrow.col > (labLo + labHi) / 2, 'towards the Work Yard');
  // Narrower than the Lab: the Lab's middle.
  assert.equal(townCameraHome(town, { cols: 8, rows: 22 })!.col, (labLo + labHi) / 2);
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
  // Idle for a while, it goes out to the Meadow; its claim stays put for its
  // next turn.
  os.setAgentActive(2, false);
  const deskSeat = os.seats.get(desk!)!;
  run(os, TOWN_MEADOW_DELAY_LEAD_SEC - 5);
  assert.equal(at(lead), tileKey(deskSeat.seatCol, deskSeat.seatRow), 'a Lead rests at its desk');
  run(os, 40);
  assert.ok(t.roles.meadow.has(at(lead)), 'in the Meadow');
  assert.equal(lead.seatId, desk);
  os.setAgentActive(2, true);
  run(os, 60);
  assert.ok(seatedAt(os, lead) && lead.seatId === desk, 'back at its Lab desk');
});

test('more working sessions than outdoor seats: the rest work standing by the work, never in the Lab', () => {
  const os = new OfficeState(town);
  const t = os.town!;
  const n = t.fieldSeats.size + 12;
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
  assert.equal(standing.length, 12);
  // In a field off the benches (there is room for all twelve), not out among
  // the idle ones in the Meadow.
  const standTiles = new Set(t.fieldStandTiles.map((x) => tileKey(x.col, x.row)));
  for (const ch of standing) {
    assert.equal(ch.townGoal, 'work');
    assert.equal(ch.state, CharacterState.TYPE, `${ch.id} works where it stands`);
    assert.ok(standTiles.has(at(ch)), `${ch.id} stands in a field, at ${at(ch)}`);
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

test('a working session never takes a seat its idle holder is still resting on', () => {
  const os = new OfficeState(town);
  const t = os.town!;
  for (let id = 1; id <= t.fieldSeats.size + 3; id++) os.addAgent(id, 0, 0, undefined, true);
  run(os, 60);
  const leaving = [...os.characters.values()].find((c) => seatedAt(os, c))!;
  const uid = leaving.seatId!;
  const seat = os.seats.get(uid)!;
  const seatKey = tileKey(seat.seatCol, seat.seatRow);
  const headingFor = (c: Character) => {
    const end = c.path[c.path.length - 1];
    return end ? tileKey(end.col, end.row) : at(c);
  };
  // It rests at its seat before walking out; meanwhile nobody comes to it.
  os.setAgentActive(leaving.id, false);
  for (let s = 0; s < TOWN_MEADOW_DELAY_ZONED_SEC - 1; s += DT) {
    os.update(DT);
    for (const c of os.characters.values()) {
      if (c !== leaving) assert.notEqual(headingFor(c), seatKey, `${c.id} heads for it at ${s}s`);
    }
  }
  assert.equal(at(leaving), seatKey, 'still resting there');
  // Once it has walked off, a standing worker takes the seat.
  run(os, 40);
  assert.notEqual(at(leaving), seatKey);
  const taker = [...os.characters.values()].find((c) => c.seatId === uid);
  assert.ok(taker && taker !== leaving, 'a standing worker took it');
  assert.ok(seatedAt(os, taker), 'and works there');
});

test('a Lead whose team arrives as it appears starts at a Lab desk, without the walk', () => {
  const os = new OfficeState(town);
  const t = os.town!;
  os.addAgent(1, 0, 0, undefined, false);
  const lead = os.characters.get(1)!;
  assert.ok(t.fieldSeats.has(lead.seatId!), 'seated outdoors before its team is known');
  os.setTeamInfo(1, undefined, undefined, true);
  for (let s = 0; s < 3; s += DT) {
    os.update(DT);
    assert.notEqual(lead.state, CharacterState.WALK, `walking at ${s.toFixed(1)}s`);
  }
  assert.ok(t.labSeats.has(lead.seatId!), 'a Lab seat');
  assert.ok(seatedAt(os, lead), 'and at it, working');
  // Its team found later (past its first moments): it walks over, as before.
  const late = worker(os, 2);
  os.setTeamInfo(2, undefined, undefined, true);
  run(os, 0.5);
  assert.equal(late.state, CharacterState.WALK);
});

test('a teammate linked as it appears starts near its Lead, and idle it appears in the Meadow', () => {
  const os = new OfficeState(town);
  const t = os.town!;
  const lead = worker(os, 1);
  os.setTeamInfo(1, undefined, undefined, true);
  run(os, 30);
  assert.ok(t.labSeats.has(lead.seatId!));
  // Restored at a seat in the Grove, far from its Lead; its link arrives.
  const grove = [...t.fieldSeats].find((uid) => os.seats.get(uid)!.seatRow > 17)!;
  os.addAgent(2, 0, 0, grove, true);
  const mate = os.characters.get(2)!;
  os.setTeamInfo(2, undefined, 'mate', false, 1);
  const seat = os.seats.get(mate.seatId!)!;
  assert.ok(seat.seatRow < 17, 'a seat nearer the Lab');
  assert.equal(at(mate), tileKey(seat.seatCol, seat.seatRow), 'placed there, not walking');
  assert.notEqual(mate.state, CharacterState.WALK);
  // Its status says idle a moment later: it appears in the Meadow.
  os.setAgentActive(2, false);
  os.update(DT);
  assert.ok(t.roles.meadow.has(at(mate)), `in the Meadow, at ${at(mate)}`);
});

test('a turn that ends on the way to its seat finishes the walk and rests there', () => {
  const os = new OfficeState(town);
  const ch = worker(os, 1);
  run(os, 5);
  const seat = os.seats.get(ch.seatId!)!;
  os.setAgentActive(1, false);
  run(os, TOWN_MEADOW_DELAY_ZONED_SEC + 30);
  assert.ok(os.town!.roles.meadow.has(at(ch)), 'out in the Meadow');
  // Back to work: on its way to the seat, the turn ends.
  os.setAgentActive(1, true);
  run(os, 1);
  assert.equal(ch.state, CharacterState.WALK);
  os.setAgentActive(1, false);
  for (let s = 0; s < 30 && ch.state === CharacterState.WALK; s += DT) os.update(DT);
  assert.equal(at(ch), tileKey(seat.seatCol, seat.seatRow), 'it walked on to its seat');
  assert.equal(ch.dir, seat.facingDir, 'facing the table');
  run(os, TOWN_MEADOW_DELAY_ZONED_SEC - 3);
  assert.equal(at(ch), tileKey(seat.seatCol, seat.seatRow), 'and rests there');
  // The next turn starts there.
  os.setAgentActive(1, true);
  run(os, 1);
  assert.ok(seatedAt(os, ch));
});

test('one that faints on the way to its seat heads for the Center, not its seat', () => {
  const os = new OfficeState(town);
  const ch = worker(os, 1);
  run(os, 5);
  const seat = os.seats.get(ch.seatId!)!;
  const seatKey = tileKey(seat.seatCol, seat.seatRow);
  os.setAgentActive(1, false);
  run(os, TOWN_MEADOW_DELAY_ZONED_SEC + 30);
  // Back to work, then its turn fails on the way.
  os.setAgentActive(1, true);
  run(os, 1);
  assert.equal(ch.state, CharacterState.WALK);
  os.setAgentActive(1, false);
  os.setAgentError(1, 'overloaded');
  const visited = new Set<string>();
  for (let s = 0; s < 40; s += DT) {
    os.update(DT);
    visited.add(at(ch));
  }
  assert.ok(!visited.has(seatKey), 'it never reached its seat');
  assert.ok(os.town!.roles.center.has(at(ch)), `in the Center, at ${at(ch)}`);
});

test('one resting at a Lab desk it may no longer hold gets up and goes at once', () => {
  const os = new OfficeState(town);
  const t = os.town!;
  const lead = worker(os, 1);
  os.setTeamInfo(1, undefined, undefined, true);
  run(os, 30);
  assert.ok(t.labSeats.has(lead.seatId!) && seatedAt(os, lead));
  const desk = os.seats.get(lead.seatId!)!;
  const deskKey = tileKey(desk.seatCol, desk.seatRow);
  // Every outdoor seat taken by a working session.
  for (let id = 2; id <= t.fieldSeats.size + 1; id++) os.addAgent(id, 0, 0, undefined, true);
  run(os, 60);
  // Resting at its desk between turns, it stops being a Lead: nothing is free
  // outdoors, so it gives the desk up, and leaves it now, not after its rest.
  os.setAgentActive(1, false);
  run(os, 2);
  assert.equal(at(lead), deskKey, 'resting at its desk');
  os.setTeamInfo(1, undefined, undefined, false);
  run(os, 3);
  assert.equal(lead.seatId, null, 'the Lab desk given up');
  assert.notEqual(at(lead), deskKey, 'and left at once');
});

test('a teammate is never seated on a free seat someone still rests on', () => {
  const os = new OfficeState(town);
  const t = os.town!;
  const lead = worker(os, 1);
  os.setTeamInfo(1, undefined, undefined, true);
  run(os, 30);
  const anchor = os.seats.get(lead.seatId!)!;
  const dist = (uid: string) => {
    const s = os.seats.get(uid)!;
    return Math.abs(s.seatCol - anchor.seatCol) + Math.abs(s.seatRow - anchor.seatRow);
  };
  // The outdoor seat nearest the Lead: someone rests on it whose claim has
  // moved on, so nobody holds it.
  const nearest = [...t.fieldSeats].sort((a, b) => dist(a) - dist(b))[0]!;
  os.addAgent(2, 0, 0, nearest, true);
  run(os, TOWN_SPAWN_GRACE_SEC + 1);
  const resting = os.characters.get(2)!;
  os.setAgentActive(2, false);
  run(os, 1);
  const seat = os.seats.get(nearest)!;
  assert.equal(at(resting), tileKey(seat.seatCol, seat.seatRow), 'resting on it');
  resting.seatId = null;
  seat.assigned = false;
  // A teammate linked as it appears goes to the next nearest seat instead.
  const grove = [...t.fieldSeats].find((uid) => os.seats.get(uid)!.seatRow > 17)!;
  os.addAgent(3, 0, 0, grove, true);
  os.setTeamInfo(3, undefined, 'mate', false, 1);
  const mate = os.characters.get(3)!;
  assert.notEqual(mate.seatId, nearest);
  assert.ok(dist(mate.seatId!) < dist(grove), 'still nearer its Lead');
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
