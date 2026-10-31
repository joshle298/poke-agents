/**
 * Plays music folder tracks in the page: two <audio> elements ("decks") so the
 * next track can preload on the idle one and crossfade in (1.5 s, equal power)
 * as the current one ends. Volume = user volume × fade × duck (duck.ts).
 * Media Session metadata and actions make the OS media keys work.
 *
 * Browsers start audio only after a user gesture; a blocked start leaves the
 * player paused with a notice instead of throwing.
 */

import type { MusicLibrary } from '../../../core/src/messages.js';
import {
  MUSIC_RAMP_TICK_MS,
  MUSIC_RESTART_THRESHOLD_SEC,
  MUSIC_SKIP_FADE_MS,
  MUSIC_START_FADE_MS,
  MUSIC_STATION_ALL,
} from './constants.js';
import { duckFactor, subscribeDuck } from './duck.js';
import { indexTracks, stationTrackIds, type TrackRef } from './format.js';
import { crossfadeGains, crossfadeMsFor, deckVolume } from './mix.js';
import type { FolderPlayback } from './musicStore.js';
import type { PlayQueue, Rng } from './queue.js';
import {
  advance,
  createQueue,
  currentTrack,
  retreat,
  setQueueShuffle,
  upcomingTrack,
  withoutTracks,
} from './queue.js';

/** The parts of an <audio> element the player uses (an HTMLAudioElement in
 *  the page; a fake in tests, which run without the DOM). */
export interface AudioDeck {
  src: string;
  currentTime: number;
  readonly duration: number;
  volume: number;
  preload: string;
  play(): Promise<void> | undefined;
  pause(): void;
  canPlayType(type: string): string;
  addEventListener(type: 'timeupdate' | 'ended' | 'error' | 'playing', listener: () => void): void;
}

/** The OS media controls (navigator.mediaSession), when the page has them. */
export interface MediaSessionPort {
  setActionHandler(
    action: 'play' | 'pause' | 'nexttrack' | 'previoustrack',
    handler: () => void,
  ): void;
  setMetadata(metadata: { title: string; album: string }): void;
}

export interface FolderPlayerEnv {
  createAudio(): AudioDeck;
  mediaSession?: MediaSessionPort;
  urlFor(trackId: string): string;
  now(): number;
  rng: Rng;
  /** Every state change (for the store). */
  onChange(state: FolderPlayback): void;
  /** Something the user should know (a blocked start, files that won't play). */
  onNotice(text: string): void;
  /** Remember what plays, to resume after a reload. */
  persist(state: { station: string | null; track: string | null; playing: boolean }): void;
}

interface Fade {
  /** The deck fading out, or null for a fade-in from silence. */
  from: number | null;
  to: number;
  startedAt: number;
  ms: number;
}

const BLOCKED_NOTICE = 'Press play to start the music.';
const NOTHING_PLAYABLE_NOTICE = "These files can't play in this browser.";

export class FolderPlayer {
  private readonly decks: AudioDeck[];
  private readonly deckTrack: (string | null)[] = [null, null];
  private readonly fadeGain = [1, 0];
  private active = 0;
  private fade: Fade | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private queue: PlayQueue | null = null;
  private tracks = new Map<string, TrackRef>();
  private library: MusicLibrary | null = null;
  private readonly unplayable = new Set<string>();
  private readonly playableByType = new Map<string, boolean>();
  /** Consecutive tracks that failed to load: past the queue's size, stop. */
  private failures = 0;
  private playing = false;

  private readonly env: FolderPlayerEnv;
  private state: Pick<FolderPlayback, 'station' | 'trackId' | 'shuffle' | 'volume'>;

  constructor(
    env: FolderPlayerEnv,
    state: Pick<FolderPlayback, 'station' | 'trackId' | 'shuffle' | 'volume'>,
  ) {
    this.env = env;
    this.state = {
      station: state.station,
      trackId: state.trackId,
      shuffle: state.shuffle,
      volume: state.volume,
    };
    this.decks = [env.createAudio(), env.createAudio()];
    this.decks.forEach((deck, i) => {
      deck.preload = 'auto';
      deck.volume = 0;
      deck.addEventListener('timeupdate', () => this.onTimeUpdate(i));
      deck.addEventListener('ended', () => this.onEnded(i));
      deck.addEventListener('error', () => this.onDeckError(i));
      deck.addEventListener('playing', () => {
        if (i === this.active) this.failures = 0;
      });
    });
    subscribeDuck(() => this.startTicker());
    this.bindMediaSession();
  }

  // ── Library ─────────────────────────────────────────────────

  setLibrary(library: MusicLibrary): void {
    this.library = library;
    this.tracks = indexTracks(library);
    for (const { track } of this.tracks.values()) {
      if (!this.canPlay(track.mimeType)) this.unplayable.add(track.id);
    }
    if (this.queue) {
      const gone = new Set(this.queue.base.filter((id) => !this.tracks.has(id)));
      if (gone.size > 0) this.queue = withoutTracks(this.queue, gone, this.env.rng);
    }
    this.emit();
  }

  private canPlay(mimeType: string): boolean {
    let ok = this.playableByType.get(mimeType);
    if (ok === undefined) {
      ok = this.decks[0].canPlayType(mimeType) !== '';
      this.playableByType.set(mimeType, ok);
    }
    return ok;
  }

  // ── Controls ────────────────────────────────────────────────

  /** Play a station ('all' or an album id), optionally from one track. */
  playStation(station: string, options: { shuffle?: boolean; startId?: string } = {}): void {
    const base = stationTrackIds(this.library, station).filter((id) => !this.unplayable.has(id));
    if (options.shuffle !== undefined) this.state = { ...this.state, shuffle: options.shuffle };
    const queue = createQueue(base, {
      shuffle: this.state.shuffle,
      startId: options.startId,
      rng: this.env.rng,
    });
    if (!queue) {
      this.env.onNotice(NOTHING_PLAYABLE_NOTICE);
      this.emit();
      return;
    }
    this.state = { ...this.state, station };
    this.queue = queue;
    this.failures = 0;
    this.startCurrent(MUSIC_SKIP_FADE_MS);
  }

  /** Resume, or start the remembered station when nothing is queued. */
  resume(): void {
    if (!this.queue) {
      // The remembered album, or every album when it is gone from the folder.
      const remembered = this.state.station;
      const station =
        remembered && stationTrackIds(this.library, remembered).length > 0
          ? remembered
          : MUSIC_STATION_ALL;
      if (stationTrackIds(this.library, station).length === 0) return;
      this.playStation(station, { startId: this.state.trackId ?? undefined });
      return;
    }
    this.playing = true;
    this.fadeGain[1 - this.active] = 0;
    this.fadeGain[this.active] = 0;
    this.beginFade(null, this.active, MUSIC_START_FADE_MS);
    this.playDeck(this.active);
    this.persist();
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.fade = null;
    for (const deck of this.decks) deck.pause();
    this.fadeGain[1 - this.active] = 0;
    this.fadeGain[this.active] = 1;
    this.persist();
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.resume();
  }

  next(): void {
    if (!this.queue) return;
    this.queue = advance(this.queue, this.env.rng);
    this.startCurrent(MUSIC_SKIP_FADE_MS);
  }

  previous(): void {
    if (!this.queue) return;
    const deck = this.decks[this.active];
    if (deck.currentTime > MUSIC_RESTART_THRESHOLD_SEC) {
      deck.currentTime = 0;
      return;
    }
    this.queue = retreat(this.queue);
    this.startCurrent(MUSIC_SKIP_FADE_MS);
  }

  setShuffle(shuffle: boolean): void {
    this.state = { ...this.state, shuffle };
    if (this.queue) {
      this.queue = setQueueShuffle(this.queue, shuffle, this.env.rng);
      if (!this.fade) this.preloadUpcoming();
    }
    this.emit();
  }

  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0));
    this.state = { ...this.state, volume: v };
    this.applyVolumes();
    this.emit();
  }

  isPlaying(): boolean {
    return this.playing;
  }

  // ── Decks ───────────────────────────────────────────────────

  /** Start the queue's current track on the idle deck, fading the other out. */
  private startCurrent(fadeMs: number): void {
    if (!this.queue) return;
    const id = currentTrack(this.queue);
    const wasPlaying = this.playing;
    const outgoing = this.active;
    const incoming = 1 - outgoing;
    this.loadDeck(incoming, id);
    const deck = this.decks[incoming];
    try {
      deck.currentTime = 0;
    } catch {
      // Not seekable yet: it starts at 0 anyway.
    }
    this.active = incoming;
    this.playing = true;
    this.fadeGain[incoming] = 0;
    if (wasPlaying) this.beginFade(outgoing, incoming, fadeMs);
    else {
      this.decks[outgoing].pause();
      this.fadeGain[outgoing] = 0;
      this.beginFade(null, incoming, MUSIC_START_FADE_MS);
    }
    this.playDeck(incoming);
    this.state = { ...this.state, trackId: id };
    this.updateMediaSession();
    this.persist();
    this.emit();
  }

  private playDeck(index: number): void {
    const result = this.decks[index].play();
    // Older engines return undefined; current ones a promise that rejects when
    // autoplay is blocked (NotAllowedError) or the source changed (AbortError).
    if (result && typeof result.catch === 'function') {
      result.catch((err: unknown) => {
        if ((err as { name?: string } | null)?.name === 'NotAllowedError') {
          this.pause();
          this.env.onNotice(BLOCKED_NOTICE);
        }
      });
    }
  }

  private loadDeck(index: number, trackId: string | undefined): void {
    if (!trackId || this.deckTrack[index] === trackId) return;
    this.deckTrack[index] = trackId;
    this.decks[index].src = this.env.urlFor(trackId);
  }

  /** Buffer what plays next on the idle deck. */
  private preloadUpcoming(): void {
    if (!this.queue) return;
    this.loadDeck(1 - this.active, upcomingTrack(this.queue));
  }

  /** Near the end of the active track, crossfade into the next. Starting it
   *  makes the other deck active, so the outgoing deck's later events are
   *  ignored here. */
  private onTimeUpdate(index: number): void {
    if (index !== this.active || !this.playing || !this.queue) return;
    const deck = this.decks[index];
    const duration = deck.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const fadeMs = crossfadeMsFor(duration);
    if ((duration - deck.currentTime) * 1000 > fadeMs) return;
    this.queue = advance(this.queue, this.env.rng);
    this.startCurrent(fadeMs);
  }

  private onEnded(index: number): void {
    // The crossfade normally starts first; this covers unknown durations.
    if (index !== this.active || !this.playing || !this.queue) return;
    this.queue = advance(this.queue, this.env.rng);
    this.startCurrent(0);
  }

  private onDeckError(index: number): void {
    const id = this.deckTrack[index];
    if (!id || !this.queue) return;
    this.unplayable.add(id);
    this.deckTrack[index] = null;
    const isCurrent = index === this.active && this.playing;
    this.queue = withoutTracks(this.queue, new Set([id]), this.env.rng);
    if (!this.queue) {
      this.pause();
      this.env.onNotice(NOTHING_PLAYABLE_NOTICE);
      this.emit();
      return;
    }
    if (isCurrent) {
      this.failures += 1;
      if (this.failures > this.queue.base.length) {
        this.pause();
        this.env.onNotice(NOTHING_PLAYABLE_NOTICE);
        return;
      }
      // withoutTracks moved the queue onto the next playable track.
      this.playing = false;
      this.startCurrent(0);
    } else if (!this.fade) {
      this.preloadUpcoming();
    }
    this.emit();
  }

  // ── Volume ramp ─────────────────────────────────────────────

  private beginFade(from: number | null, to: number, ms: number): void {
    if (ms <= 0) {
      if (from !== null) {
        this.decks[from].pause();
        this.fadeGain[from] = 0;
      }
      this.fadeGain[to] = 1;
      this.fade = null;
      this.applyVolumes();
      this.preloadUpcoming();
      return;
    }
    this.fade = { from, to, startedAt: this.env.now(), ms };
    this.applyVolumes();
    this.startTicker();
  }

  private startTicker(): void {
    if (this.ticker !== null) return;
    this.ticker = setInterval(() => this.tick(), MUSIC_RAMP_TICK_MS);
  }

  private tick(): void {
    const fade = this.fade;
    if (fade) {
      const progress = (this.env.now() - fade.startedAt) / fade.ms;
      const gains = crossfadeGains(progress);
      if (fade.from !== null) this.fadeGain[fade.from] = gains.out;
      this.fadeGain[fade.to] = fade.from === null ? Math.min(1, Math.max(0, progress)) : gains.in;
      if (progress >= 1) {
        if (fade.from !== null) {
          this.decks[fade.from].pause();
          this.fadeGain[fade.from] = 0;
        }
        this.fadeGain[fade.to] = 1;
        this.fade = null;
        this.preloadUpcoming();
      }
    }
    this.applyVolumes();
    if (!this.fade && duckFactor() >= 1 && this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private applyVolumes(): void {
    const duck = duckFactor();
    this.decks.forEach((deck, i) => {
      deck.volume = deckVolume(this.state.volume, this.fadeGain[i], duck);
    });
  }

  // ── State out ───────────────────────────────────────────────

  snapshot(): FolderPlayback {
    return {
      playing: this.playing,
      trackId: this.state.trackId,
      station: this.state.station,
      shuffle: this.state.shuffle,
      volume: this.state.volume,
      unplayable: [...this.unplayable],
    };
  }

  private emit(): void {
    this.env.onChange(this.snapshot());
  }

  private persist(): void {
    this.env.persist({
      station: this.state.station,
      track: this.state.trackId,
      playing: this.playing,
    });
  }

  private bindMediaSession(): void {
    const session = this.env.mediaSession;
    if (!session) return;
    session.setActionHandler('play', () => this.resume());
    session.setActionHandler('pause', () => this.pause());
    session.setActionHandler('nexttrack', () => this.next());
    session.setActionHandler('previoustrack', () => this.previous());
  }

  private updateMediaSession(): void {
    const ref = this.state.trackId ? this.tracks.get(this.state.trackId) : undefined;
    if (ref) this.env.mediaSession?.setMetadata({ title: ref.track.title, album: ref.album.name });
  }
}
