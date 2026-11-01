/**
 * Which PMD animation a Pokémon character plays, and which frame of it.
 *
 * Pure and DOM-free (Node-tested): it reads a Character and asks `has(anim)`
 * whether the species has a decoded sheet for an animation, so the same
 * answer comes out of OfficeState.update (which keeps the clock) and the
 * renderer (which draws the frame). The upstream FSM and its frame counters
 * are untouched; PMD frames are derived from `pmdAnimTime` instead.
 */

import {
  PMD_DIRECTION_ROWS,
  PMD_FPS,
  POKEMON_ANIM_FALLBACKS,
  POKEMON_EVOLVE_FLICKER_HZ,
  POKEMON_EVOLVE_FLICKER_LOW,
  POKEMON_EVOLVE_SEC,
  POKEMON_EVOLVE_SOLID_ENVELOPE,
  POKEMON_LOOP_MIN_AVG_TICKS,
  POKEMON_ONE_SHOT_GAP_SEC,
} from '../../constants.js';
import type { Character, PokemonOneShot } from '../types.js';
import { CharacterState, Direction } from '../types.js';
import { isReadingTool } from './characters.js';

/** PMD sheet row per office direction (8-row sheets; 1-row sheets use row 0). */
export const PMD_ROW = { DOWN: 0, RIGHT: 2, UP: 4, LEFT: 6 } as const;

const ROW_BY_DIRECTION: Record<Direction, number> = {
  [Direction.DOWN]: PMD_ROW.DOWN,
  [Direction.RIGHT]: PMD_ROW.RIGHT,
  [Direction.UP]: PMD_ROW.UP,
  [Direction.LEFT]: PMD_ROW.LEFT,
};

export type PokemonAnimSituation = keyof typeof POKEMON_ANIM_FALLBACKS;

/** What the species can play: decoded sheets and their per-frame durations. */
export interface PokemonAnimSource {
  has(anim: string): boolean;
  durations(anim: string): readonly number[] | undefined;
}

export interface PokemonAnimChoice {
  /** The situation that picked it (walk, work, toolWrite, faint, ...). */
  situation: PokemonAnimSituation;
  /** The PMD animation name (Walk, Charge, ...). */
  anim: string;
  /** Loops, or plays once and holds its last frame. */
  loop: boolean;
}

/** Sheet row for a character: a one-shot's facing wins, then its direction. */
export function pmdRow(ch: Pick<Character, 'dir' | 'faceOverride'>, directions: number): number {
  if (directions < PMD_DIRECTION_ROWS) return 0;
  if (ch.faceOverride !== undefined && ch.faceOverride !== null) return ch.faceOverride;
  return ROW_BY_DIRECTION[ch.dir] ?? PMD_ROW.DOWN;
}

/** Sheet row for a chosen animation: Sleep always lies in row 0 (most Sleep
 *  sheets have one row; 8-row ones curl up facing down), the rest pmdRow. */
export function pmdRowFor(
  ch: Pick<Character, 'dir' | 'faceOverride'>,
  chosen: Pick<PokemonAnimChoice, 'situation'>,
  directions: number,
): number {
  if (chosen.situation === 'sleep') return 0;
  return pmdRow(ch, directions);
}

/** The 8-way PMD row facing along (dx, dy), world axes (y grows down). */
export function pmdRowToward(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return PMD_ROW.DOWN;
  // Octant 0 = right, 2 = down, ±4 = left, -2 = up.
  const octant = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  const rowByOctant: Record<number, number> = {
    0: 2,
    1: 1,
    2: 0,
    3: 7,
    4: 6,
    [-4]: 6,
    [-3]: 5,
    [-2]: 4,
    [-1]: 3,
  };
  return rowByOctant[octant] ?? PMD_ROW.DOWN;
}

function totalTicks(durations: readonly number[]): number {
  let total = 0;
  for (const d of durations) total += Math.max(0, d);
  return total;
}

/** Seconds one pass of an animation takes. */
export function pmdDurationSec(durations: readonly number[]): number {
  return totalTicks(durations) / PMD_FPS;
}

/** What pmdPlayDurations gave each sheet's durations array as a loop. */
const playedLoops = new WeakMap<readonly number[], readonly number[]>();

/**
 * The durations a frame is timed by. A one-shot plays as authored. A loop
 * whose frames hold for fewer than POKEMON_LOOP_MIN_AVG_TICKS game frames on
 * average (a Charge-style shiver, a quick Idle) is slowed to that average,
 * every frame scaled alike, so nothing on screen loops into a shake.
 */
export function pmdPlayDurations(durations: readonly number[], loop: boolean): readonly number[] {
  if (!loop || durations.length === 0) return durations;
  // Asked every frame for every Pokémon: work each sheet's timing out once.
  const cached = playedLoops.get(durations);
  if (cached) return cached;
  const avg = totalTicks(durations) / durations.length;
  const scale = POKEMON_LOOP_MIN_AVG_TICKS / avg;
  const played =
    avg <= 0 || avg >= POKEMON_LOOP_MIN_AVG_TICKS
      ? durations
      : durations.map((d) => Math.max(0, d) * scale);
  playedLoops.set(durations, played);
  return played;
}

/**
 * Frame index `t` seconds into an animation whose frames hold for
 * `durations` game frames (60 fps). A looping animation wraps; a one-shot
 * holds its last frame once it has run its course.
 */
export function pmdFrameIndex(durations: readonly number[], t: number, loop: boolean): number {
  if (durations.length === 0) return 0;
  const total = totalTicks(durations);
  if (total <= 0) return 0;
  // The epsilon keeps 0.1 s × 60 = 5.999… from landing a tick early.
  let tick = Math.floor(Math.max(0, t) * PMD_FPS + 1e-6);
  if (loop) tick %= total;
  else if (tick >= total) return durations.length - 1;
  for (let i = 0; i < durations.length; i++) {
    const d = Math.max(0, durations[i]);
    if (tick < d) return i;
    tick -= d;
  }
  return durations.length - 1;
}

/** First animation in a fallback chain the species has. */
export function pickPokemonAnim(
  chain: readonly string[],
  has: (anim: string) => boolean,
): string | null {
  for (const anim of chain) if (has(anim)) return anim;
  return null;
}

/**
 * Asleep as OfficeState last worked it out (`ch.asleep`, from the shared rule
 * in office/asleep.ts: done or idle with no activity for SLEEP_AFTER_MS), the
 * same answer the party bar and Pokédex give. Never while working or fainted.
 */
export function isPokemonAsleep(ch: Character): boolean {
  return ch.asleep === true && !ch.isActive && !ch.isErrored;
}

/** Status condition for the overlay badges: FNT, then "!", then SLP. */
export type PokemonCondition = 'fainted' | 'needsYou' | 'asleep' | null;

export function pokemonCondition(ch: Character): PokemonCondition {
  if (ch.isErrored) return 'fainted';
  if (ch.bubbleType === 'permission' || ch.awaitingInput) return 'needsYou';
  if (isPokemonAsleep(ch)) return 'asleep';
  return null;
}

function choice(
  situation: PokemonAnimSituation,
  loop: boolean,
  has: (anim: string) => boolean,
): PokemonAnimChoice | null {
  const anim = pickPokemonAnim(POKEMON_ANIM_FALLBACKS[situation], has);
  return anim ? { situation, anim, loop } : null;
}

/**
 * The animation for a character right now (DESIGN §D table). Precedence:
 * fainted (walking while it heads to the Pokémon Center), a one-shot,
 * walking, needs-you, asleep, working, idle. Null when the species has none
 * of the chain decoded (the renderer draws its closed orb).
 */
export function choosePokemonAnim(
  ch: Character,
  has: (anim: string) => boolean,
): PokemonAnimChoice | null {
  if (ch.isErrored) {
    // Hurt once, then Faint held on its last frame.
    if (ch.pmdAnim === 'hurt') {
      const hurt = choice('hurt', false, has);
      if (hurt) return hurt;
    }
    // On its way to the Pokémon Center it walks; it faints once there.
    if (ch.state === CharacterState.WALK && ch.townGoal === 'center') {
      const walk = choice('walk', true, has);
      if (walk) return walk;
    }
    return choice('faint', false, has);
  }
  if (ch.pmdAnim && ch.pmdAnim !== 'hurt') {
    const oneShot = choice(ch.pmdAnim, false, has);
    if (oneShot) return oneShot;
  }
  if (ch.state === CharacterState.WALK) return choice('walk', true, has);
  if (ch.bubbleType === 'permission' || ch.awaitingInput) return choice('alert', true, has);
  if (isPokemonAsleep(ch)) return choice('sleep', true, has);
  // At the desk it breathes; a tool start may add one short one-shot.
  if (ch.state === CharacterState.TYPE && ch.isActive) return choice('work', true, has);
  return choice('idle', true, has);
}

/** Identity of a choice for `pmdAnimKey`: the clock restarts when it changes. */
export function pokemonAnimKey(c: PokemonAnimChoice | null): string {
  return c ? `${c.situation}:${c.anim}` : '';
}

/** Whether a one-shot of this kind can play at all for the species. */
export function canPlayOneShot(kind: PokemonOneShot, has: (anim: string) => boolean): boolean {
  return pickPokemonAnim(POKEMON_ANIM_FALLBACKS[kind], has) !== null;
}

/** One-shots that are flavour, not state: at most one per
 *  POKEMON_ONE_SHOT_GAP_SEC per Pokémon, never back to back. */
const RATE_LIMITED: ReadonlySet<PokemonOneShot> = new Set<PokemonOneShot>([
  'toolRead',
  'toolWrite',
  'message',
  'turnEnd',
]);

/** The one-shot a tool start plays: Nod for a reading tool, else Shoot or Attack. */
export function toolOneShot(tool: string | null): PokemonOneShot {
  return isReadingTool(tool) ? 'toolRead' : 'toolWrite';
}

/**
 * Start a one-shot. Tool starts, messages and turn ends are rate-limited: one
 * plays only when none is playing and POKEMON_ONE_SHOT_GAP_SEC have passed
 * since the last one ended. Wake and Hurt always start (`force` restarts one
 * already playing). A fainted character only takes the hurt flinch. Returns
 * whether it started.
 */
export function startPokemonOneShot(
  ch: Character,
  kind: PokemonOneShot,
  opts: { force?: boolean; faceRow?: number } = {},
): boolean {
  if (ch.isErrored && kind !== 'hurt') return false;
  if (RATE_LIMITED.has(kind)) {
    if (ch.pmdAnim || (ch.oneShotCooldown ?? 0) > 0) return false;
  } else if (ch.pmdAnim && !opts.force) {
    return false;
  }
  ch.pmdAnim = kind;
  ch.pmdAnimKey = undefined; // restart the clock on the next tick
  ch.pmdAnimTime = 0;
  ch.faceOverride = opts.faceRow ?? null;
  return true;
}

/** Retire the one-shot; one that played starts the gap before the next. */
function endOneShot(ch: Character, played: boolean): void {
  ch.pmdAnim = null;
  ch.faceOverride = null;
  if (played) ch.oneShotCooldown = POKEMON_ONE_SHOT_GAP_SEC;
}

/** A one-shot is on screen right now (the FSM holds still while it plays). */
export function isOneShotPlaying(ch: Character, has: (anim: string) => boolean): boolean {
  if (!ch.pmdAnim) return false;
  if (ch.pmdAnim === 'hurt') return ch.isErrored === true && canPlayOneShot('hurt', has);
  return !ch.isErrored && canPlayOneShot(ch.pmdAnim, has);
}

/**
 * Advance the PMD clock by `dt`: run down the gap before the next one-shot,
 * restart the clock when the chosen animation changes, and retire a one-shot
 * once it has played through (or when the species can't play it).
 */
export function advancePokemonAnim(ch: Character, dt: number, src: PokemonAnimSource): void {
  if (!ch.pmdAnim && (ch.oneShotCooldown ?? 0) > 0) {
    ch.oneShotCooldown = Math.max(0, (ch.oneShotCooldown ?? 0) - dt);
  }

  if (ch.pmdAnim === 'hurt' && !ch.isErrored) endOneShot(ch, false);
  if (ch.pmdAnim && !isOneShotPlaying(ch, src.has)) endOneShot(ch, false);

  const chosen = choosePokemonAnim(ch, src.has);
  const key = pokemonAnimKey(chosen);
  if (key !== ch.pmdAnimKey) {
    ch.pmdAnimKey = key;
    ch.pmdAnimTime = 0;
  } else {
    ch.pmdAnimTime = (ch.pmdAnimTime ?? 0) + dt;
  }

  if (chosen && !chosen.loop && ch.pmdAnim === chosen.situation) {
    const durations = src.durations(chosen.anim);
    if (!durations) endOneShot(ch, false);
    else if ((ch.pmdAnimTime ?? 0) >= pmdDurationSec(durations)) endOneShot(ch, true);
  }
}

/**
 * Opacity of the white silhouette over a Pokémon `timer` seconds into its
 * evolution: it flickers up to solid white around the midpoint (hiding the
 * species swap) and back down. 0 when not evolving.
 */
export function evolutionFlashAlpha(timer: number | undefined): number {
  if (timer === undefined) return 0;
  const p = Math.min(1, Math.max(0, timer / POKEMON_EVOLVE_SEC));
  const envelope = 1 - Math.abs(2 * p - 1);
  if (envelope >= POKEMON_EVOLVE_SOLID_ENVELOPE) return 1;
  const on = Math.floor(timer * POKEMON_EVOLVE_FLICKER_HZ * 2) % 2 === 0;
  return on ? envelope : envelope * POKEMON_EVOLVE_FLICKER_LOW;
}
