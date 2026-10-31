/**
 * Unit tests for pokemonAnim: which PMD animation a Pokémon character plays
 * and which frame of it (DESIGN §D). Pure module, synthetic species — no art.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterEach, test } from 'vitest';

import { PMD_FPS, POKEMON_EVOLVE_SEC, POKEMON_SLEEP_AFTER_SEC } from '../src/constants.js';
import { createCharacter } from '../src/office/engine/characters.js';
import type { PokemonAnimSource } from '../src/office/engine/pokemonAnim.js';
import {
  advancePokemonAnim,
  choosePokemonAnim,
  evolutionFlashAlpha,
  isOneShotPlaying,
  PMD_ROW,
  pmdDurationSec,
  pmdFrameIndex,
  pmdRow,
  pmdRowToward,
  pokemonCondition,
  startPokemonOneShot,
} from '../src/office/engine/pokemonAnim.js';
import { setProviderCapabilities } from '../src/office/toolUtils.js';
import type { Character } from '../src/office/types.js';
import { CharacterState, Direction } from '../src/office/types.js';

/** Durations (60 fps ticks) per anim the synthetic species has decoded. */
const FULL: Record<string, number[]> = {
  Walk: [8, 10, 8, 10],
  Idle: [40, 2, 3, 3, 3, 2],
  Sleep: [30, 35],
  Charge: [2, 2, 2, 2],
  Shoot: [1, 2, 6, 2],
  Attack: [2, 4, 1, 1],
  Hurt: [2, 8],
  Faint: [4, 4, 4],
  Hop: [3, 3, 3],
  Nod: [6, 6],
  Pose: [10, 10],
  Wake: [5, 5],
};

function source(anims: Record<string, number[]>): PokemonAnimSource {
  return { has: (a) => a in anims, durations: (a) => anims[a] };
}

function without(...names: string[]): Record<string, number[]> {
  const copy = { ...FULL };
  for (const n of names) delete copy[n];
  return copy;
}

/** A character standing idle, awake, not working. */
function idleChar(): Character {
  const ch = createCharacter(1, 0, null, null);
  ch.state = CharacterState.IDLE;
  ch.isActive = false;
  ch.idleSec = 0;
  return ch;
}

function seatedWorking(tool: string): Character {
  const ch = idleChar();
  ch.state = CharacterState.TYPE;
  ch.isActive = true;
  ch.currentTool = tool;
  return ch;
}

const anim = (ch: Character, anims = FULL) => choosePokemonAnim(ch, source(anims).has);

afterEach(() => {
  setProviderCapabilities({ readingTools: [], subagentToolNames: [] });
});

// ── rows and frame timing ───────────────────────────────────────

test('PMD rows: Down 0, Right 2, Up 4, Left 6; one-row sheets always row 0', () => {
  assert.deepEqual(PMD_ROW, { DOWN: 0, RIGHT: 2, UP: 4, LEFT: 6 });
  const ch = idleChar();
  const rows = [Direction.DOWN, Direction.RIGHT, Direction.UP, Direction.LEFT].map((dir) => {
    ch.dir = dir;
    return pmdRow(ch, 8);
  });
  assert.deepEqual(rows, [0, 2, 4, 6]);
  ch.dir = Direction.LEFT;
  assert.equal(pmdRow(ch, 1), 0, 'Sleep sheets have a single row');
});

test('a one-shot facing overrides the direction on 8-row sheets only', () => {
  const ch = idleChar();
  ch.dir = Direction.DOWN;
  ch.faceOverride = 3;
  assert.equal(pmdRow(ch, 8), 3);
  assert.equal(pmdRow(ch, 1), 0);
});

test('pmdRowToward picks the 8-way row toward a target (y grows down)', () => {
  const cases: Array<[number, number, number]> = [
    [1, 0, 2],
    [1, 1, 1],
    [0, 1, 0],
    [-1, 1, 7],
    [-1, 0, 6],
    [-1, -1, 5],
    [0, -1, 4],
    [1, -1, 3],
    [0, 0, 0],
  ];
  for (const [dx, dy, row] of cases) {
    assert.equal(pmdRowToward(dx, dy), row, `toward (${dx}, ${dy})`);
  }
});

test('frame index follows uneven durations in 60 fps game frames', () => {
  const idle = FULL.Idle; // 40, 2, 3, 3, 3, 2 = 53 ticks
  const at = (ticks: number, loop = true) => pmdFrameIndex(idle, ticks / PMD_FPS, loop);
  assert.equal(at(0), 0);
  assert.equal(at(39), 0, 'the 40-tick hold');
  assert.equal(at(40), 1);
  assert.equal(at(41), 1);
  assert.equal(at(42), 2);
  assert.equal(at(52), 5);
  assert.equal(at(53), 0, 'a loop wraps after 53 ticks');
  assert.equal(at(53 + 40), 1);
  assert.equal(at(53, false), 5, 'a one-shot holds its last frame');
  assert.equal(at(10_000, false), 5);
  assert.equal(pmdFrameIndex([6, 6], 0.1, true), 1, '0.1 s × 60 is tick 6, not 5.999');
  assert.equal(pmdFrameIndex([], 1, true), 0);
  assert.equal(pmdDurationSec(FULL.Walk), 36 / PMD_FPS, 'Pikachu-like walk cycle: 0.6 s');
});

// ── the DESIGN §D table ─────────────────────────────────────────

test('walking plays Walk, standing awake plays Idle (Walk when Idle is missing)', () => {
  const ch = idleChar();
  assert.deepEqual(anim(ch), { situation: 'idle', anim: 'Idle', loop: true });
  assert.equal(anim(ch, without('Idle'))?.anim, 'Walk');
  ch.state = CharacterState.WALK;
  assert.deepEqual(anim(ch), { situation: 'walk', anim: 'Walk', loop: true });
});

test('working with a writing tool: Charge, falling back to Shoot, Attack, Idle', () => {
  const ch = seatedWorking('Write');
  assert.deepEqual(anim(ch), { situation: 'work', anim: 'Charge', loop: true });
  assert.equal(anim(ch, without('Charge'))?.anim, 'Shoot');
  assert.equal(anim(ch, without('Charge', 'Shoot'))?.anim, 'Attack');
  assert.equal(anim(ch, without('Charge', 'Shoot', 'Attack'))?.anim, 'Idle');
});

test('working with a reading tool: Nod, falling back to Idle', () => {
  setProviderCapabilities({ readingTools: ['Read'], subagentToolNames: [] });
  const ch = seatedWorking('Read');
  assert.deepEqual(anim(ch), { situation: 'read', anim: 'Nod', loop: true });
  assert.equal(anim(ch, without('Nod'))?.anim, 'Idle');
});

test('asleep after POKEMON_SLEEP_AFTER_SEC not active, or while resting in its seat', () => {
  const ch = idleChar();
  ch.idleSec = POKEMON_SLEEP_AFTER_SEC - 0.1;
  assert.equal(anim(ch)?.anim, 'Idle');
  ch.idleSec = POKEMON_SLEEP_AFTER_SEC;
  assert.deepEqual(anim(ch), { situation: 'sleep', anim: 'Sleep', loop: true });

  const resting = idleChar();
  resting.state = CharacterState.TYPE;
  resting.seatTimer = 90; // the 2-4 min rest after a stroll
  assert.equal(anim(resting)?.anim, 'Sleep');
  resting.seatTimer = -1; // a turn just ended: standing up, not dozing off
  assert.equal(anim(resting)?.anim, 'Idle');

  const active = seatedWorking('Write');
  active.idleSec = 1_000;
  assert.equal(anim(active)?.anim, 'Charge', 'an active agent never sleeps');
});

test('needing you (permission or a question) plays Pose, ahead of sleep', () => {
  const ch = idleChar();
  ch.idleSec = 1_000;
  ch.bubbleType = 'permission';
  assert.deepEqual(anim(ch), { situation: 'alert', anim: 'Pose', loop: true });
  ch.bubbleType = null;
  ch.awaitingInput = true;
  assert.equal(anim(ch)?.anim, 'Pose');
  assert.equal(anim(ch, without('Pose'))?.anim, 'Idle');
});

test('errored: Hurt while the flinch plays, then Faint held; fallbacks when missing', () => {
  const ch = idleChar();
  ch.isErrored = true;
  ch.pmdAnim = 'hurt';
  assert.deepEqual(anim(ch), { situation: 'hurt', anim: 'Hurt', loop: false });
  ch.pmdAnim = null;
  assert.deepEqual(anim(ch), { situation: 'faint', anim: 'Faint', loop: false });
  assert.equal(anim(ch, without('Faint'))?.anim, 'Sleep', 'lying down reads as fainted');
  ch.state = CharacterState.WALK;
  assert.equal(anim(ch)?.anim, 'Faint', 'fainted beats walking');
});

test('a species with none of a chain yields null (the upstream character draws)', () => {
  assert.equal(anim(idleChar(), {}), null);
});

test('status condition: fainted, then needs-you, then asleep', () => {
  const ch = idleChar();
  assert.equal(pokemonCondition(ch), null);
  ch.idleSec = POKEMON_SLEEP_AFTER_SEC;
  assert.equal(pokemonCondition(ch), 'asleep');
  ch.awaitingInput = true;
  assert.equal(pokemonCondition(ch), 'needsYou');
  ch.isErrored = true;
  assert.equal(pokemonCondition(ch), 'fainted');
});

// ── one-shots and the clock ─────────────────────────────────────

test('a tool burst plays Shoot once, then the working loop resumes', () => {
  const ch = seatedWorking('Bash');
  const src = source(FULL);
  advancePokemonAnim(ch, 0, src);
  assert.equal(anim(ch)?.anim, 'Charge');

  assert.equal(startPokemonOneShot(ch, 'toolBurst'), true);
  advancePokemonAnim(ch, 0, src);
  assert.deepEqual(anim(ch), { situation: 'toolBurst', anim: 'Shoot', loop: false });
  assert.equal(ch.pmdAnimTime, 0, 'the clock restarts for the one-shot');
  assert.equal(isOneShotPlaying(ch, src.has), true);

  const shootSec = pmdDurationSec(FULL.Shoot);
  advancePokemonAnim(ch, shootSec / 2, src);
  assert.equal(ch.pmdAnim, 'toolBurst', 'still playing halfway through');
  advancePokemonAnim(ch, shootSec / 2 + 0.01, src);
  assert.equal(ch.pmdAnim, null, 'retired once it played through');
  advancePokemonAnim(ch, 0.01, src);
  assert.equal(anim(ch)?.anim, 'Charge');
  assert.equal(ch.pmdAnimTime, 0, 'the loop starts from its first frame');
});

test('one-shot fallbacks: Shoot → Charge for a burst, Wake → Hop when woken', () => {
  const ch = seatedWorking('Bash');
  ch.pmdAnim = 'toolBurst';
  assert.equal(anim(ch, without('Shoot'))?.anim, 'Charge');
  ch.pmdAnim = 'wake';
  assert.equal(anim(ch)?.anim, 'Wake');
  assert.equal(anim(ch, without('Wake'))?.anim, 'Hop');
  ch.pmdAnim = 'message';
  assert.equal(anim(ch, without('Attack'))?.anim, 'Shoot');
  ch.pmdAnim = 'turnEnd';
  assert.equal(anim(ch)?.anim, 'Hop');
});

test('a one-shot the species cannot play is dropped at once', () => {
  const ch = idleChar();
  const src = source(without('Hop'));
  startPokemonOneShot(ch, 'turnEnd');
  assert.equal(isOneShotPlaying(ch, src.has), false);
  advancePokemonAnim(ch, 0.016, src);
  assert.equal(ch.pmdAnim, null);
  assert.equal(anim(ch, without('Hop'))?.anim, 'Idle');
});

test('a running one-shot is kept unless forced; a forced restart rewinds it', () => {
  const ch = idleChar();
  const src = source(FULL);
  startPokemonOneShot(ch, 'turnEnd');
  advancePokemonAnim(ch, 0, src);
  advancePokemonAnim(ch, 0.05, src);
  assert.equal(startPokemonOneShot(ch, 'toolBurst'), false);
  assert.equal(ch.pmdAnim, 'turnEnd');
  assert.equal(startPokemonOneShot(ch, 'message', { force: true, faceRow: 2 }), true);
  advancePokemonAnim(ch, 0, src);
  assert.equal(ch.pmdAnim, 'message');
  assert.equal(ch.faceOverride, 2, 'faces the receiver');
  assert.equal(ch.pmdAnimTime, 0);
  advancePokemonAnim(ch, pmdDurationSec(FULL.Attack) + 0.01, src);
  assert.equal(ch.pmdAnim, null);
  assert.equal(ch.faceOverride, null, 'facing returns to the walking direction');
});

test('a fainted Pokémon takes only the hurt flinch', () => {
  const ch = idleChar();
  ch.isErrored = true;
  assert.equal(startPokemonOneShot(ch, 'toolBurst', { force: true }), false);
  assert.equal(startPokemonOneShot(ch, 'hurt', { force: true }), true);
});

test('errored: Hurt once, then Faint holds its last frame for good', () => {
  const ch = idleChar();
  const src = source(FULL);
  ch.isErrored = true;
  startPokemonOneShot(ch, 'hurt', { force: true });
  advancePokemonAnim(ch, 0, src);
  assert.equal(anim(ch)?.anim, 'Hurt');
  advancePokemonAnim(ch, pmdDurationSec(FULL.Hurt) + 0.01, src);
  assert.equal(ch.pmdAnim, null);
  advancePokemonAnim(ch, 0.01, src);
  const faint = anim(ch)!;
  assert.equal(faint.anim, 'Faint');
  advancePokemonAnim(ch, 30, src);
  assert.equal(
    pmdFrameIndex(FULL.Faint, ch.pmdAnimTime ?? 0, faint.loop),
    FULL.Faint.length - 1,
    'held on the last frame',
  );

  ch.isErrored = false;
  startPokemonOneShot(ch, 'hurt', { force: true });
  advancePokemonAnim(ch, 0.01, src);
  assert.equal(ch.pmdAnim, null, 'a stale flinch ends once the error clears');
});

test('the clock counts time not active and restarts when the animation changes', () => {
  const ch = idleChar();
  const src = source(FULL);
  advancePokemonAnim(ch, 0, src);
  advancePokemonAnim(ch, 1, src);
  advancePokemonAnim(ch, 1, src);
  assert.equal(ch.idleSec, 2);
  assert.equal(ch.pmdAnimTime, 2, 'Idle has been playing for 2 s');

  ch.state = CharacterState.WALK;
  advancePokemonAnim(ch, 0.5, src);
  assert.equal(ch.pmdAnimTime, 0, 'Walk starts from frame 0');

  advancePokemonAnim(ch, POKEMON_SLEEP_AFTER_SEC, src);
  ch.state = CharacterState.IDLE;
  advancePokemonAnim(ch, 0.1, src);
  assert.equal(anim(ch)?.anim, 'Sleep');

  ch.isActive = true;
  advancePokemonAnim(ch, 0.1, src);
  assert.equal(ch.idleSec, 0, 'activity resets the sleep clock');
});

test('the evolution flash flickers up to solid white across the midpoint and back', () => {
  assert.equal(evolutionFlashAlpha(undefined), 0);
  assert.equal(evolutionFlashAlpha(0), 0);
  assert.equal(evolutionFlashAlpha(POKEMON_EVOLVE_SEC / 2), 1, 'solid at the swap');
  assert.equal(evolutionFlashAlpha(POKEMON_EVOLVE_SEC * 0.45), 1);
  assert.equal(evolutionFlashAlpha(POKEMON_EVOLVE_SEC * 0.55), 1);
  assert.equal(evolutionFlashAlpha(POKEMON_EVOLVE_SEC), 0);
  const early = evolutionFlashAlpha(POKEMON_EVOLVE_SEC * 0.2);
  assert.ok(early > 0 && early < 1, `partly white early on (${early})`);
});
