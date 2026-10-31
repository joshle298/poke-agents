/**
 * Turns ServerMessages and Pokédex clicks into played sounds: the
 * SoundDirector says what deserves a sound, this module drops what the
 * Settings switch, the Cries / Alerts / Effects toggles or a locked
 * AudioContext rule out, the SoundLimiter decides how many play, and the
 * engine plays them. DOM-free, with its page dependencies passed in, so the
 * Node runner can test the gates; usePokemonSounds.ts builds the office's one
 * controller.
 */

import type { ServerMessage } from '../../../core/src/messages.js';
import type { SfxName, SoundCategory, SoundCue, SoundEvent } from './soundEvents.js';
import { cueCategory, SFX_CATEGORY } from './soundEvents.js';
import type { SoundLimiter } from './soundLimiter.js';
import type { SoundDirector } from './soundPolicy.js';
import type { SoundPrefs } from './soundPrefs.js';

/** The part of AudioEngine the controller drives. */
export interface SoundEngine {
  setCryUrl(dex: number, url: string): void;
  hasCry(dex: number): boolean;
  anyCryDex(): number | undefined;
  cryDexes(): number[];
  prefetchCry(dex: number): void;
  isRunning(): boolean;
  playEvent(event: SoundEvent, allow: (cue: SoundCue) => boolean): void;
  playUserEvent(event: SoundEvent, allow: (cue: SoundCue) => boolean): Promise<void>;
  testSfx(name: SfxName): Promise<void>;
  testCry(dex: number): Promise<void>;
}

export interface SoundControllerDeps {
  director: SoundDirector;
  limiter: SoundLimiter;
  engine: SoundEngine;
  /** The server's Sounds switch (Settings → Sound). */
  soundEnabled: () => boolean;
  prefs: () => SoundPrefs;
  selectedAgentId: () => number | null;
  now?: () => number;
  /** Called for each event that plays (the e2e sound log). */
  onPlayed?: (event: SoundEvent) => void;
}

/** The Settings toggle a Test button belongs to. */
function testCategory(name: SfxName | 'cry'): SoundCategory {
  return name === 'cry' ? 'cries' : SFX_CATEGORY[name];
}

export class SoundController {
  private readonly d: SoundControllerDeps;
  private readonly now: () => number;
  /** A user gesture has happened: cries may be fetched ahead of use. */
  private gestured = false;
  private warned = false;

  constructor(deps: SoundControllerDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Fold in one ServerMessage. Never throws: the transport hands every
   * message to each handler in turn, and a sound failure must not keep it
   * from the office.
   */
  handle(msg: ServerMessage): void {
    try {
      if (msg.type === 'pokemonSpeciesLoaded' && typeof msg.cry === 'string') {
        this.d.engine.setCryUrl(msg.dex, msg.cry);
        if (this.gestured && this.mayFetchCries()) this.d.engine.prefetchCry(msg.dex);
      }
      const events = this.d.director.handle(msg, {
        now: this.now(),
        selectedAgentId: this.d.selectedAgentId(),
      });
      this.dispatch(events);
    } catch (err) {
      this.warnOnce(err);
    }
  }

  /** The socket (re)connected: the replay that follows stays quiet. */
  connected(): void {
    this.d.director.connected(this.now());
  }

  /** A click or key press. From now on cries are fetched as species appear;
   *  before it nothing could play, so nothing is downloaded. */
  gesture(): void {
    if (this.gestured) return;
    this.gestured = true;
    if (!this.mayFetchCries()) return;
    for (const dex of this.d.engine.cryDexes()) this.d.engine.prefetchCry(dex);
  }

  /** The open Pokédex changed: its Pokémon's cry on open, a blip on close. */
  pokedexChanged(agentId: number | null, before: number | null): void {
    if (agentId === before) return;
    try {
      if (agentId !== null) this.dispatch(this.d.director.pokedexOpened(agentId));
      else if (before !== null && this.d.director.isPresent(before)) {
        this.dispatch(this.d.director.pokedexClosed());
      }
    } catch (err) {
      this.warnOnce(err);
    }
  }

  /** A UI blip (a Pokédex tab), if effects are on. */
  blip(): void {
    this.dispatch([
      { name: 'uiBlip', cues: [{ kind: 'sfx', name: 'blip', delayMs: 0 }], user: true },
    ]);
  }

  /** Whether a Test button can make a sound: the Sounds switch and its
   *  toggle apply to tests as to everything else. */
  canTest(name: SfxName | 'cry'): boolean {
    return this.d.soundEnabled() && this.d.prefs()[testCategory(name)];
  }

  /** Settings → Test sounds (and the volume slider's blip). */
  test(name: SfxName | 'cry'): void {
    if (!this.canTest(name)) return;
    if (name !== 'cry') {
      void this.d.engine.testSfx(name);
      return;
    }
    const dex = this.testCryDex();
    if (dex !== undefined) void this.d.engine.testCry(dex);
  }

  /** The cry the "Cry" test plays: the selected Pokémon's, else any. */
  testCryDex(): number | undefined {
    const selected = this.d.selectedAgentId();
    const species = selected !== null ? this.d.director.speciesOf(selected) : undefined;
    return species !== undefined && this.d.engine.hasCry(species)
      ? species
      : this.d.engine.anyCryDex();
  }

  // ── Internals ──────────────────────────────────────────────

  /** One console line per page, however many messages fail the same way. */
  private warnOnce(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn('[Webview] Pokémon sound skipped:', err);
  }

  private mayFetchCries(): boolean {
    return this.d.soundEnabled() && this.d.prefs().cries;
  }

  /**
   * A cue the toggles allow and the engine may be able to play. A delayed
   * cry counts even before its URL is known: the species payload can arrive
   * just after the event, and the engine checks again when the cue fires.
   */
  private readonly allowed = (cue: SoundCue): boolean => {
    if (!this.d.prefs()[cueCategory(cue)]) return false;
    return cue.kind !== 'cry' || cue.delayMs > 0 || this.d.engine.hasCry(cue.dex);
  };

  private dispatch(events: SoundEvent[]): void {
    if (events.length === 0 || !this.d.soundEnabled()) return;
    for (const event of events) {
      // Nothing playable: don't spend the event's cooldown on silence.
      if (!event.cues.some(this.allowed)) continue;
      if (event.user) {
        if (!this.d.limiter.admit(event, this.now())) continue;
        this.d.onPlayed?.(event);
        void this.d.engine.playUserEvent(event, this.allowed);
        continue;
      }
      // Before the first gesture the context is locked: drop, never queue.
      if (!this.d.engine.isRunning() || !this.d.limiter.admit(event, this.now())) continue;
      this.d.onPlayed?.(event);
      this.d.engine.playEvent(event, this.allowed);
    }
  }
}
