/**
 * The gates between the sound policy and the engine: no automatic sound
 * before a gesture, the Sounds switch and the Cries / Alerts / Effects
 * toggles (tests and the volume blip included), delayed cries for species
 * whose URL comes later, cries fetched only after a gesture, a failure that
 * never escapes the message handler, and the upstream chime handoff.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from '../../core/src/messages.js';
import { upstreamPermissionChimes, upstreamStatusChime } from '../src/audio/chimeHandoff.js';
import {
  SOUND_ALERT_CRY_DELAY_MS,
  SOUND_ARRIVAL_CHAIN_MS,
  SOUND_LEVEL_SETTLE_MS,
  SOUND_POP_CRY_DELAY_MS,
  SOUND_QUIET_AFTER_CONNECT_MS,
} from '../src/audio/constants.js';
import type { SoundEngine } from '../src/audio/soundController.js';
import { SoundController } from '../src/audio/soundController.js';
import type { SfxName, SoundCue, SoundEvent } from '../src/audio/soundEvents.js';
import { cry, keepCues, sfx } from '../src/audio/soundEvents.js';
import { SoundLimiter } from '../src/audio/soundLimiter.js';
import { SoundDirector } from '../src/audio/soundPolicy.js';
import type { SoundPrefs } from '../src/audio/soundPrefs.js';
import { statusChimeFor } from '../src/office/chimePolicy.js';

const PIKACHU = 25;
const CHARMANDER = 4;

class FakeEngine implements SoundEngine {
  running = false;
  failing = false;
  readonly urls = new Map<number, string>();
  readonly played: Array<{ name: string; cues: SoundCue[]; user: boolean }> = [];
  readonly prefetched: number[] = [];
  readonly tests: string[] = [];

  setCryUrl(dex: number, url: string): void {
    this.urls.set(dex, url);
  }
  hasCry(dex: number): boolean {
    return this.urls.has(dex);
  }
  anyCryDex(): number | undefined {
    return this.urls.keys().next().value;
  }
  cryDexes(): number[] {
    return [...this.urls.keys()];
  }
  prefetchCry(dex: number): void {
    this.prefetched.push(dex);
  }
  isRunning(): boolean {
    return this.running;
  }
  playEvent(event: SoundEvent, allow: (cue: SoundCue) => boolean): void {
    if (this.failing) throw new Error('Web Audio failed');
    this.played.push({ name: event.name, cues: keepCues(event.cues, allow), user: false });
  }
  async playUserEvent(event: SoundEvent, allow: (cue: SoundCue) => boolean): Promise<void> {
    this.played.push({ name: event.name, cues: keepCues(event.cues, allow), user: true });
  }
  async testSfx(name: SfxName): Promise<void> {
    this.tests.push(name);
  }
  async testCry(dex: number): Promise<void> {
    this.tests.push(`cry:${dex}`);
  }
}

let now: number;
let soundOn: boolean;
let prefs: SoundPrefs;
let selected: number | null;
let engine: FakeEngine;
let controller: SoundController;

const send = (msg: ServerMessage) => controller.handle(msg);
const names = () => engine.played.map((p) => p.name);

function created(id: number, species = PIKACHU): ServerMessage {
  return { type: 'agentCreated', id, providerId: 'conductor', species, level: 5 };
}

function status(id: number, value: 'active' | 'waiting' | 'error', awaitingInput = false) {
  return { type: 'agentStatus', id, status: value, awaitingInput } as ServerMessage;
}

function speciesLoaded(dex: number): ServerMessage {
  return {
    type: 'pokemonSpeciesLoaded',
    dex,
    shiny: false,
    name: `#${dex}`,
    shadowSize: 1,
    anims: {},
    portraits: {},
    credits: { sprite: [], portrait: [], pageUrl: '' },
    cry: `/api/pokemon/cry/${String(dex).padStart(4, '0')}`,
  };
}

/** Past the quiet window and the initial load, with agents already in. */
function liveOffice(...ids: number[]): void {
  controller.connected();
  now += SOUND_QUIET_AFTER_CONNECT_MS + SOUND_ARRIVAL_CHAIN_MS + 1;
  for (const id of ids) send(created(id));
  now += SOUND_LEVEL_SETTLE_MS + 1;
  // Their arrival sounds aren't what the tests look at.
  engine.played.length = 0;
}

/** An agent that was working asks you something. */
function needsYou(id: number): void {
  send(status(id, 'active'));
  send(status(id, 'waiting', true));
}

beforeEach(() => {
  now = 1_000_000;
  soundOn = true;
  prefs = { volume: 0.6, cries: true, alerts: true, effects: true };
  selected = null;
  engine = new FakeEngine();
  engine.running = true;
  engine.setCryUrl(PIKACHU, '/api/pokemon/cry/0025');
  controller = new SoundController({
    director: new SoundDirector(),
    limiter: new SoundLimiter(),
    engine,
    soundEnabled: () => soundOn,
    prefs: () => prefs,
    selectedAgentId: () => selected,
    now: () => now,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('before the first gesture', () => {
  it('plays no automatic sound, and keeps none for later', () => {
    engine.running = false;
    liveOffice(1);
    needsYou(1);
    send(created(2));
    expect(engine.played).toEqual([]);

    engine.running = true;
    now += 1_000;
    send(created(3));
    expect(names()).toEqual(['arrived']);
  });

  it('a Pokédex click still plays: the engine unlocks inside the gesture', () => {
    engine.running = false;
    liveOffice(1);
    controller.pokedexChanged(1, null);
    expect(engine.played).toEqual([{ name: 'pokedex', cues: [cry(PIKACHU)], user: true }]);
  });
});

describe('the Sounds switch', () => {
  it('silences everything: automatic sounds, Pokédex sounds, tests and blips', () => {
    liveOffice(1);
    soundOn = false;
    needsYou(1);
    send(created(2));
    controller.pokedexChanged(1, null);
    controller.pokedexChanged(null, 1);
    controller.blip();
    for (const name of ['cry', 'alert', 'blip', 'levelUp'] as const) {
      expect(controller.canTest(name), name).toBe(false);
      controller.test(name);
    }
    expect(engine.played).toEqual([]);
    expect(engine.tests).toEqual([]);
  });
});

describe('Cries / Alerts / Effects', () => {
  it('drop the cues of a category that is off', () => {
    liveOffice(1);
    prefs = { ...prefs, cries: false };
    needsYou(1);
    expect(engine.played).toEqual([{ name: 'needsYou', cues: [sfx('alert')], user: false }]);
  });

  it('an event with nothing left to play keeps its cooldown', () => {
    liveOffice(1);
    prefs = { ...prefs, cries: false, alerts: false };
    needsYou(1);
    expect(engine.played).toEqual([]);
    prefs = { ...prefs, alerts: true };
    now += 1_000;
    needsYou(1);
    expect(names()).toEqual(['needsYou']);
  });

  it('apply to the Test buttons and the volume blip', () => {
    selected = 1;
    liveOffice(1);
    prefs = { ...prefs, effects: false };
    expect(controller.canTest('blip')).toBe(false);
    controller.test('blip');
    controller.test('levelUp');
    expect(controller.canTest('alert')).toBe(true);
    controller.test('alert');
    controller.test('cry');
    expect(engine.tests).toEqual(['alert', `cry:${PIKACHU}`]);
    prefs = { ...prefs, cries: false };
    controller.test('cry');
    expect(engine.tests).toEqual(['alert', `cry:${PIKACHU}`]);
  });
});

describe('cries', () => {
  it("a delayed cry counts before its species' URL arrives; the engine checks it when it fires", () => {
    liveOffice();
    prefs = { ...prefs, effects: false };
    send(created(1, CHARMANDER));
    expect(engine.played).toEqual([
      { name: 'arrived', cues: [cry(CHARMANDER, SOUND_POP_CRY_DELAY_MS)], user: false },
    ]);
  });

  it('an immediate cry needs its URL now (a Pokédex of a species without one)', () => {
    liveOffice();
    send(created(1, CHARMANDER));
    engine.played.length = 0;
    controller.pokedexChanged(1, null);
    expect(engine.played).toEqual([]);
  });

  it('the alert cry is delayed, so it plays with the alert', () => {
    liveOffice(1);
    needsYou(1);
    expect(engine.played[0].cues).toEqual([sfx('alert'), cry(PIKACHU, SOUND_ALERT_CRY_DELAY_MS)]);
  });

  it('are fetched only after a gesture, and only with Cries on', () => {
    send(speciesLoaded(CHARMANDER));
    expect(engine.prefetched).toEqual([]);
    controller.gesture();
    expect(engine.prefetched.sort((a, b) => a - b)).toEqual([CHARMANDER, PIKACHU]);
    send(speciesLoaded(150));
    expect(engine.prefetched).toContain(150);
    prefs = { ...prefs, cries: false };
    send(speciesLoaded(151));
    expect(engine.prefetched).not.toContain(151);
  });

  it('a gesture with Cries off fetches nothing', () => {
    prefs = { ...prefs, cries: false };
    send(speciesLoaded(CHARMANDER));
    controller.gesture();
    expect(engine.prefetched).toEqual([]);
  });
});

describe('failures', () => {
  it('never escape the message handler, and are logged once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    liveOffice(1, 2);
    engine.failing = true;
    expect(() => needsYou(1)).not.toThrow();
    expect(() => needsYou(2)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('Pokédex', () => {
  it('opening plays its cry, closing a blip, re-rendering nothing', () => {
    liveOffice(1);
    controller.pokedexChanged(1, null);
    controller.pokedexChanged(1, 1);
    controller.pokedexChanged(null, 1);
    expect(engine.played).toEqual([
      { name: 'pokedex', cues: [cry(PIKACHU)], user: true },
      { name: 'uiBlip', cues: [sfx('blip')], user: true },
    ]);
  });
});

describe('upstream chime handoff', () => {
  const inputs = [
    { status: 'waiting', awaitingInput: true },
    { status: 'waiting', awaitingInput: false },
    { status: 'error', awaitingInput: false },
  ];

  it('a Conductor session never plays the upstream chime: its Pokémon sounds do', () => {
    for (const input of inputs) {
      const chime = statusChimeFor({
        ...input,
        silent: false,
        streamAgent: true,
        selected: true,
        pinned: true,
        changed: true,
      });
      expect(chime, input.status).not.toBeNull();
      expect(upstreamStatusChime(chime, 'conductor'), input.status).toBeNull();
    }
    expect(upstreamPermissionChimes('conductor')).toBe(false);
  });

  it('upstream agents keep the chime', () => {
    const done = statusChimeFor({
      status: 'waiting',
      awaitingInput: false,
      silent: false,
      streamAgent: false,
      selected: false,
      pinned: false,
      changed: true,
    });
    expect(upstreamStatusChime(done, undefined)).toBe('done');
    expect(upstreamStatusChime('attention', undefined)).toBe('attention');
    expect(upstreamPermissionChimes(undefined)).toBe(true);
  });
});
