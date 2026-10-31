/// <reference lib="dom" />
/**
 * The sound engine on a fake AudioContext (fakeAudio.ts): nothing before a
 * gesture, same-origin cry URLs, one cry at a time through the queue, cut
 * cries fading out, delayed cries waiting for their URL, the faint slide
 * not waiting for a missing cry, sound pack files replacing the synth, and
 * cries and alerts lowering the Jukebox's folder music.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioEngine } from '../src/audio/audioEngine.js';
import {
  SOUND_CRY_STALE_MS,
  SOUND_CRY_STOP_FADE_SEC,
  SOUND_FAINT_CRY_SEMITONES,
  SOUND_FAINT_SFX_DELAY_MS,
} from '../src/audio/constants.js';
import { recipeDuration, SFX_RECIPES } from '../src/audio/sfxRecipes.js';
import type { SfxName, SoundCue, SoundEvent } from '../src/audio/soundEvents.js';
import { cry, sfx, sfxAfterCry } from '../src/audio/soundEvents.js';
import type { SoundPackOverride } from '../src/audio/soundPack.js';
import { soundPackFileUrl } from '../src/audio/soundPack.js';
import type { FakeSource } from './fakeAudio.js';
import { fakeAudioBytes, FakeAudioContext } from './fakeAudio.js';

const ORIGIN = 'http://127.0.0.1:3000';

let ctx: FakeAudioContext | null;
let synth: Array<{ name: SfxName; when: number }>;
let files: Map<string, ArrayBuffer>;
let fetched: string[];
/** duckMusic calls: the length asked for and when (fake clock, ms). */
let ducks: Array<{ ms: number; at: number }>;
let engine: AudioEngine;

const all = (): boolean => true;
const event = (name: SoundEvent['name'], cues: SoundCue[], user = false): SoundEvent => ({
  name,
  agentId: 1,
  cues,
  user,
});
const cryUrl = (dex: number) => `/api/pokemon/cry/${String(dex).padStart(4, '0')}`;

/** A cry the server would serve, lasting `duration` seconds. */
function serveCry(dex: number, duration = 1, announce = true): void {
  files.set(cryUrl(dex), fakeAudioBytes(`cry${dex}`, duration));
  if (announce) engine.setCryUrl(dex, cryUrl(dex));
}

/** Let fetches, decodes and timers due within `ms` run. */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function running(): FakeAudioContext {
  ctx = new FakeAudioContext();
  ctx.state = 'running';
  return ctx;
}

const cries = (): FakeSource[] => ctx!.playing('cry');

beforeEach(() => {
  vi.useFakeTimers();
  ctx = null;
  synth = [];
  files = new Map();
  fetched = [];
  ducks = [];
  engine = new AudioEngine({
    context: () => ctx as unknown as AudioContext | null,
    unlock: () => {
      ctx ??= new FakeAudioContext();
      void ctx.resume();
    },
    fetch: async (url) => {
      fetched.push(url);
      const body = files.get(url);
      return {
        ok: body !== undefined,
        arrayBuffer: async () => body!.slice(0),
      } as unknown as Response;
    },
    origin: () => ORIGIN,
    renderSfx: (_ctx, _destination, name, when) => {
      synth.push({ name, when });
    },
    duckMusic: (ms) => ducks.push({ ms, at: Date.now() }),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('before a gesture', () => {
  it('plays nothing until the context runs, and keeps nothing for later', async () => {
    serveCry(25);
    engine.playEvent(event('needsYou', [sfx('alert'), cry(25)]), all);
    ctx = new FakeAudioContext();
    engine.playEvent(event('needsYou', [sfx('alert'), cry(25)]), all);
    await settle(1_000);
    expect(engine.isRunning()).toBe(false);
    expect(synth).toEqual([]);
    expect(ctx.sources).toEqual([]);

    ctx.state = 'running';
    await settle(1_000);
    expect(synth).toEqual([]);
    engine.playEvent(event('needsYou', [sfx('alert')]), all);
    expect(synth.map((s) => s.name)).toEqual(['alert']);
  });

  it('a test press unlocks the context itself (it runs inside the click)', async () => {
    await engine.testSfx('blip');
    expect(ctx?.state).toBe('running');
    expect(synth.map((s) => s.name)).toEqual(['blip']);
  });
});

describe('cry URLs', () => {
  it('accepts same-origin URLs only', () => {
    engine.setCryUrl(25, '/api/pokemon/cry/0025');
    engine.setCryUrl(150, `${ORIGIN}/api/pokemon/cry/0150`);
    engine.setCryUrl(4, 'https://evil.example/cry.ogg');
    engine.setCryUrl(7, '//evil.example/api/pokemon/cry/0007');
    engine.setCryUrl(1, 'javascript:alert(1)');
    engine.setCryUrl(2, 'data:audio/ogg;base64,AAAA');
    expect(engine.cryDexes().sort((a, b) => a - b)).toEqual([25, 150]);
  });
});

describe('one cry at a time', () => {
  it('the next cry waits for the one playing; a third waiting one is dropped', async () => {
    running();
    for (const dex of [1, 4, 7, 25]) serveCry(dex);
    for (const dex of [1, 4, 7, 25]) engine.playEvent(event('arrived', [cry(dex)]), all);
    await settle();
    expect(cries().map((s) => s.buffer!.label)).toEqual(['cry1']);
    cries()[0].end();
    await settle();
    expect(cries().map((s) => s.buffer!.label)).toEqual(['cry1', 'cry4']);
    cries()[1].end();
    await settle();
    cries()[2].end();
    await settle();
    expect(cries().map((s) => s.buffer!.label)).toEqual(['cry1', 'cry4', 'cry7']);
  });

  it('a waiting cry that went stale is dropped, not played late', async () => {
    running();
    serveCry(1, 4);
    serveCry(4);
    engine.playEvent(event('arrived', [cry(1)]), all);
    await settle();
    engine.playEvent(event('arrived', [cry(4)]), all);
    await settle(SOUND_CRY_STALE_MS + 1_000);
    cries()[0].end();
    await settle();
    expect(cries()).toHaveLength(1);
  });

  it('a long cry that loaded slowly still holds the queue past the load watchdog', async () => {
    running();
    serveCry(1, 4);
    serveCry(4);
    engine.playEvent(event('faint', [cry(1, 0, SOUND_FAINT_CRY_SEMITONES)]), all);
    await settle();
    expect(cries()).toHaveLength(1);
    expect(cries()[0].playbackRate.value).toBeCloseTo(2 ** (SOUND_FAINT_CRY_SEMITONES / 12));
    // 3.2 s in, the slowed-down cry (4 s / 0.79) is still sounding.
    await settle(3_200);
    engine.playEvent(event('arrived', [cry(4)]), all);
    await settle();
    expect(cries()).toHaveLength(1);
    expect(cries()[0].stoppedAt).toBeNull();
  });

  it('a cry whose end never comes is faded out when the next one gets its turn', async () => {
    running();
    serveCry(1, 1);
    serveCry(4);
    engine.playEvent(event('arrived', [cry(1)]), all);
    await settle();
    const first = cries()[0];
    // Past its duration and the grace, with no `ended` event.
    await settle(2_000);
    ctx!.currentTime = 2;
    engine.playEvent(event('arrived', [cry(4)]), all);
    await settle();
    expect(first.stoppedAt).toBeCloseTo(2 + SOUND_CRY_STOP_FADE_SEC);
    expect(first.env.gain.last()).toEqual({
      op: 'linear',
      value: 0,
      time: 2 + SOUND_CRY_STOP_FADE_SEC,
    });
    expect(cries()).toHaveLength(2);
  });

  it("a user's cry interrupts the one playing with a short fade, not a click", async () => {
    running();
    serveCry(1, 2);
    serveCry(4);
    engine.playEvent(event('arrived', [cry(1)]), all);
    await settle();
    const first = cries()[0];
    ctx!.currentTime = 0.5;
    await engine.playUserEvent(event('pokedex', [cry(4)], true), all);
    await settle();
    expect(first.stoppedAt).toBeCloseTo(0.5 + SOUND_CRY_STOP_FADE_SEC);
    expect(first.env.gain.last()?.value).toBe(0);
    expect(cries().map((s) => s.buffer!.label)).toEqual(['cry1', 'cry4']);
    expect(cries()[1].stoppedAt).toBeNull();
  });

  it('stopAll fades the cry out and drops waiting cries and delayed cues', async () => {
    running();
    serveCry(1, 2);
    serveCry(4);
    serveCry(7);
    engine.playEvent(event('arrived', [cry(1)]), all);
    await settle();
    engine.playEvent(event('arrived', [cry(4)]), all);
    engine.playEvent(event('arrived', [cry(7, 500)]), all);
    engine.stopAll();
    expect(cries()[0].stoppedAt).toBeCloseTo(SOUND_CRY_STOP_FADE_SEC);
    cries()[0].end();
    await settle(1_000);
    expect(cries()).toHaveLength(1);
  });
});

describe('cues', () => {
  it('a delayed cry plays if its URL arrives before the cue fires (a species new to the office)', async () => {
    running();
    serveCry(25, 1, false);
    engine.playEvent(event('arrived', [sfx('ballPop'), cry(25, 260)]), all);
    expect(synth.map((s) => s.name)).toEqual(['ballPop']);
    await settle(100);
    engine.setCryUrl(25, cryUrl(25));
    await settle(200);
    expect(cries().map((s) => s.buffer!.label)).toEqual(['cry25']);
  });

  it('a delayed cry whose URL never arrives is skipped without a request', async () => {
    running();
    engine.playEvent(event('arrived', [sfx('ballPop'), cry(25, 260)]), all);
    await settle(1_000);
    expect(cries()).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it('the faint slide waits for the cry only when the cry plays', async () => {
    running();
    serveCry(25);
    ctx!.currentTime = 10;
    const faint = event('faint', [
      cry(25, 0, SOUND_FAINT_CRY_SEMITONES),
      sfxAfterCry('faint', SOUND_FAINT_SFX_DELAY_MS),
    ]);
    engine.playEvent(faint, all);
    expect(synth).toEqual([{ name: 'faint', when: 10 + SOUND_FAINT_SFX_DELAY_MS / 1000 }]);
    synth = [];
    engine.playEvent(faint, (cue) => cue.kind === 'sfx');
    expect(synth).toEqual([{ name: 'faint', when: 10 }]);
  });
});

describe('sound pack', () => {
  const override = (name: SfxName): SoundPackOverride => ({
    event: name,
    format: 'ogg',
    size: 100,
    version: '1-1',
  });

  it('a pack file replaces the synth; a missing or broken one falls back to it', async () => {
    running();
    const levelUp = override('levelUp');
    const heal = override('heal');
    const recall = override('recall');
    files.set(soundPackFileUrl(levelUp), fakeAudioBytes('pack-levelUp', 0.5));
    files.set(soundPackFileUrl(recall), new TextEncoder().encode('not audio').buffer);
    engine.setPackOverrides([levelUp, heal, recall]);
    await settle();
    engine.playEvent(event('levelUp', [sfx('levelUp')]), all);
    engine.playEvent(event('revived', [sfx('heal')]), all);
    engine.playEvent(event('recall', [sfx('recall')]), all);
    await settle();
    expect(ctx!.playing('pack').map((s) => s.buffer!.label)).toEqual(['pack-levelUp']);
    expect(synth.map((s) => s.name).sort()).toEqual(['heal', 'recall']);
  });
});

describe('music ducking', () => {
  const ms = (name: SfxName) => recipeDuration(SFX_RECIPES[name]) * 1000;

  it('a cry lowers folder music for its length, pitch included', async () => {
    running();
    serveCry(25, 1.5);
    engine.playEvent(event('faint', [cry(25, 0, SOUND_FAINT_CRY_SEMITONES)]), all);
    expect(ducks).toEqual([]);
    await settle();
    expect(ducks).toHaveLength(1);
    expect(ducks[0].ms).toBeCloseTo((1.5 / 2 ** (SOUND_FAINT_CRY_SEMITONES / 12)) * 1000);
  });

  it('alerts duck the music for their length; effects never do', async () => {
    running();
    engine.playEvent(event('needsYou', [sfx('alert')]), all);
    engine.playEvent(event('levelUp', [sfx('levelUp')]), all);
    engine.playEvent(event('arrived', [sfx('ballPop')]), all);
    await settle();
    expect(ducks.map((d) => d.ms)).toEqual([ms('alert')]);
  });

  it('a delayed alert ducks when it starts, not when its event fires', async () => {
    running();
    serveCry(25, 1);
    const start = Date.now();
    engine.playEvent(
      event('faint', [cry(25, 0, SOUND_FAINT_CRY_SEMITONES), sfxAfterCry('faint', 700)]),
      all,
    );
    await settle();
    expect(ducks).toHaveLength(1); // the cry
    await settle(700);
    expect(ducks).toHaveLength(2);
    expect(ducks[1]).toEqual({ ms: ms('faint'), at: start + 700 });
  });

  it("a sound pack alert ducks for the file's length", async () => {
    running();
    const alert: SoundPackOverride = { event: 'alert', format: 'ogg', size: 100, version: '1-1' };
    files.set(soundPackFileUrl(alert), fakeAudioBytes('pack-alert', 0.8));
    engine.setPackOverrides([alert]);
    await settle();
    engine.playEvent(event('needsYou', [sfx('alert')]), all);
    await settle();
    expect(ctx!.playing('pack')).toHaveLength(1);
    expect(ducks.map((d) => d.ms)).toEqual([800]);
  });

  it('nothing ducks while the context is locked (nothing plays)', async () => {
    serveCry(25);
    engine.playEvent(event('needsYou', [sfx('alert'), cry(25)]), all);
    await settle(1_000);
    expect(ducks).toEqual([]);
  });
});
