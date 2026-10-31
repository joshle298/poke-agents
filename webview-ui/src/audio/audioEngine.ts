/**
 * Plays the office's Pokémon sounds on the shared AudioContext
 * (notificationSound.sharedAudioContext), which only a user gesture unlocks.
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
 * effects bus while they sound. Cry and sound-pack files are fetched from
 * the local server, decoded once and kept.
 */

import { sharedAudioContext, unlockAudio } from '../notificationSound.js';
import {
  SOUND_BUFFER_FADE_SEC,
  SOUND_BUS_GAIN_ALERTS,
  SOUND_BUS_GAIN_CRIES,
  SOUND_BUS_GAIN_EFFECTS,
  SOUND_CRUSH_LEVELS,
  SOUND_CRY_LOAD_WAIT_MS,
  SOUND_DEFAULT_VOLUME,
  SOUND_DUCK_ATTACK_SEC,
  SOUND_DUCK_GAIN,
  SOUND_DUCK_RELEASE_SEC,
  SOUND_LOAD_RETRY_MS,
  SOUND_VOLUME_RAMP_SEC,
} from './constants.js';
import { loudnessGain } from './loudness.js';
import { isSameOriginUrl, pageOrigin } from './sameOrigin.js';
import { SFX_RECIPES } from './sfxRecipes.js';
import type { SfxName, SoundCue, SoundEvent } from './soundEvents.js';
import { SFX_CATEGORY } from './soundEvents.js';
import type { CryRequest } from './soundLimiter.js';
import { CryQueue } from './soundLimiter.js';
import type { SoundPackOverride } from './soundPack.js';
import { soundPackFileUrl } from './soundPack.js';
import { createCrusher, playRecipe } from './synth.js';

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
  private g: Graph | null = null;
  private volume = SOUND_DEFAULT_VOLUME;
  private readonly cryUrls = new Map<number, string>();
  private readonly pack = new Map<SfxName, SoundPackOverride>();
  private readonly bytes = new Map<string, Promise<ArrayBuffer | null>>();
  private readonly buffers = new Map<string, AudioBuffer>();
  /** Loudness-matching gain per decoded file. */
  private readonly levels = new WeakMap<AudioBuffer, number>();
  private readonly failedAt = new Map<string, number>();
  private readonly cryQueue = new CryQueue();
  private cryToken = 0;
  private currentCry: AudioBufferSourceNode | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  // ── Inputs ─────────────────────────────────────────────────

  /** The species payload's cry URL. Same-origin only. */
  setCryUrl(dex: number, url: string): void {
    if (isSameOriginUrl(url, pageOrigin())) this.cryUrls.set(dex, url);
  }

  hasCry(dex: number): boolean {
    return this.cryUrls.has(dex);
  }

  /** Any species whose cry the office could play (the Settings test). */
  anyCryDex(): number | undefined {
    return this.cryUrls.keys().next().value;
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
    return sharedAudioContext()?.state === 'running';
  }

  // ── Playing ────────────────────────────────────────────────

  /** Play the cues of an admitted event that `allow` lets through. */
  playEvent(event: SoundEvent, allow: (cue: SoundCue) => boolean): void {
    const g = this.graph();
    if (!g) return;
    for (const cue of event.cues) {
      if (!allow(cue)) continue;
      if (cue.kind === 'sfx') {
        this.playSfx(g, cue.name, g.ctx.currentTime + cue.delayMs / 1000);
      } else {
        const request = { dex: cue.dex, semitones: cue.semitones, user: event.user === true };
        this.later(cue.delayMs, () => this.requestCry({ ...request, at: Date.now() }));
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

  /** Sound switched off: drop everything pending and silence the cry. */
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
    const ctx = sharedAudioContext();
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
    unlockAudio();
    const ctx = sharedAudioContext();
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
    const synth = (at: number) =>
      playRecipe(g.ctx, alerts ? g.alertsSynth : g.effectsSynth, SFX_RECIPES[name], at);
    const override = this.pack.get(name);
    const url = override ? soundPackFileUrl(override) : null;
    if (!url || this.recentlyFailed(url)) {
      synth(when);
      return;
    }
    const ready = this.buffers.get(url);
    if (ready) {
      this.playBuffer(g, ready, bus, when, 1);
      return;
    }
    // The pack file is local: wait for it rather than play the synth.
    void this.decoded(url, g.ctx).then((buffer) => {
      if (this.g !== g) return;
      const at = Math.max(when, g.ctx.currentTime);
      if (buffer) this.playBuffer(g, buffer, bus, at, 1);
      else synth(at);
    });
  }

  private playBuffer(
    g: Graph,
    buffer: AudioBuffer,
    destination: AudioNode,
    when: number,
    rate: number,
  ): { source: AudioBufferSourceNode; duration: number } {
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
    return { source, duration };
  }

  private requestCry(request: CryRequest): void {
    if (!this.graph()) return;
    const verdict = this.cryQueue.request(request, Date.now());
    if (verdict !== 'play') return;
    if (request.user) this.stopCurrentCry();
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
    const { source, duration } = this.playBuffer(g, buffer, g.cries, when, rate);
    this.currentCry = source;
    this.duck(g, when, duration);
    source.addEventListener('ended', () => this.cryEnded(token));
  }

  private cryEnded(token: number): void {
    if (token !== this.cryToken) return;
    this.currentCry = null;
    const next = this.cryQueue.finished(Date.now());
    if (next) void this.startCry(next);
  }

  private stopCurrentCry(): void {
    const source = this.currentCry;
    this.currentCry = null;
    if (!source) return;
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
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
    const at = this.failedAt.get(url);
    return at !== undefined && Date.now() - at < SOUND_LOAD_RETRY_MS;
  }

  /** The file's bytes, fetched once (a failure is retried after SOUND_LOAD_RETRY_MS). */
  private fetchBytes(url: string): Promise<ArrayBuffer | null> {
    const existing = this.bytes.get(url);
    if (existing) return existing;
    if (this.recentlyFailed(url)) return Promise.resolve(null);
    const pending = fetch(url)
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
      this.failedAt.set(url, Date.now());
      this.bytes.delete(url);
      return null;
    }
  }
}

/** The office's one engine. */
export const audioEngine = new AudioEngine();
