/**
 * Where characters go in a layout with Area roles (the Pokémon Town), and the
 * per-frame step that takes them there. Pure and DOM-free (Node-tested).
 *
 *   Active (working)            → its seat: the upstream FSM, unchanged
 *   Fainted (errored)           → walks to the Center and rests there
 *   Needs you (awaiting input)  → stays where it is (seated at its desk)
 *   Idle                        → walks to the Meadow and wanders inside it
 *   Asleep                      → naps in the Meadow (walks there first)
 *
 * A layout without the matching role, sub-agents and active agents get `null`:
 * the caller runs the upstream FSM exactly as before.
 */

import { TOWN_MEADOW_DELAY_SEC, TOWN_RETRY_SEC, TOWN_TARGET_TRIES } from '../../constants.js';
import type { AreaRoleTiles } from '../layout/areaRoles.js';
import { tileKey } from '../layout/areaRoles.js';
import { findPath } from '../layout/tileMap.js';
import type { Character, Seat, TileType as TileTypeVal, TownGoal } from '../types.js';
import { CharacterState } from '../types.js';
import { updateCharacter } from './characters.js';

type Tile = { col: number; row: number };

/** The layout facts the town step needs, rebuilt with the layout. */
export interface TownWorld {
  roles: AreaRoleTiles;
  /** Walkable Meadow tiles: where idle characters wander. */
  meadowTiles: Tile[];
  /** Walkable Center tiles: where fainted characters rest. */
  centerTiles: Tile[];
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
  if (candidates.length === 0) return null;
  const free = candidates.filter((t) => !occupied.has(tileKey(t.col, t.row)));
  const pool = free.length > 0 ? free : candidates;
  return pool[Math.floor(random() * pool.length)] ?? null;
}

const NO_SEATS: Map<string, Seat> = new Map();

function startWalk(ch: Character, path: Tile[]): void {
  ch.path = path;
  ch.moveProgress = 0;
  ch.state = CharacterState.WALK;
  ch.frame = 0;
  ch.frameTimer = 0;
}

/** Walk toward a random free tile of `targets`; retry later when none is reachable. */
function headTo(
  ch: Character,
  dt: number,
  targets: readonly Tile[],
  world: TownWorld,
  occupied: () => ReadonlySet<string>,
  random: () => number,
): void {
  ch.townRetryTimer = (ch.townRetryTimer ?? 0) - dt;
  if (ch.townRetryTimer > 0) return;
  ch.townRetryTimer = TOWN_RETRY_SEC;
  const taken = occupied();
  for (let i = 0; i < TOWN_TARGET_TRIES; i++) {
    const target = pickTownTile(targets, taken, random);
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
  random?: () => number;
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
  const here = tileKey(ch.tileCol, ch.tileRow);
  if (goal === 'center') {
    if (world.roles.center.has(here)) return; // resting until revived
    headTo(ch, dt, world.centerTiles, world, opts.occupied, random);
    return;
  }
  if (world.roles.meadow.has(here)) {
    if (opts.asleep) return; // napping
    fsm(); // wander, with Meadow tiles as the only destinations
    return;
  }
  headTo(ch, dt, world.meadowTiles, world, opts.occupied, random);
}
