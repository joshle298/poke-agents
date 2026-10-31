/**
 * Plays the office's Pokémon sounds on the shared AudioContext
 * (notificationSound.sharedAudioContext, passed in by usePokemonSounds.ts),
 * which only a user gesture unlocks.
 * Until it runs, every sound is dropped: nothing is queued to burst out
 * after the first click.
 *
 *   synth (alerts)  → crusher ┐
 *   pack file (alerts) ───────┴→ alerts bus ─────────────┐
 *   synth (effects) → crusher ┐                          ├→ master (volume) → speakers
 *   pack file (effects) ──────┴→ effects bus → duck ─────┤
 *   cry ─────────────────────────→ cries bus ────────────┘
 *
 * Cries play one at a time through a CryQueue (soundLimiter.ts) and duck the
 * effects bus while they sound; a cry cut short fades out. Cries and alerts
 * also lower the Jukebox's radio and folder music for their length (music/duck.ts).
 * Cry and sound-pack files are fetched from the local server, decoded once
 * and kept.
 */

import { duckMusic } from '../music/duck.js';
import {
  SOUND_BUFFER_FADE_SEC,
  SOUND_BUS_GAIN_ALERTS,
  SOUND_BUS_GAIN_CRIES,
  SOUND_BUS_GAIN_EFFECTS,
  SOUND_CRUSH_LEVELS,
  SOUND_CRY_LOAD_WAIT_MS,
  SOUND_CRY_STOP_FADE_SEC,
  SOUND_DEFAULT_VOLUME,
  SOUND_DUCK_ATTACK_SEC,
  SOUND_DUCK_GAIN,
  SOUND_DUCK_RELEASE_SEC,
  SOUND_LOAD_RETRY_MS,
  SOUND_VOLUME_RAMP_SEC,
} from './constants.js';
import { loudnessGain } from './loudness.js';
import { isSameOriginUrl, pageOrigin } from './sameOrigin.js';
import { recipeDuration, SFX_RECIPES } from './sfxRecipes.js';
import type { SfxName, SoundCue, SoundEvent } from './soundEvents.js';
import { keepCues, SFX_CATEGORY } from './soundEvents.js';
import type { CryRequest } from './soundLimiter.js';
import { CryQueue } from './soundLimiter.js';
import type { SoundPackOverride } from './soundPack.js';
import { soundPackFileUrl } from './soundPack.js';
import { createCrusher, playRecipe } from './synth.js';

/** What the engine needs from the page; tests pass fakes. */
export interface AudioEngineDeps {
  /** The office's AudioContext, or null until a gesture (or a chime) made one. */
  context: () => AudioContext | null;
  /** Create or resume the context: call inside a user gesture. */
  unlock: () => void;
  fetch: (url: string) => Promise<Response>;
  /** The page's origin: cry URLs must match it. */
  origin: () => string | undefined;
  /** Schedule a synthesized effect into `destination` at audio time `when`. */
  renderSfx: (ctx: AudioContext, destination: AudioNode, name: SfxName, when: number) => void;
  /** Lower the Jukebox's radio and folder music for `ms`: called as a cry or
   *  an alert starts, with that sound's length. */
  duckMusic: (ms: number) => void;
}

const PAGE_DEFAULTS: Omit<AudioEngineDeps, 'context' | 'unlock'> = {
  fetch: (url) => fetch(url),
  origin: pageOrigin,
  renderSfx: (ctx, destination, name, when) => {
    playRecipe(ctx, destination, SFX_RECIPES[name], when);
  },
  duckMusic: (ms) => duckMusic(ms),
};

/** The cry sounding now: its source, and the envelope a cut fades out. */
interface PlayingCry {
  g: Graph;
  source: AudioBufferSourceNode;
  env: GainNode;
}

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  cries: GainNode;
  alerts: GainNode;
  effects: GainNode;
  duck: GainNode;
  alertsSynth: AudioNode;
  effectsSynth: AudioNode;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export class AudioEngine {
  private readonly deps: AudioEngineDeps;
  private g: Graph | null = null;
  private volume = SOUND_DEFAULT_VOLUME;
  private readonly cryUrls = new Map<number, string>();
  private readonly pack = new Map<SfxName, SoundPackOverride>();
  private readonly bytes = new Map<string, Promise<ArrayBuffer | null>>();
  private readonly buffers = new Map<string, AudioBuffer>();
  /** Loudness-matching gain per decoded file. */
  private readonly levels = new WeakMap<AudioBuffer, number>();
  private readonly failedAt = new Map<string, number>();
  /** Files this browser can't decode (an Ogg cry in some Safari versions):
   *  never fetched again this session. */
  private readonly undecodable = new Set<string>();
  private readonly cryQueue = new CryQueue();
  private cryToken = 0;
  private currentCry: PlayingCry | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(deps: Pick<AudioEngineDeps, 'context' | 'unlock'> & Partial<AudioEngineDeps>) {
    this.deps = { ...PAGE_DEFAULTS, ...deps };
  }

  // ── Inputs ─────────────────────────────────────────────────

  /** The species payload's cry URL. Same-origin only. */
  setCryUrl(dex: number, url: string): void {
    if (isSameOriginUrl(url, this.deps.origin())) this.cryUrls.set(dex, url);
  }

  hasCry(dex: number): boolean {
    return this.cryUrls.has(dex);
  }

  /** Any species whose cry the office could play (the Settings test). */
  anyCryDex(): number | undefined {
    return this.cryUrls.keys().next().value;
  }

  /** Every species whose cry the office could play. */
  cryDexes(): number[] {
    return [...this.cryUrls.keys()];
  }

  /** Fetch a cry's bytes ahead of its first use (decoded when it plays). */
  prefetchCry(dex: number): void {
    const url = this.cryUrls.get(dex);
    if (url) void this.fetchBytes(url);
  }

  setPackOverrides(overrides: readonly SoundPackOverride[]): void {
    this.pack.clear();
    for (const override of overrides) {
      this.pack.set(override.event, override);
      void this.fetchBytes(soundPackFileUrl(override));
    }
  }

  setVolume(volume: number): void {
    this.volume = volume;
    const g = this.g;
    if (!g) return;
    const now = g.ctx.currentTime;
    g.master.gain.cancelScheduledValues(now);
    g.master.gain.setValueAtTime(g.master.gain.value, now);
    g.master.gain.linearRampToValueAtTime(volume, now + SOUND_VOLUME_RAMP_SEC);
  }

  /** The AudioContext has been unlocked by a gesture and is running. */
  isRunning(): boolean {
    return this.deps.context()?.state === 'running';
  }

  // ── Playing ────────────────────────────────────────────────

  /**
   * Play the cues of an admitted event that `allow` lets through. A delayed
   * cry plays only if its URL is known when its turn comes: a species new to
   * the office gets its URL (pokemonSpeciesLoaded) just after its arrival.
   */
  playEvent(event: SoundEvent, allow: (cue: SoundCue) => boolean): void {
    const g = this.graph();
    if (!g) return;
    for (const cue of keepCues(event.cues, allow)) {
      if (cue.kind === 'sfx') {
        this.playSfx(g, cue.name, g.ctx.currentTime + cue.delayMs / 1000);
      } else {
        const request = { dex: cue.dex, semitones: cue.semitones, user: event.user === true };
        this.later(cue.delayMs, () => {
          if (this.hasCry(cue.dex)) this.requestCry({ ...request, at: Date.now() });
        });
      }
    }
  }

  /** An event a user gesture started: the gesture may have only just asked
   *  the context to resume, so wait for it. */
  async playUserEvent(event: SoundEvent, allow: (cue: SoundCue) => boolean): Promise<void> {
    if (await this.unlockedGraph()) this.playEvent(event, allow);
  }

  /** Settings → Test sounds: unlock (this runs in a click) and play. */
  async testSfx(name: SfxName): Promise<void> {
    const g = await this.unlockedGraph();
    if (g) this.playSfx(g, name, g.ctx.currentTime);
  }

  async testCry(dex: number, semitones = 0): Promise<void> {
    const g = await this.unlockedGraph();
    if (g) this.requestCry({ dex, semitones, at: Date.now(), user: true });
  }

  /** Sound switched off: drop everything pending and fade the cry out. */
  stopAll(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.cryQueue.clear();
    this.cryToken++;
    this.stopCurrentCry();
  }

  // ── Internals ──────────────────────────────────────────────

  private later(delayMs: number, run: () => void): void {
    if (delayMs <= 0) {
      run();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, delayMs);
    this.timers.add(timer);
  }

  private graph(): Graph | null {
    const ctx = this.deps.context();
    if (!ctx || ctx.state !== 'running') return null;
    if (this.g?.ctx === ctx) return this.g;
    const gain = (value: number, to: AudioNode) => {
      const node = ctx.createGain();
      node.gain.value = value;
      node.connect(to);
      return node;
    };
    const master = gain(this.volume, ctx.destination);
    const duck = gain(1, master);
    const alerts = gain(SOUND_BUS_GAIN_ALERTS, master);
    const effects = gain(SOUND_BUS_GAIN_EFFECTS, duck);
    const cries = gain(SOUND_BUS_GAIN_CRIES, master);
    const alertsSynth = createCrusher(ctx, SOUND_CRUSH_LEVELS);
    alertsSynth.connect(alerts);
    const effectsSynth = createCrusher(ctx, SOUND_CRUSH_LEVELS);
    effectsSynth.connect(effects);
    this.g = { ctx, master, cries, alerts, effects, duck, alertsSynth, effectsSynth };
    return this.g;
  }

  private async unlockedGraph(): Promise<Graph | null> {
    this.deps.unlock();
    const ctx = this.deps.context();
    if (!ctx) return null;
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        return null;
      }
    }
    return this.graph();
  }

  private playSfx(g: Graph, name: SfxName, when: number): void {
    const alerts = SFX_CATEGORY[name] === 'alerts';
    const bus = alerts ? g.alerts : g.effects;
    const synth = (at: number) => {
      this.deps.renderSfx(g.ctx, alerts ? g.alertsSynth : g.effectsSynth, name, at);
      if (alerts) this.duckMusicFor(g, at, recipeDuration(SFX_RECIPES[name]));
    };
    const file = (buffer: AudioBuffer, at: number) => {
      const { duration } = this.playBuffer(g, buffer, bus, at, 1);
      if (alerts) this.duckMusicFor(g, at, duration);
    };
    const override = this.pack.get(name);
    const url = override ? soundPackFileUrl(override) : null;
    if (!url || this.recentlyFailed(url)) {
      synth(when);
      return;
    }
    const ready = this.buffers.get(url);
    if (ready) {
      file(ready, when);
      return;
    }
    // The pack file is local: wait for it rather than play the synth.
    void this.decoded(url, g.ctx).then((buffer) => {
      if (this.g !== g) return;
      const at = Math.max(when, g.ctx.currentTime);
      if (buffer) file(buffer, at);
      else synth(at);
    });
  }

  /** The Jukebox's radio and folder music dip while a cry or an alert sounds:
   *  from audio time `when` for `seconds`. A cue scheduled ahead (the faint slide
   *  after its cry) is already in the audio graph, so stopAll doesn't cancel
   *  its duck either. */
  private duckMusicFor(g: Graph, when: number, seconds: number): void {
    const delayMs = Math.max(0, (when - g.ctx.currentTime) * 1000);
    const duck = () => this.deps.duckMusic(seconds * 1000);
    if (delayMs <= 0) duck();
    else setTimeout(duck, delayMs);
  }

  private playBuffer(
    g: Graph,
    buffer: AudioBuffer,
    destination: AudioNode,
    when: number,
    rate: number,
  ): { source: AudioBufferSourceNode; env: GainNode; duration: number } {
    let level = this.levels.get(buffer);
    if (level === undefined) {
      level = loudnessGain(buffer.getChannelData(0));
      this.levels.set(buffer, level);
    }
    const duration = buffer.duration / rate;
    const fade = Math.min(SOUND_BUFFER_FADE_SEC, duration / 4);
    const env = g.ctx.createGain();
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(level, when + fade);
    env.gain.setValueAtTime(level, when + duration - fade);
    env.gain.linearRampToValueAtTime(0, when + duration);
    env.connect(destination);
    const source = g.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(env);
    source.start(when);
    source.addEventListener('ended', () => env.disconnect());
    return { source, env, duration };
  }

  private requestCry(request: CryRequest): void {
    if (!this.graph()) return;
    const verdict = this.cryQueue.request(request, Date.now());
    if (verdict !== 'play') return;
    // A user's cry interrupts; any other 'play' means the cry before it
    // overran its watchdog. Either way only one cry sounds.
    this.stopCurrentCry();
    void this.startCry(request);
  }

  private async startCry(request: CryRequest): Promise<void> {
    const token = ++this.cryToken;
    const g = this.graph();
    const url = this.cryUrls.get(request.dex);
    if (!g || !url) {
      this.cryEnded(token);
      return;
    }
    // A cry that takes too long to load is dropped, not played late.
    const buffer = await withTimeout(this.decoded(url, g.ctx), SOUND_CRY_LOAD_WAIT_MS);
    if (token !== this.cryToken) return;
    if (!buffer || this.graph() !== g) {
      this.cryEnded(token);
      return;
    }
    const when = g.ctx.currentTime;
    const rate = 2 ** (request.semitones / 12);
    const { source, env, duration } = this.playBuffer(g, buffer, g.cries, when, rate);
    this.currentCry = { g, source, env };
    this.cryQueue.started(Date.now(), duration * 1000);
    this.duck(g, when, duration);
    this.duckMusicFor(g, when, duration);
    source.addEventListener('ended', () => this.cryEnded(token));
  }

  private cryEnded(token: number): void {
    if (token !== this.cryToken) return;
    this.currentCry = null;
    const next = this.cryQueue.finished(Date.now());
    if (next) void this.startCry(next);
  }

  /** Fade the sounding cry out (stopping it at full level would click) and
   *  let the effects back up. */
  private stopCurrentCry(): void {
    const playing = this.currentCry;
    this.currentCry = null;
    if (!playing) return;
    const { g, source, env } = playing;
    const now = g.ctx.currentTime;
    const end = now + SOUND_CRY_STOP_FADE_SEC;
    env.gain.cancelScheduledValues(now);
    env.gain.setValueAtTime(env.gain.value, now);
    env.gain.linearRampToValueAtTime(0, end);
    try {
      source.stop(end);
    } catch {
      // Already stopped.
    }
    const duck = g.duck.gain;
    duck.cancelScheduledValues(now);
    duck.setValueAtTime(duck.value, now);
    duck.linearRampToValueAtTime(1, now + SOUND_DUCK_RELEASE_SEC);
  }

  /** Effects step back while a cry sounds. */
  private duck(g: Graph, when: number, duration: number): void {
    const p = g.duck.gain;
    p.cancelScheduledValues(when);
    p.setValueAtTime(p.value, when);
    p.linearRampToValueAtTime(SOUND_DUCK_GAIN, when + SOUND_DUCK_ATTACK_SEC);
    p.setValueAtTime(SOUND_DUCK_GAIN, when + Math.max(SOUND_DUCK_ATTACK_SEC, duration));
    p.linearRampToValueAtTime(
      1,
      when + Math.max(SOUND_DUCK_ATTACK_SEC, duration) + SOUND_DUCK_RELEASE_SEC,
    );
  }

  private recentlyFailed(url: string): boolean {
    if (this.undecodable.has(url)) return true;
    const at = this.failedAt.get(url);
    return at !== undefined && Date.now() - at < SOUND_LOAD_RETRY_MS;
  }

  /** The file's bytes, fetched once (a failure is retried after SOUND_LOAD_RETRY_MS). */
  private fetchBytes(url: string): Promise<ArrayBuffer | null> {
    const existing = this.bytes.get(url);
    if (existing) return existing;
    if (this.recentlyFailed(url)) return Promise.resolve(null);
    const pending = this.deps
      .fetch(url)
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .catch(() => null)
      .then((data) => {
        if (!data) {
          this.bytes.delete(url);
          this.failedAt.set(url, Date.now());
        }
        return data;
      });
    this.bytes.set(url, pending);
    return pending;
  }

  /** The decoded file, decoding once per URL. */
  private async decoded(url: string, ctx: AudioContext): Promise<AudioBuffer | null> {
    const ready = this.buffers.get(url);
    if (ready) return ready;
    const data = await this.fetchBytes(url);
    if (!data) return null;
    try {
      // decodeAudioData detaches its input: keep the fetched bytes intact.
      const buffer = await ctx.decodeAudioData(data.slice(0));
      this.buffers.set(url, buffer);
      return buffer;
    } catch {
      // Not decodable here (an Ogg cry in a browser without Vorbis): give up on it.
      this.undecodable.add(url);
      this.bytes.delete(url);
      return null;
    }
  }
}
