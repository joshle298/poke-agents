/**
 * Where characters go in a layout with Area roles (the Pokémon Town), and the
 * per-frame step that takes them there. Pure and DOM-free (Node-tested).
 *
 *   Active (working)            → its seat: the upstream FSM, unchanged
 *   Fainted (errored)           → walks to the Center and rests on a bed
 *   Needs you (awaiting input)  → stays where it is (seated at its desk)
 *   Idle                        → walks to the Meadow and wanders inside it
 *   Asleep                      → naps in the Meadow (walks there first)
 *
 * A layout without the matching role, sub-agents and active agents get `null`:
 * the caller runs the upstream FSM exactly as before.
 */

import {
  TOWN_MEADOW_DELAY_SEC,
  TOWN_RETRY_SEC,
  TOWN_TARGET_TRIES,
  TOWN_WALL_OVERLAP_PX,
} from '../../constants.js';
import type { AreaRoleTiles } from '../layout/areaRoles.js';
import { tileKey } from '../layout/areaRoles.js';
import { findPath } from '../layout/tileMap.js';
import type { Character, Seat, TileType as TileTypeVal, TownGoal } from '../types.js';
import { CharacterState, TILE_SIZE, TileType } from '../types.js';
import { updateCharacter } from './characters.js';

type Tile = { col: number; row: number };

/** The layout facts the town step needs, rebuilt with the layout. */
export interface TownWorld {
  roles: AreaRoleTiles;
  /** Walkable Meadow tiles: where idle characters wander. */
  meadowTiles: Tile[];
  /** Walkable Center tiles: where fainted characters rest. */
  centerTiles: Tile[];
  /** Walkable Center tiles on a bed (the bottom row of a placed item a
   *  character can stand on): where a fainted character lies down first. */
  restSpots: Tile[];
  /** Per Center tile, its clearance from the Center's side walls (centerClearance). */
  centerClearance: ReadonlyMap<string, number>;
  /** Seat uids on the lectern: kept for Leads. */
  lecternSeats: ReadonlySet<string>;
  /** Per seat, how many open tiles lie between it and the nearer side wall. */
  seatRoom: ReadonlyMap<string, number>;
  tileMap: TileTypeVal[][];
  blockedTiles: Set<string>;
}

type GoalFacts = Pick<
  Character,
  'isActive' | 'isSubagent' | 'isErrored' | 'awaitingInput' | 'bubbleType'
>;

/** Where an inactive character belongs, or null to leave it to the upstream FSM. */
export function townGoalFor(ch: GoalFacts, roles: AreaRoleTiles | null): TownGoal | null {
  if (!roles || ch.isSubagent || ch.isActive) return null;
  if (ch.isErrored) return roles.center.size > 0 ? 'center' : null;
  if (roles.meadow.size === 0) return null;
  if (ch.awaitingInput || ch.bubbleType === 'permission') return 'stay';
  return 'meadow';
}

/** Record this frame's goal. A new goal restarts the trip: at once for the
 *  Center, after a short pause for the Meadow. */
export function setTownGoal(ch: Character, goal: TownGoal | null): void {
  const next = goal ?? undefined;
  if (ch.townGoal === next) return;
  ch.townGoal = next;
  ch.townRetryTimer = goal === 'meadow' ? TOWN_MEADOW_DELAY_SEC : 0;
}

/** A random candidate nobody stands on or is heading to, else any candidate. */
export function pickTownTile(
  candidates: readonly Tile[],
  occupied: ReadonlySet<string>,
  random: () => number = Math.random,
): Tile | null {
  return pickTieredTile([candidates], occupied, random);
}

/**
 * A random free tile of the first tier that has one; when every tier is full,
 * any tile of the first non-empty tier. Null when every tier is empty.
 */
export function pickTieredTile(
  tiers: ReadonlyArray<readonly Tile[]>,
  occupied: ReadonlySet<string>,
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
 * Where a fainted character may rest, best first, for a sprite that spills
 * `clearance` tiles to each side of the tile it stands on: beds that keep it
 * inside the Center's walls (the most central side of each bed first), then
 * any Center tile that does. When nothing is wide enough, the widest tiles.
 */
export function centerRestTiers(world: TownWorld, clearance: number): Tile[][] {
  const clear = (t: Tile) => world.centerClearance.get(tileKey(t.col, t.row)) ?? 0;
  const fits = (t: Tile) => clear(t) >= clearance;
  const beds = world.restSpots.filter(fits);
  const roomiest = Math.max(-1, ...beds.map(clear));
  const tiers = [
    beds.filter((t) => clear(t) === roomiest),
    beds.filter((t) => clear(t) !== roomiest),
    world.centerTiles.filter(fits),
  ];
  if (tiers.every((tier) => tier.length === 0)) {
    const widest = Math.max(-1, ...world.centerTiles.map(clear));
    tiers.push(world.centerTiles.filter((t) => clear(t) === widest));
  }
  return tiers.filter((tier) => tier.length > 0);
}

/** Whether a fainted character may rest where it stands: in the Center, on a
 *  tile wide enough for its sprite (or as wide as the Center gets). */
function restsHere(ch: Character, world: TownWorld, clearance: number): boolean {
  const here = tileKey(ch.tileCol, ch.tileRow);
  if (!world.roles.center.has(here)) return false;
  const widest = Math.max(0, ...world.centerClearance.values());
  return (world.centerClearance.get(here) ?? 0) >= Math.min(clearance, widest);
}

const NO_SEATS: Map<string, Seat> = new Map();

function startWalk(ch: Character, path: Tile[]): void {
  ch.path = path;
  ch.moveProgress = 0;
  ch.state = CharacterState.WALK;
  ch.frame = 0;
  ch.frameTimer = 0;
}

/** Walk toward a random free tile of `tiers`; retry later when none is reachable. */
function headTo(
  ch: Character,
  dt: number,
  tiers: ReadonlyArray<readonly Tile[]>,
  world: TownWorld,
  occupied: () => ReadonlySet<string>,
  random: () => number,
): void {
  ch.townRetryTimer = (ch.townRetryTimer ?? 0) - dt;
  if (ch.townRetryTimer > 0) return;
  ch.townRetryTimer = TOWN_RETRY_SEC;
  const taken = occupied();
  for (let i = 0; i < TOWN_TARGET_TRIES; i++) {
    const target = pickTieredTile(tiers, taken, random);
    if (!target) return;
    const path = findPath(
      ch.tileCol,
      ch.tileRow,
      target.col,
      target.row,
      world.tileMap,
      world.blockedTiles,
    );
    if (path.length > 0) {
      startWalk(ch, path);
      return;
    }
  }
}

export interface TownStepOptions {
  /** Asleep (a Pokémon not active for a while): it naps once in the Meadow. */
  asleep: boolean;
  /** Tiles other characters stand on or are heading to (computed on demand). */
  occupied: () => ReadonlySet<string>;
  /** Tiles the character's sprite spills to each side (wide Pokémon), so it
   *  rests clear of the Center's walls. Default 0. */
  clearance?: number;
  random?: () => number;
}

/**
 * Where a character just placed in the town should appear for `goal`: a free
 * Meadow tile, or a Center bed that fits it. Null for other goals (it stays
 * where it was put: its seat).
 */
export function townSpawnTile(
  goal: TownGoal | null,
  world: TownWorld,
  occupied: ReadonlySet<string>,
  clearance = 0,
  random: () => number = Math.random,
): Tile | null {
  if (goal === 'meadow') return pickTownTile(world.meadowTiles, occupied, random);
  if (goal === 'center') return pickTieredTile(centerRestTiers(world, clearance), occupied, random);
  return null;
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
  const wanderTargets = goal === 'meadow' ? world.meadowTiles : [];
  const fsm = () =>
    updateCharacter(ch, dt, wanderTargets, NO_SEATS, world.tileMap, world.blockedTiles);

  if (goal === 'stay') {
    // Holds the pose its turn ended in (seated at its desk); a walk already
    // under way still finishes.
    if (ch.state === CharacterState.WALK) fsm();
    return;
  }
  // Mid-walk, or still seated (standing up first): the FSM handles both.
  if (ch.state !== CharacterState.IDLE) {
    fsm();
    return;
  }
  if (goal === 'center') {
    const clearance = opts.clearance ?? 0;
    if (restsHere(ch, world, clearance)) return; // resting until revived
    headTo(ch, dt, centerRestTiers(world, clearance), world, opts.occupied, random);
    return;
  }
  if (world.roles.meadow.has(tileKey(ch.tileCol, ch.tileRow))) {
    if (opts.asleep) return; // napping
    fsm(); // wander, with Meadow tiles as the only destinations
    return;
  }
  headTo(ch, dt, [world.meadowTiles], world, opts.occupied, random);
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
