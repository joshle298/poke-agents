/**
 * Unit tests for pokemonAnim: which PMD animation a Pokémon character plays
 * and which frame of it (DESIGN §D). Pure module, synthetic species — no art.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterEach, test } from 'vitest';

import {
  PMD_FPS,
  POKEMON_EVOLVE_SEC,
  POKEMON_LOOP_MIN_AVG_TICKS,
  POKEMON_ONE_SHOT_GAP_SEC,
} from '../src/constants.js';
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
  pmdPlayDurations,
  pmdRow,
  pmdRowFor,
  pmdRowToward,
  pokemonCondition,
  startPokemonOneShot,
  toolOneShot,
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
  ch.asleep = false;
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
  // Its Walk sheet still decoding (sheets arrive one by one): it walks in
  // its Idle pose, never without a frame (that would be an orb mid-walk).
  assert.deepEqual(anim(ch, without('Walk')), { situation: 'walk', anim: 'Idle', loop: true });
});

test('working at the desk breathes: Idle whatever the tool, never a shaking loop', () => {
  setProviderCapabilities({ readingTools: ['Read'], subagentToolNames: [] });
  for (const tool of ['Write', 'Bash', 'Read', null]) {
    const ch = seatedWorking(tool as string);
    assert.deepEqual(anim(ch), { situation: 'work', anim: 'Idle', loop: true }, `tool ${tool}`);
    assert.equal(anim(ch, without('Idle'))?.anim, 'Walk');
  }
});

test('asleep is what OfficeState worked out (the shared rule), never while working', () => {
  const ch = idleChar();
  assert.equal(anim(ch)?.anim, 'Idle');
  ch.asleep = true;
  assert.deepEqual(anim(ch), { situation: 'sleep', anim: 'Sleep', loop: true });

  const resting = idleChar();
  resting.state = CharacterState.TYPE;
  resting.seatTimer = 90; // the 2-4 min rest after a stroll is not sleep
  assert.equal(anim(resting)?.anim, 'Idle');

  const active = seatedWorking('Write');
  active.asleep = true; // a stale flag the next update clears
  assert.equal(anim(active)?.anim, 'Idle', 'an active agent never sleeps');
});

test('Sleep lies in row 0 whatever it faces; other anims follow the direction', () => {
  const ch = idleChar();
  ch.dir = Direction.LEFT;
  assert.equal(pmdRowFor(ch, { situation: 'sleep' }, 8), 0);
  assert.equal(pmdRowFor(ch, { situation: 'idle' }, 8), PMD_ROW.LEFT);
  assert.equal(pmdRowFor(ch, { situation: 'sleep' }, 1), 0);
});

test('needing you (permission or a question) plays Pose, ahead of sleep', () => {
  const ch = idleChar();
  ch.asleep = true;
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

test('a species with none of a chain yields null (the renderer draws its orb)', () => {
  assert.equal(anim(idleChar(), {}), null);
});

test('status condition: fainted, then needs-you, then asleep', () => {
  const ch = idleChar();
  assert.equal(pokemonCondition(ch), null);
  ch.asleep = true;
  assert.equal(pokemonCondition(ch), 'asleep');
  ch.awaitingInput = true;
  assert.equal(pokemonCondition(ch), 'needsYou');
  ch.isErrored = true;
  assert.equal(pokemonCondition(ch), 'fainted');
});

// ── one-shots and the clock ─────────────────────────────────────

test('a tool start plays one gesture: Nod reading, Shoot (else Attack) otherwise', () => {
  setProviderCapabilities({ readingTools: ['Read', 'Grep'], subagentToolNames: [] });
  assert.equal(toolOneShot('Read'), 'toolRead');
  assert.equal(toolOneShot('Grep'), 'toolRead');
  assert.equal(toolOneShot('Edit'), 'toolWrite');
  assert.equal(toolOneShot('Bash'), 'toolWrite');
  assert.equal(toolOneShot(null), 'toolWrite');

  const ch = seatedWorking('Bash');
  ch.pmdAnim = 'toolWrite';
  assert.deepEqual(anim(ch), { situation: 'toolWrite', anim: 'Shoot', loop: false });
  assert.equal(anim(ch, without('Shoot'))?.anim, 'Attack');
  assert.equal(anim(ch, without('Shoot', 'Attack'))?.anim, 'Idle', 'none: the loop plays');
  ch.pmdAnim = 'toolRead';
  assert.deepEqual(anim(ch), { situation: 'toolRead', anim: 'Nod', loop: false });
});

test('a gesture plays once, then breathing resumes from its first frame', () => {
  const ch = seatedWorking('Bash');
  const src = source(FULL);
  advancePokemonAnim(ch, 0, src);
  assert.equal(anim(ch)?.anim, 'Idle');

  assert.equal(startPokemonOneShot(ch, 'toolWrite'), true);
  advancePokemonAnim(ch, 0, src);
  assert.deepEqual(anim(ch), { situation: 'toolWrite', anim: 'Shoot', loop: false });
  assert.equal(ch.pmdAnimTime, 0, 'the clock restarts for the one-shot');
  assert.equal(isOneShotPlaying(ch, src.has), true);

  const shootSec = pmdDurationSec(FULL.Shoot);
  advancePokemonAnim(ch, shootSec / 2, src);
  assert.equal(ch.pmdAnim, 'toolWrite', 'still playing halfway through');
  advancePokemonAnim(ch, shootSec / 2 + 0.01, src);
  assert.equal(ch.pmdAnim, null, 'retired once it played through');
  assert.equal(ch.oneShotCooldown, POKEMON_ONE_SHOT_GAP_SEC, 'the gap before the next starts');
  advancePokemonAnim(ch, 0.01, src);
  assert.equal(anim(ch)?.anim, 'Idle');
  assert.equal(ch.pmdAnimTime, 0, 'the loop starts from its first frame');
});

test('gestures, messages and hops wait POKEMON_ONE_SHOT_GAP_SEC after the last one', () => {
  const ch = seatedWorking('Bash');
  const src = source(FULL);
  assert.equal(startPokemonOneShot(ch, 'message', { faceRow: 2 }), true);
  advancePokemonAnim(ch, 0, src);
  assert.equal(ch.faceOverride, 2, 'faces the receiver');
  assert.equal(startPokemonOneShot(ch, 'toolWrite'), false, 'never interrupts one playing');
  assert.equal(startPokemonOneShot(ch, 'turnEnd', { force: true }), false, 'nor when forced');
  advancePokemonAnim(ch, pmdDurationSec(FULL.Attack) + 0.01, src);
  assert.equal(ch.pmdAnim, null);
  assert.equal(ch.faceOverride, null, 'facing returns to its direction');

  for (const kind of ['toolWrite', 'toolRead', 'message', 'turnEnd'] as const) {
    assert.equal(startPokemonOneShot(ch, kind), false, `${kind} right after: refused`);
  }
  advancePokemonAnim(ch, POKEMON_ONE_SHOT_GAP_SEC - 0.1, src);
  assert.equal(startPokemonOneShot(ch, 'turnEnd'), false, 'still inside the gap');
  advancePokemonAnim(ch, 0.1, src);
  assert.equal(startPokemonOneShot(ch, 'turnEnd'), true, 'the gap has passed');
});

test('Wake and Hurt always play, restarting whatever plays; their end starts the gap', () => {
  const ch = idleChar();
  const src = source(FULL);
  startPokemonOneShot(ch, 'turnEnd');
  advancePokemonAnim(ch, 0, src);
  advancePokemonAnim(ch, 0.02, src);
  assert.equal(startPokemonOneShot(ch, 'wake'), false, 'not forced: left alone');
  assert.equal(startPokemonOneShot(ch, 'wake', { force: true }), true);
  advancePokemonAnim(ch, 0, src);
  assert.equal(ch.pmdAnim, 'wake');
  assert.equal(ch.pmdAnimTime, 0, 'rewound');
  assert.equal(anim(ch)?.anim, 'Wake');
  assert.equal(anim(ch, without('Wake'))?.anim, 'Hop');
  advancePokemonAnim(ch, pmdDurationSec(FULL.Wake) + 0.01, src);
  assert.equal(ch.pmdAnim, null);
  assert.equal(startPokemonOneShot(ch, 'toolWrite'), false, 'no gesture right after waking');
});

test('a one-shot the species cannot play is dropped at once, with no gap', () => {
  const ch = idleChar();
  const src = source(without('Hop'));
  startPokemonOneShot(ch, 'turnEnd');
  assert.equal(isOneShotPlaying(ch, src.has), false);
  advancePokemonAnim(ch, 0.016, src);
  assert.equal(ch.pmdAnim, null);
  assert.equal(ch.oneShotCooldown ?? 0, 0);
  assert.equal(anim(ch, without('Hop'))?.anim, 'Idle');
});

test('a busy session: tool starts every 0.4-1.6 s for 2 min never loop a fast anim', () => {
  // The owner's report: at the desk they shook. Drive a working Pokémon with
  // a tool start (Write, Bash, Read, Grep, Edit) every 0.4-1.6 s, a message
  // now and then and a turn end each 20 s, at 60 fps, and watch every frame.
  setProviderCapabilities({ readingTools: ['Read', 'Grep'], subagentToolNames: [] });
  const ch = seatedWorking('Bash');
  const src = source(FULL);
  const dt = 1 / 60;
  const tools = ['Write', 'Bash', 'Read', 'Grep', 'Edit'];
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let nextTool = 0;
  let nextMessage = 3;
  let toolStarts = 0;
  const starts: Array<{ t: number; kind: string }> = [];
  const loops = new Set<string>();
  let last: string | null = null;
  for (let t = 0; t < 120; t += dt) {
    ch.isActive = t % 20 < 19; // a turn ends every 20 s, the next starts 1 s later
    if (ch.isActive && t >= nextTool) {
      ch.currentTool = tools[Math.floor(random() * tools.length)];
      toolStarts++;
      if (startPokemonOneShot(ch, toolOneShot(ch.currentTool))) {
        starts.push({ t, kind: ch.pmdAnim! });
      }
      nextTool = t + 0.4 + random() * 1.2;
    }
    if (t >= nextMessage) {
      if (startPokemonOneShot(ch, 'message', { faceRow: 2 })) starts.push({ t, kind: 'message' });
      nextMessage = t + 5;
    }
    if (!ch.isActive && last !== 'turnEnd' && t % 20 >= 19 && t % 20 < 19 + dt) {
      if (startPokemonOneShot(ch, 'turnEnd')) starts.push({ t, kind: 'turnEnd' });
    }
    advancePokemonAnim(ch, dt, src);
    const chosen = choosePokemonAnim(ch, src.has)!;
    if (chosen.loop) {
      loops.add(chosen.anim);
      const durations = pmdPlayDurations(FULL[chosen.anim], true);
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      assert.ok(avg >= POKEMON_LOOP_MIN_AVG_TICKS, `${chosen.anim} loops at ${avg} ticks`);
    }
    last = ch.pmdAnim ?? null;
  }
  assert.ok(toolStarts > 100, `a busy session (${toolStarts} tool starts)`);
  for (const fast of ['Charge', 'Shoot', 'Attack']) assert.ok(!loops.has(fast), `no ${fast} loop`);
  assert.deepEqual([...loops].sort(), ['Idle']);
  // At most one one-shot per POKEMON_ONE_SHOT_GAP_SEC, and none back to back.
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i].t - starts[i - 1].t;
    assert.ok(gap >= POKEMON_ONE_SHOT_GAP_SEC, `one-shots ${gap.toFixed(2)} s apart`);
  }
  assert.ok(starts.length <= 120 / POKEMON_ONE_SHOT_GAP_SEC + 1, `${starts.length} one-shots`);
  assert.ok(starts.length >= 10, 'gestures still happen now and then');
});

test('loop guard: a loop under POKEMON_LOOP_MIN_AVG_TICKS is slowed; one-shots play as authored', () => {
  const charge = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2];
  const slowed = pmdPlayDurations(charge, true);
  assert.deepEqual(
    slowed,
    charge.map(() => POKEMON_LOOP_MIN_AVG_TICKS),
  );
  assert.equal(pmdPlayDurations(charge, true), slowed, 'worked out once per sheet, not per frame');
  assert.equal(pmdPlayDurations(charge, false), charge, 'a one-shot keeps its timing');
  const walk = [4, 4, 4, 4, 6, 2, 2]; // average 3.7: slowed, in proportion
  const w = pmdPlayDurations(walk, true);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) / w.length - POKEMON_LOOP_MIN_AVG_TICKS) < 1e-9);
  assert.ok(w[4] > w[5], 'the long frame stays the long frame');
  const idle = [40, 2, 3, 3, 3, 2]; // average 8.8: as authored
  assert.equal(pmdPlayDurations(idle, true), idle);
  assert.equal(pmdFrameIndex(slowed, 3.9 / PMD_FPS, true), 0, 'frame 0 holds 4 ticks now');
  assert.equal(pmdFrameIndex(slowed, 4 / PMD_FPS, true), 1);
});

test('a fainted Pokémon takes only the hurt flinch', () => {
  const ch = idleChar();
  ch.isErrored = true;
  assert.equal(startPokemonOneShot(ch, 'toolWrite', { force: true }), false);
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

test('the clock restarts when the animation changes', () => {
  const ch = idleChar();
  const src = source(FULL);
  advancePokemonAnim(ch, 0, src);
  advancePokemonAnim(ch, 1, src);
  advancePokemonAnim(ch, 1, src);
  assert.equal(ch.pmdAnimTime, 2, 'Idle has been playing for 2 s');

  ch.state = CharacterState.WALK;
  advancePokemonAnim(ch, 0.5, src);
  assert.equal(ch.pmdAnimTime, 0, 'Walk starts from frame 0');

  ch.state = CharacterState.IDLE;
  ch.asleep = true;
  advancePokemonAnim(ch, 0.1, src);
  assert.equal(anim(ch)?.anim, 'Sleep');
  assert.equal(ch.pmdAnimTime, 0, 'Sleep starts from frame 0');
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
