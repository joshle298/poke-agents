/**
 * Where characters go in a layout with Area roles (the Pokémon Town), and the
 * per-frame step that takes them there. Pure and DOM-free (Node-tested).
 *
 *   Active (working)            → its seat: the upstream FSM, unchanged
 *     … in a zoned town with no seat left for it → stands and works on a free
 *       field tile (else a Meadow tile): `work`
 *   Fainted (errored)           → walks to the Center and lies in a bed
 *   Needs you (awaiting input)  → stays where it is (seated at its desk)
 *   Idle                        → walks to the Meadow and wanders inside it
 *   About to sleep              → walks to the Meadow if it isn't there, then
 *                                 stays put; asleep it never moves
 *
 * Which seat a working character takes is the seat steward's (townSeatMove,
 * or zonedSeatMove in a town with a Lab or fields: Leads in the Lab, everyone
 * else outdoors). A layout without the matching role, sub-agents and seated
 * active agents get `null`: the caller runs the upstream FSM exactly as before.
 */

import {
  POKEMON_GROUND_OFFSET_PX,
  TOWN_BED_OVERLAP_PX,
  TOWN_MEADOW_DELAY_SEC,
  TOWN_MEADOW_NEAR_TILES,
  TOWN_RETRY_SEC,
  TOWN_SPREAD_TILES,
  TOWN_TARGET_TRIES,
  TOWN_WALL_OVERLAP_PX,
  TOWN_WANDER_RADIUS_TILES,
  WANDER_PAUSE_MAX_SEC,
  WANDER_PAUSE_MIN_SEC,
} from '../../constants.js';
import type { AreaRoleTiles } from '../layout/areaRoles.js';
import { isZonedTown, tileKey } from '../layout/areaRoles.js';
import { findPath } from '../layout/tileMap.js';
import type { BedRest, Character, Seat, TileType as TileTypeVal, TownGoal } from '../types.js';
import { CharacterState, Direction, TILE_SIZE, TileType } from '../types.js';
import { updateCharacter } from './characters.js';

type Tile = { col: number; row: number };

/**
 * Tiles other characters stand on or are heading to. A map also tells, per
 * tile, how far its occupant's resting pose rises above its ground point
 * (world px; 0 when unknown), so a bed under a tall sleeper counts as covered.
 */
export type Occupancy = ReadonlySet<string> | ReadonlyMap<string, number>;

function riseAt(occupied: Occupancy, key: string): number {
  return 'get' in occupied ? (occupied.get(key) ?? 0) : 0;
}

/** How far a fainted character's held pose reaches from its ground point
 *  (world px): sideways and up. Zeros fit anywhere. */
export interface RestFit {
  halfW: number;
  rise: number;
}

export const NO_REST_FIT: RestFit = { halfW: 0, rise: 0 };

/** A bed in the Pokémon Center, as the town step sees it. */
export interface TownBed extends BedRest {
  /** Where its sleeper stands: the bottom row, at the end away from the pillow. */
  rest: Tile;
  /** Every tile of the bed (a rest on the floor never picks one). */
  tiles: ReadonlySet<string>;
  /** World px from the bed's middle to the Center's edge on the nearer side. */
  room: number;
  /** The nearest bed directly above and below (overlapping columns), if any. */
  above: TownBed | null;
  below: TownBed | null;
  /** World px a sleeper here may rise before it covers the bed above
   *  (Infinity when there is none). */
  headroom: number;
}

/** A placed item that can be a bed: fully walkable and inside the Center. */
export interface BedPlacement {
  col: number;
  row: number;
  w: number;
  h: number;
  blanket: BedRest['blanket'];
}

/** The layout facts the town step needs, rebuilt with the layout. */
export interface TownWorld {
  roles: AreaRoleTiles;
  /** Walkable Meadow tiles: where idle characters wander. */
  meadowTiles: Tile[];
  /** Walkable Center tiles: where fainted characters rest. */
  centerTiles: Tile[];
  /** The Center's beds: where a fainted character lies down first. */
  beds: TownBed[];
  /** Every tile of every bed. */
  bedTiles: ReadonlySet<string>;
  /** Per Center tile, its clearance from the Center's side walls (centerClearance). */
  centerClearance: ReadonlyMap<string, number>;
  /** Seat uids on the lectern: kept for Leads. */
  lecternSeats: ReadonlySet<string>;
  /** A Lab or a field exists: Leads work in the Lab, everyone else outdoors
   *  (zonedSeatMove); otherwise townSeatMove's desk rules. */
  zoned: boolean;
  /** Seat uids in the Lab (zoned): for working Leads only. */
  labSeats: ReadonlySet<string>;
  /** Seat uids in a field (zoned): where every other working session sits. */
  fieldSeats: ReadonlySet<string>;
  /** Seats an ordinary free-seat pick never takes: the lectern's, and in a
   *  zoned town every seat outside a field. */
  reservedSeats: ReadonlySet<string>;
  /** Walkable field tiles off the walk-behind rows: where a working session
   *  with no seat left stands and works. */
  fieldTiles: Tile[];
  /** Per seat, how many open tiles lie between it and the nearer side wall. */
  seatRoom: ReadonlyMap<string, number>;
  tileMap: TileTypeVal[][];
  blockedTiles: Set<string>;
  /** `blockedTiles` plus the walk-behind tiles outside the role areas (under
   *  the forest's canopy, across a desk's top): town walks keep off them. */
  pathBlocked: Set<string>;
}

type GoalFacts = Pick<
  Character,
  'isActive' | 'isSubagent' | 'isErrored' | 'awaitingInput' | 'bubbleType'
> &
  Partial<Pick<Character, 'seatId'>>;

/**
 * Where a character belongs, or null to leave it to the upstream FSM. A
 * working one only gets a goal (`work`) in a zoned town when it has no seat:
 * the steward found none free for it.
 */
export function townGoalFor(ch: GoalFacts, roles: AreaRoleTiles | null): TownGoal | null {
  if (!roles || ch.isSubagent) return null;
  if (ch.isActive) return isZonedTown(roles) && !ch.seatId ? 'work' : null;
  if (ch.isErrored) return roles.center.size > 0 ? 'center' : null;
  if (roles.meadow.size === 0) return null;
  if (ch.awaitingInput || ch.bubbleType === 'permission') return 'stay';
  return 'meadow';
}

/** Record this frame's goal. A new goal restarts the trip: at once for the
 *  Center, after a pause for the Meadow (`meadowDelay`: TOWN_MEADOW_DELAY_SEC,
 *  longer in a zoned town). */
export function setTownGoal(
  ch: Character,
  goal: TownGoal | null,
  meadowDelay = TOWN_MEADOW_DELAY_SEC,
): void {
  const next = goal ?? undefined;
  if (ch.townGoal === next) return;
  ch.townGoal = next;
  ch.townRetryTimer = goal === 'meadow' ? meadowDelay : 0;
}

/**
 * A random candidate nobody stands on or is heading to, preferring one at
 * least TOWN_SPREAD_TILES (Chebyshev) from all of those, so characters spread
 * out; else any free candidate, else any candidate.
 */
export function pickTownTile(
  candidates: readonly Tile[],
  occupied: Occupancy,
  random: () => number = Math.random,
): Tile | null {
  return pickSpreadTile([candidates], occupied, random);
}

/**
 * pickTownTile over groups of candidates, best first: a spread-out free tile of
 * the first group that has one, then of the next…, then any free tile of the
 * first group that has one, and so on.
 */
function pickSpreadTile(
  groups: ReadonlyArray<readonly Tile[]>,
  occupied: Occupancy,
  random: () => number,
): Tile | null {
  const taken = Array.from(occupied.keys(), (key) => key.split(',').map(Number));
  const spread = (tiles: readonly Tile[]) =>
    tiles.filter((t) =>
      taken.every(
        ([col, row]) => Math.max(Math.abs(col - t.col), Math.abs(row - t.row)) >= TOWN_SPREAD_TILES,
      ),
    );
  return pickTieredTile([...groups.map(spread), ...groups], occupied, random);
}

/**
 * Where a working session with no seat left stands and works: a free field
 * tile two or more from everyone, else such a Meadow tile, else any free field
 * tile, else any free Meadow tile.
 */
export function pickWorkTile(
  world: Pick<TownWorld, 'fieldTiles' | 'meadowTiles'>,
  occupied: Occupancy,
  random: () => number = Math.random,
): Tile | null {
  return pickSpreadTile([world.fieldTiles, world.meadowTiles], occupied, random);
}

/**
 * A Meadow destination for an idle character at `from`. In a zoned town the
 * Meadow is large and in parts, so tiles within `radius` (Chebyshev) of it
 * come first and it stays in its part of the Meadow instead of crossing the
 * town; elsewhere any Meadow tile, as before.
 */
export function pickMeadowTile(
  world: Pick<TownWorld, 'meadowTiles' | 'zoned'>,
  from: Tile,
  radius: number,
  occupied: Occupancy,
  random: () => number = Math.random,
): Tile | null {
  if (!world.zoned) return pickTownTile(world.meadowTiles, occupied, random);
  const near = world.meadowTiles.filter(
    (t) => Math.max(Math.abs(t.col - from.col), Math.abs(t.row - from.row)) <= radius,
  );
  return pickSpreadTile([near, world.meadowTiles], occupied, random);
}

/** Whether (col, row) is a tile a seatless working session may work on. */
function onWorkTile(ch: Pick<Character, 'tileCol' | 'tileRow'>, world: TownWorld): boolean {
  const key = tileKey(ch.tileCol, ch.tileRow);
  return (
    world.fieldTiles.some((t) => t.col === ch.tileCol && t.row === ch.tileRow) ||
    world.roles.meadow.has(key)
  );
}

/**
 * A random free tile of the first tier that has one; when every tier is full,
 * any tile of the first non-empty tier. Null when every tier is empty.
 */
export function pickTieredTile(
  tiers: ReadonlyArray<readonly Tile[]>,
  occupied: Occupancy,
  random: () => number = Math.random,
): Tile | null {
  for (const tier of tiers) {
    const free = tier.filter((t) => !occupied.has(tileKey(t.col, t.row)));
    if (free.length > 0) return free[Math.floor(random() * free.length)] ?? null;
  }
  const first = tiers.find((tier) => tier.length > 0);
  return first ? (first[Math.floor(random() * first.length)] ?? null) : null;
}

/**
 * The Center's beds, from the placed items that can be one. The pillow is at
 * the end nearer the Center's side wall (beds stand with their head to a
 * wall), the sleeper stands at the other end of the bottom row and lies on
 * the bed with its head on the pillow (bedLie.ts). Pure (Node-tested).
 */
export function townBeds(
  placements: readonly BedPlacement[],
  center: ReadonlySet<string>,
): TownBed[] {
  const beds: TownBed[] = [];
  for (const p of placements) {
    const row = p.row + p.h - 1;
    const first = p.col;
    const last = p.col + p.w - 1;
    let ok = p.w >= 2;
    for (let c = first; c <= last && ok; c++) ok = center.has(tileKey(c, row));
    if (!ok) continue;
    let left = first;
    while (center.has(tileKey(left - 1, row))) left--;
    let right = last;
    while (center.has(tileKey(right + 1, row))) right++;
    const pillow = first - left <= right - last ? 'left' : 'right';
    const midX = (p.col + p.w / 2) * TILE_SIZE;
    const tiles = new Set<string>();
    for (let r = p.row; r <= row; r++) {
      for (let c = first; c <= last; c++) tiles.add(tileKey(c, r));
    }
    beds.push({
      pillow,
      midX,
      x: p.col * TILE_SIZE,
      y: p.row * TILE_SIZE,
      w: p.w * TILE_SIZE,
      h: p.h * TILE_SIZE,
      blanket: p.blanket,
      rest: { col: pillow === 'left' ? last : first, row },
      tiles,
      room: Math.min(midX - left * TILE_SIZE, (right + 1) * TILE_SIZE - midX),
      above: null,
      below: null,
      headroom: Infinity,
    });
  }
  // Stacked beds: the nearest bed above whose columns overlap.
  const span = (b: TownBed) => {
    const cols = [...b.tiles].map((k) => Number(k.split(',')[0]));
    return { lo: Math.min(...cols), hi: Math.max(...cols) };
  };
  for (const b of beds) {
    const s = span(b);
    let best: TownBed | null = null;
    for (const a of beds) {
      if (a === b || a.rest.row >= b.rest.row) continue;
      const t = span(a);
      if (t.hi < s.lo || t.lo > s.hi) continue;
      if (!best || a.rest.row > best.rest.row) best = a;
    }
    if (!best) continue;
    b.above = best;
    best.below = b;
    const ground = b.rest.row * TILE_SIZE + TILE_SIZE / 2 + POKEMON_GROUND_OFFSET_PX;
    b.headroom = ground - (best.rest.row + 1) * TILE_SIZE + TOWN_BED_OVERLAP_PX;
  }
  return beds;
}

/** Whether a bed is wide enough for a sleeper reaching `halfW` px sideways. */
function bedFits(bed: TownBed, fit: RestFit): boolean {
  return fit.halfW <= bed.room + TOWN_WALL_OVERLAP_PX;
}

/** Center tiles off the beds, with their clearance from the side walls. */
function floorTiles(world: TownWorld): Tile[] {
  return world.centerTiles.filter((t) => !world.bedTiles.has(tileKey(t.col, t.row)));
}

/**
 * Where a fainted character may rest, best first. Beds that fit its pose:
 * first those with no sleeper above or below, then any that neither puts it
 * over a sleeper above (a tall pose) nor under a tall sleeper below. Then the
 * floor tiles that keep it inside the Center's walls; when none is wide
 * enough, the widest floor tiles.
 */
export function centerRestTiers(
  world: TownWorld,
  fit: RestFit = NO_REST_FIT,
  occupied: Occupancy = new Set<string>(),
): Tile[][] {
  const taken = (b: TownBed | null) => b !== null && occupied.has(tileKey(b.rest.col, b.rest.row));
  const usable = world.beds.filter(
    (b) =>
      bedFits(b, fit) &&
      !(fit.rise > b.headroom && taken(b.above)) &&
      !(
        b.below &&
        taken(b.below) &&
        riseAt(occupied, tileKey(b.below.rest.col, b.below.rest.row)) > b.below.headroom
      ),
  );
  const alone = usable.filter((b) => !taken(b.above) && !taken(b.below));
  const floor = floorTiles(world);
  const clear = (t: Tile) => world.centerClearance.get(tileKey(t.col, t.row)) ?? 0;
  const need = townRoomNeeded(fit.halfW);
  const tiers = [
    alone.map((b) => b.rest),
    usable.map((b) => b.rest),
    floor.filter((t) => clear(t) >= need),
  ];
  if (tiers.every((tier) => tier.length === 0)) {
    const widest = Math.max(-1, ...floor.map(clear));
    tiers.push(floor.filter((t) => clear(t) === widest));
  }
  return tiers.filter((tier) => tier.length > 0);
}

/** The bed whose sleeper's spot is (col, row), if any. */
function bedAt(world: TownWorld, col: number, row: number): TownBed | undefined {
  return world.beds.find((b) => b.rest.col === col && b.rest.row === row);
}

/** Whether a fainted character may rest where it stands: on a bed that fits
 *  it, or on a floor tile of the Center wide enough for its pose (or as wide
 *  as the Center's floor gets). Never on a bed's other tiles. */
function restsHere(ch: Character, world: TownWorld, fit: RestFit): boolean {
  const here = tileKey(ch.tileCol, ch.tileRow);
  if (!world.roles.center.has(here)) return false;
  const bed = bedAt(world, ch.tileCol, ch.tileRow);
  if (bed) return bedFits(bed, fit);
  if (world.bedTiles.has(here)) return false;
  const widest = Math.max(
    0,
    ...floorTiles(world).map((t) => world.centerClearance.get(tileKey(t.col, t.row)) ?? 0),
  );
  return (world.centerClearance.get(here) ?? 0) >= Math.min(townRoomNeeded(fit.halfW), widest);
}

/** Lie down in `bed`: `x` at its middle, facing the pillow (bedLie.ts draws
 *  the body on the mattress, its head on the pillow). */
function lieDown(ch: Character, bed: TownBed): void {
  ch.bedRest = bed;
  ch.x = bed.midX;
  ch.dir = bed.pillow === 'left' ? Direction.LEFT : Direction.RIGHT;
}

/** Get out of bed (if in one): back over the tile it stands on. */
export function leaveBed(ch: Character): void {
  if (!ch.bedRest) return;
  ch.bedRest = undefined;
  if (ch.state !== CharacterState.WALK) ch.x = ch.tileCol * TILE_SIZE + TILE_SIZE / 2;
}

const NO_SEATS: Map<string, Seat> = new Map();

/**
 * A town walk from where `ch` stands to `target`: never in under the forest's
 * canopy or across furniture tops on the way (`pathBlocked`), unless that is
 * the only way out (it stands in there already). Empty when unreachable.
 */
export function townPath(ch: Character, target: Tile, world: TownWorld): Tile[] {
  const path = findPath(
    ch.tileCol,
    ch.tileRow,
    target.col,
    target.row,
    world.tileMap,
    world.pathBlocked,
  );
  if (path.length > 0) return path;
  return findPath(
    ch.tileCol,
    ch.tileRow,
    target.col,
    target.row,
    world.tileMap,
    world.blockedTiles,
  );
}

function startWalk(ch: Character, path: Tile[]): void {
  ch.path = path;
  ch.moveProgress = 0;
  ch.state = CharacterState.WALK;
  ch.frame = 0;
  ch.frameTimer = 0;
}

/** Walk toward a free tile `pick` chooses; retry later when none is reachable. */
function headTo(
  ch: Character,
  dt: number,
  pick: (taken: Occupancy) => Tile | null,
  world: TownWorld,
  occupied: () => Occupancy,
): void {
  ch.townRetryTimer = (ch.townRetryTimer ?? 0) - dt;
  if (ch.townRetryTimer > 0) return;
  ch.townRetryTimer = TOWN_RETRY_SEC;
  const taken = occupied();
  for (let i = 0; i < TOWN_TARGET_TRIES; i++) {
    const target = pick(taken);
    if (!target) return;
    const path = townPath(ch, target, world);
    if (path.length > 0) {
      startWalk(ch, path);
      return;
    }
  }
}

export interface TownStepOptions {
  /** About to fall asleep (office/asleep.ts): it walks to the Meadow if it
   *  isn't there and then stays put, so it is still when it falls asleep.
   *  (Once asleep, OfficeState holds it still and this step doesn't run.) */
  asleep: boolean;
  /** Tiles other characters stand on or are heading to (computed on demand). */
  occupied: () => Occupancy;
  /** The reach of its resting pose (wide or tall Pokémon), so it rests clear
   *  of the Center's walls and of the other sleepers. Default: fits anywhere. */
  fit?: RestFit;
  random?: () => number;
}

/**
 * Where a character just placed in the town should appear for `goal`: a free
 * Meadow tile, a free work tile (a field, else the Meadow), or a Center bed
 * that fits it. Null for other goals (it stays where it was put: its seat).
 */
export function townSpawnTile(
  goal: TownGoal | null,
  world: TownWorld,
  occupied: Occupancy,
  fit: RestFit = NO_REST_FIT,
  random: () => number = Math.random,
): Tile | null {
  if (goal === 'meadow') return pickTownTile(world.meadowTiles, occupied, random);
  if (goal === 'work') return pickWorkTile(world, occupied, random);
  if (goal === 'center') {
    return pickTieredTile(centerRestTiers(world, fit, occupied), occupied, random);
  }
  return null;
}

/** An idle character's stroll inside the Meadow: after a pause, to a spread-out
 *  Meadow tile. */
function wanderMeadow(
  ch: Character,
  dt: number,
  world: TownWorld,
  occupied: () => Occupancy,
  random: () => number,
): void {
  ch.frame = 0;
  ch.wanderTimer -= dt;
  if (ch.wanderTimer > 0) return;
  ch.wanderTimer = WANDER_PAUSE_MIN_SEC + random() * (WANDER_PAUSE_MAX_SEC - WANDER_PAUSE_MIN_SEC);
  const here = { col: ch.tileCol, row: ch.tileRow };
  const target = pickMeadowTile(world, here, TOWN_WANDER_RADIUS_TILES, occupied(), random);
  if (!target) return;
  const path = townPath(ch, target, world);
  if (path.length > 0) startWalk(ch, path);
}

/**
 * A working session with no seat left for it: walk to a free work tile (a
 * field, else the Meadow) and work standing there (TYPE with no seat: the
 * calm working pose, no chair); stand up first if it is still in a seat it
 * lost. The FSM finishes walks (and, arriving with no seat, starts working).
 */
function stepWorkInPlace(
  ch: Character,
  dt: number,
  world: TownWorld,
  occupied: () => Occupancy,
  random: () => number,
  fsm: () => void,
): void {
  if (ch.state === CharacterState.WALK) {
    fsm();
    return;
  }
  if (onWorkTile(ch, world)) {
    if (ch.state !== CharacterState.TYPE) {
      ch.state = CharacterState.TYPE;
      ch.frame = 0;
      ch.frameTimer = 0;
    }
    fsm(); // the working pose's frames
    return;
  }
  if (ch.state === CharacterState.TYPE) {
    // still in a seat it no longer holds: stand up, then head out
    ch.state = CharacterState.IDLE;
    ch.frame = 0;
    ch.frameTimer = 0;
    ch.townRetryTimer = 0;
  }
  headTo(ch, dt, (taken) => pickWorkTile(world, taken, random), world, occupied);
}

/**
 * One frame of a character with a town goal. Walks and stand-ups run through
 * the upstream FSM (with no seats, so a stroll never ends in a chair); the
 * goal only decides where an idle character heads and when it stays put.
 */
export function stepTownCharacter(
  ch: Character,
  dt: number,
  goal: TownGoal,
  world: TownWorld,
  opts: TownStepOptions,
): void {
  const random = opts.random ?? Math.random;
  const fsm = () => updateCharacter(ch, dt, [], NO_SEATS, world.tileMap, world.blockedTiles);
  if (goal !== 'center' || ch.state !== CharacterState.IDLE) leaveBed(ch);

  if (goal === 'stay') {
    // Holds the pose its turn ended in (seated at its desk); a walk already
    // under way still finishes.
    if (ch.state === CharacterState.WALK) fsm();
    return;
  }
  if (goal === 'work') {
    stepWorkInPlace(ch, dt, world, opts.occupied, random, fsm);
    return;
  }
  // Mid-walk, or still seated (standing up first): the FSM handles both.
  if (ch.state !== CharacterState.IDLE) {
    fsm();
    return;
  }
  if (goal === 'center') {
    const fit = opts.fit ?? NO_REST_FIT;
    if (restsHere(ch, world, fit)) {
      // resting until revived, in bed when there is one here
      const bed = bedAt(world, ch.tileCol, ch.tileRow);
      if (bed) lieDown(ch, bed);
      return;
    }
    leaveBed(ch);
    headTo(
      ch,
      dt,
      (taken) => pickTieredTile(centerRestTiers(world, fit, taken), taken, random),
      world,
      opts.occupied,
    );
    return;
  }
  if (world.roles.meadow.has(tileKey(ch.tileCol, ch.tileRow))) {
    if (opts.asleep) return; // settling down for its nap
    wanderMeadow(ch, dt, world, opts.occupied, random);
    return;
  }
  const here = { col: ch.tileCol, row: ch.tileRow };
  headTo(
    ch,
    dt,
    (taken) => pickMeadowTile(world, here, TOWN_MEADOW_NEAR_TILES, taken, random),
    world,
    opts.occupied,
  );
}

/**
 * Open tiles between (col, row) and the nearer wall (or map edge) along its
 * row: how far a wide sprite seated there can spill sideways.
 */
export function rowRoom(tileMap: TileTypeVal[][], col: number, row: number): number {
  const open = (c: number) => {
    const t = tileMap[row]?.[c];
    return t !== undefined && t !== TileType.WALL && t !== TileType.VOID;
  };
  let left = 0;
  while (open(col - left - 1)) left++;
  let right = 0;
  while (open(col + right + 1)) right++;
  return Math.min(left, right);
}

/** Tiles of room a sprite reaching `halfW` px from its tile's center needs on
 *  each side; a few px of overlap with a wall (its thickness) are fine. */
export function townRoomNeeded(halfW: number): number {
  return Math.ceil(Math.max(0, halfW - TILE_SIZE / 2 - TOWN_WALL_OVERLAP_PX) / TILE_SIZE);
}

/** A seat and who holds it, as the seat steward sees them. */
export interface SeatHolder {
  uid: string;
  holder: Pick<Character, 'id' | 'isActive' | 'isTeamLead' | 'townGoal'> | null;
}

/**
 * The seat a character should move to, or null to keep what it has. Pure:
 * the caller applies the move.
 *
 *   - A Lead takes a lectern seat that is free, else one a non-Lead holds.
 *   - A non-Lead on a lectern seat moves to a free desk.
 *   - A working character without a seat takes a free desk, else the desk of
 *     a character that is away (in the Meadow or the Center).
 *
 * `seats` lists every seat with its holder (null when free), lectern seats
 * included; `preferred` orders free desks (the caller's usual seat choice).
 */
export function townSeatMove(
  ch: Pick<Character, 'id' | 'isActive' | 'isTeamLead' | 'seatId' | 'isSubagent'>,
  seats: readonly SeatHolder[],
  lecternSeats: ReadonlySet<string>,
  preferred: (free: string[]) => string | null,
): string | null {
  if (ch.isSubagent) return null;
  const onLectern = ch.seatId !== null && lecternSeats.has(ch.seatId);
  const desks = seats.filter((s) => !lecternSeats.has(s.uid));
  const freeDesk = () =>
    preferred(desks.filter((s) => s.holder === null).map((s) => s.uid)) ?? null;
  if (ch.isTeamLead && lecternSeats.size > 0 && !onLectern) {
    const lectern = seats.filter((s) => lecternSeats.has(s.uid));
    const free = lectern.find((s) => s.holder === null);
    if (free) return free.uid;
    const taken = lectern.find((s) => s.holder && !s.holder.isTeamLead);
    if (taken) return taken.uid;
  }
  if (!ch.isTeamLead && onLectern) return freeDesk();
  if (ch.isActive && ch.seatId === null) {
    const free = freeDesk();
    if (free) return free;
    const away = desks.find(
      (s) =>
        s.holder !== null &&
        s.holder.id !== ch.id &&
        !s.holder.isActive &&
        (s.holder.townGoal === 'meadow' || s.holder.townGoal === 'center'),
    );
    if (away) return away.uid;
  }
  return null;
}

/** What the seat steward does with a character's seat in a zoned town. */
export type SeatMove =
  | { kind: 'keep' }
  | { kind: 'move'; uid: string }
  /** Give the seat up (it may not sit there) with no other seat to go to:
   *  a working character then stands and works on a free work tile. */
  | { kind: 'release' };

const KEEP: SeatMove = { kind: 'keep' };

/**
 * The seat rules of a zoned town (one with a Lab or fields). Pure: the caller
 * applies the move.
 *
 *   - A working Lead takes a Lab seat: a free one, else one a non-Lead holds,
 *     else one whose holder is away (in the Meadow or the Center). With the
 *     Lab full of working Leads it works outdoors like everyone else.
 *   - Nobody else ever sits in the Lab: a non-Lead on a Lab seat moves to a
 *     free field seat, or gives the seat up.
 *   - A working non-Lead sits in a field: a free field seat, else the field
 *     seat of a character that is away; with none, it works standing (it
 *     keeps no seat elsewhere).
 *   - A character that isn't working keeps its claim (it is in the Meadow, the
 *     Center or waiting at its seat); it moves when it next works.
 *
 * `seats` lists every seat with its holder (null when free); `preferred`
 * picks one of the free seats it is given (the caller's usual choice).
 */
export function zonedSeatMove(
  ch: Pick<Character, 'id' | 'isActive' | 'isTeamLead' | 'seatId' | 'isSubagent'>,
  seats: readonly SeatHolder[],
  zones: { lab: ReadonlySet<string>; field: ReadonlySet<string> },
  preferred: (free: string[]) => string | null,
): SeatMove {
  if (ch.isSubagent) return KEEP;
  const seat = ch.seatId;
  const onLab = seat !== null && zones.lab.has(seat);
  const onField = seat !== null && zones.field.has(seat);
  const freeIn = (zone: ReadonlySet<string>) =>
    seats.filter((s) => zone.has(s.uid) && s.holder === null).map((s) => s.uid);
  const awayIn = (zone: ReadonlySet<string>) =>
    seats.find(
      (s) =>
        zone.has(s.uid) &&
        s.holder !== null &&
        s.holder.id !== ch.id &&
        !s.holder.isActive &&
        (s.holder.townGoal === 'meadow' || s.holder.townGoal === 'center'),
    );
  const move = (uid: string | null | undefined): SeatMove | null =>
    uid ? { kind: 'move', uid } : null;

  if (ch.isTeamLead) {
    if (onLab || !ch.isActive) return KEEP;
    const labSeat =
      move(preferred(freeIn(zones.lab))) ??
      move(
        seats.find(
          (s) =>
            zones.lab.has(s.uid) &&
            s.holder !== null &&
            s.holder.id !== ch.id &&
            !s.holder.isTeamLead,
        )?.uid,
      ) ??
      move(awayIn(zones.lab)?.uid);
    if (labSeat) return labSeat;
  } else if (onLab) {
    return move(preferred(freeIn(zones.field))) ?? { kind: 'release' };
  }
  if (!ch.isActive || onField) return KEEP;
  const fieldSeat = move(preferred(freeIn(zones.field))) ?? move(awayIn(zones.field)?.uid);
  if (fieldSeat) return fieldSeat;
  return seat === null ? KEEP : { kind: 'release' };
}
