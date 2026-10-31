/**
 * Plays music folder tracks in the page: a few <audio> elements ("decks") so
 * the next track can preload on an idle one and crossfade in (1.5 s, equal
 * power) as the current one ends. Volume = user volume × fade × duck (duck.ts).
 * Media Session metadata and actions make the OS media keys work.
 *
 * Every fade starts from the gains the decks have at that moment, and a skip
 * during a fade starts the new track on a deck that isn't sounding, so a
 * double tap on Next never jumps a fading track back up or cuts it off.
 *
 * Browsers start audio only after a user gesture; a blocked start leaves the
 * player paused with a notice instead of throwing.
 */

import type { MusicLibrary } from '../../../core/src/messages.js';
import {
  MEDIA_ERR_DECODE,
  MEDIA_ERR_NETWORK,
  MUSIC_DECK_COUNT,
  MUSIC_RAMP_TICK_MS,
  MUSIC_RESTART_THRESHOLD_SEC,
  MUSIC_SKIP_FADE_MS,
  MUSIC_START_FADE_MS,
  MUSIC_STATION_ALL,
} from './constants.js';
import { duckFactor, subscribeDuck } from './duck.js';
import { indexTracks, stationTrackIds, type TrackRef } from './format.js';
import { crossfadeMsFor, deckVolume, fadeInGain, fadeOutGain } from './mix.js';
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
  /** Why the last load failed (MediaError), or null. */
  readonly error: { readonly code: number } | null;
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
  /** Whether the server still serves this track (a HEAD request). A file the
   *  server serves but the browser rejects can't play here; a track the
   *  server doesn't serve (offline, restarted, token changed) may play later. */
  isServed(trackId: string): Promise<boolean>;
  now(): number;
  rng: Rng;
  /** Every state change (for the store). */
  onChange(state: FolderPlayback): void;
  /** Something the user should know (a blocked start, files that won't play). */
  onNotice(text: string): void;
  /** Remember what plays, to resume after a reload. */
  persist(state: { station: string | null; track: string | null; playing: boolean }): void;
}

export interface ResumeOptions {
  /** Called instead of the "press play" notice when the browser blocks the
   *  start (no user activation yet). The remembered "playing" is kept, so the
   *  caller can try again on the next gesture. */
  onBlocked?: () => void;
}

interface Fade {
  /** Decks fading out, each from the gain it had when the fade began. */
  out: { deck: number; from: number }[];
  /** The deck fading in, from `toFrom`. */
  to: number;
  toFrom: number;
  startedAt: number;
  ms: number;
}

const BLOCKED_NOTICE = 'Press play to start the music.';
const NOTHING_PLAYABLE_NOTICE = "These files can't play in this browser.";
const UNREACHABLE_NOTICE = "Couldn't load the track from Poke Agents. Press play to try again.";

export class FolderPlayer {
  private readonly decks: AudioDeck[];
  private readonly deckTrack: (string | null)[];
  private readonly fadeGain: number[];
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
  /** Bumped on every start, so a late play() rejection from an earlier start
   *  can't stop what plays now. */
  private startSeq = 0;
  /** Set only while resume() runs (see ResumeOptions). */
  private onBlocked: (() => void) | null = null;

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
    this.decks = Array.from({ length: MUSIC_DECK_COUNT }, () => env.createAudio());
    this.deckTrack = this.decks.map(() => null);
    this.fadeGain = this.decks.map((_, i) => (i === 0 ? 1 : 0));
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
  resume(options: ResumeOptions = {}): void {
    if (this.playing) return;
    this.onBlocked = options.onBlocked ?? null;
    try {
      this.resumeNow();
    } finally {
      this.onBlocked = null;
    }
  }

  private resumeNow(): void {
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
    if (this.deckTrack[this.active] !== currentTrack(this.queue)) {
      // The track failed to load (connection lost): load it again.
      this.playing = false;
      this.startCurrent(MUSIC_START_FADE_MS);
      return;
    }
    this.playing = true;
    this.fadeGain.fill(0);
    this.beginFade([], this.active, MUSIC_START_FADE_MS);
    this.playDeck(this.active);
    this.persist();
    this.emit();
  }

  pause(): void {
    if (this.playing) this.halt(true);
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
      this.preloadUpcoming();
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

  /** Decks making sound: the active one and any still fading out. */
  private soundingDecks(): number[] {
    if (!this.playing) return [];
    const out = this.fade?.out.map((o) => o.deck) ?? [];
    return [this.active, ...out.filter((d) => d !== this.active)];
  }

  /** A deck for `trackId`: an idle one, preferring one that already buffered
   *  it; with every deck sounding (a third skip inside one fade), the quietest. */
  private pickDeck(trackId: string, sounding: readonly number[]): number {
    const idle = this.decks.map((_, i) => i).filter((i) => !sounding.includes(i));
    const buffered = idle.find((i) => this.deckTrack[i] === trackId);
    if (buffered !== undefined) return buffered;
    if (idle.length > 0) return idle[0];
    return sounding.reduce((q, d) => (this.fadeGain[d] < this.fadeGain[q] ? d : q));
  }

  /** Start the queue's current track on an idle deck, fading the others out. */
  private startCurrent(fadeMs: number): void {
    if (!this.queue) return;
    const id = currentTrack(this.queue);
    const wasPlaying = this.playing;
    const sounding = this.soundingDecks();
    const incoming = this.pickDeck(id, sounding);
    if (sounding.includes(incoming)) {
      // Only when every deck is sounding: this one is cut, the rest fade.
      this.decks[incoming].pause();
      this.deckTrack[incoming] = null;
    }
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
    if (wasPlaying) {
      this.beginFade(
        sounding.filter((d) => d !== incoming),
        incoming,
        fadeMs,
      );
    } else {
      this.decks.forEach((d, i) => {
        if (i === incoming) return;
        d.pause();
        this.fadeGain[i] = 0;
      });
      this.beginFade([], incoming, MUSIC_START_FADE_MS);
    }
    this.playDeck(incoming);
    this.state = { ...this.state, trackId: id };
    this.updateMediaSession();
    this.persist();
    this.emit();
  }

  private playDeck(index: number): void {
    const seq = ++this.startSeq;
    const onBlocked = this.onBlocked;
    const result = this.decks[index].play();
    // Older engines return undefined; current ones a promise that rejects when
    // autoplay is blocked (NotAllowedError) or the source changed (AbortError).
    if (result && typeof result.catch === 'function') {
      result.catch((err: unknown) => {
        if ((err as { name?: string } | null)?.name !== 'NotAllowedError') return;
        if (seq !== this.startSeq || !this.playing) return;
        if (onBlocked) {
          this.halt(false);
          onBlocked();
        } else {
          this.halt(true);
          this.env.onNotice(BLOCKED_NOTICE);
        }
      });
    }
  }

  /** Stop every deck. `persist`: remember that the music is off (a user's
   *  pause); a stop the user didn't ask for keeps "playing" for a reload. */
  private halt(persist: boolean): void {
    this.playing = false;
    this.fade = null;
    for (const deck of this.decks) deck.pause();
    this.fadeGain.fill(0);
    this.fadeGain[this.active] = 1;
    if (persist) this.persist();
    this.emit();
  }

  private loadDeck(index: number, trackId: string | undefined): void {
    if (!trackId || this.deckTrack[index] === trackId) return;
    this.deckTrack[index] = trackId;
    this.decks[index].src = this.env.urlFor(trackId);
  }

  /** Buffer what plays next on a deck that isn't sounding. */
  private preloadUpcoming(): void {
    if (!this.queue) return;
    const upcoming = upcomingTrack(this.queue);
    if (!upcoming) return;
    const sounding = this.playing ? this.soundingDecks() : [this.active];
    const idle = this.decks.map((_, i) => i).filter((i) => !sounding.includes(i));
    if (idle.some((i) => this.deckTrack[i] === upcoming)) return;
    if (idle.length > 0) this.loadDeck(idle[0], upcoming);
  }

  /** Near the end of the active track, crossfade into the next. Starting it
   *  makes another deck active, so the outgoing deck's later events are
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

  /**
   * A deck failed to load or play its track. A decode error means this
   * browser can't play the file. A network error, or a 403/404 or refused
   * connection (which browsers report as "source not supported", like an
   * unsupported file), is not the file's fault: the server is asked whether it
   * still serves the track before the track is written off.
   */
  private onDeckError(index: number): void {
    const id = this.deckTrack[index];
    if (!id || !this.queue) return;
    const code = this.decks[index].error?.code;
    if (code === MEDIA_ERR_DECODE) {
      this.dropUnplayable(index, id);
      return;
    }
    if (code === MEDIA_ERR_NETWORK) {
      this.lostTrack(index, id);
      return;
    }
    void this.env.isServed(id).then(
      (served) => {
        if (this.deckTrack[index] !== id) return;
        if (served) this.dropUnplayable(index, id);
        else this.lostTrack(index, id);
      },
      () => {
        if (this.deckTrack[index] === id) this.lostTrack(index, id);
      },
    );
  }

  /** The file can't play in this browser: skip it for the rest of the session. */
  private dropUnplayable(index: number, id: string): void {
    if (!this.queue) return;
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
    } else {
      this.preloadUpcoming();
    }
    this.emit();
  }

  /** The server didn't deliver the track: forget the deck's load so the next
   *  play loads it again, and stop if it was playing (the server may be gone).
   *  The remembered "playing" is kept: the user didn't pause. */
  private lostTrack(index: number, id: string): void {
    if (this.deckTrack[index] !== id) return;
    this.deckTrack[index] = null;
    if (index === this.active && this.playing) {
      this.halt(false);
      this.env.onNotice(UNREACHABLE_NOTICE);
    }
  }

  // ── Volume ramp ─────────────────────────────────────────────

  /** Fade `to` in and `outgoing` out, each from its gain right now. */
  private beginFade(outgoing: readonly number[], to: number, ms: number): void {
    const out = outgoing
      .filter((d) => d !== to)
      .map((deck) => ({ deck, from: this.fadeGain[deck] }));
    if (ms <= 0) {
      for (const { deck } of out) {
        this.decks[deck].pause();
        this.fadeGain[deck] = 0;
      }
      this.fadeGain[to] = 1;
      this.fade = null;
      this.applyVolumes();
      this.preloadUpcoming();
      return;
    }
    this.fade = { out, to, toFrom: this.fadeGain[to], startedAt: this.env.now(), ms };
    this.applyVolumes();
    this.preloadUpcoming();
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
      for (const { deck, from } of fade.out) this.fadeGain[deck] = fadeOutGain(from, progress);
      this.fadeGain[fade.to] = fadeInGain(fade.toFrom, progress, fade.out.length > 0);
      if (progress >= 1) {
        for (const { deck } of fade.out) {
          this.decks[deck].pause();
          this.fadeGain[deck] = 0;
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
