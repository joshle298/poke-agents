import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MusicLibrary } from '../../core/src/messages.js';
import {
  MEDIA_ERR_DECODE,
  MEDIA_ERR_NETWORK,
  MUSIC_CROSSFADE_MS,
  MUSIC_RAMP_TICK_MS,
  MUSIC_SKIP_FADE_MS,
  MUSIC_START_FADE_MS,
} from '../src/music/constants.js';
import { type AudioDeck, FolderPlayer, type FolderPlayerEnv } from '../src/music/folderPlayer.js';
import type { FolderPlayback } from '../src/music/musicStore.js';

/** MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: what browsers also report for a 403. */
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/** Just enough of an <audio> element: events, play/pause, src and volume. */
class FakeAudio {
  currentTime = 0;
  duration = Number.NaN;
  volume = 1;
  paused = true;
  preload = '';
  error: { code: number } | null = null;
  /** Every src assignment: a reload cuts off whatever the deck was playing. */
  loads: string[] = [];
  playResult: () => Promise<void> = () => Promise.resolve();
  private source = '';
  private listeners = new Map<string, (() => void)[]>();
  get src() {
    return this.source;
  }
  set src(value: string) {
    this.source = value;
    this.loads.push(value);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  play() {
    this.paused = false;
    return this.playResult();
  }
  pause() {
    this.paused = true;
  }
  canPlayType(type: string) {
    return type === 'audio/x-nope' ? '' : 'maybe';
  }
}

const blocked = () =>
  Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));

const LIBRARY: MusicLibrary = {
  type: 'musicLibrary',
  sources: [{ id: 'folder', available: true }],
  folderPath: '~/.pixel-agents/music',
  albums: [
    {
      id: 'a1',
      name: 'Album',
      tracks: [
        { id: 't1', title: 'One', trackNumber: 1, mimeType: 'audio/mpeg' },
        { id: 't2', title: 'Two', trackNumber: 2, mimeType: 'audio/mpeg' },
        { id: 't3', title: 'Odd', trackNumber: 3, mimeType: 'audio/x-nope' },
        { id: 't4', title: 'Four', trackNumber: 4, mimeType: 'audio/mpeg' },
      ],
    },
  ],
  appleAlbums: [],
  appleLibraryScanned: false,
  stations: [],
};

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('FolderPlayer', () => {
  let decks: FakeAudio[];
  let states: FolderPlayback[];
  let notices: string[];
  let persisted: { station: string | null; track: string | null; playing: boolean }[];
  let served: boolean;
  let player: FolderPlayer;

  const srcOf = (deck: FakeAudio) => deck.src.replace('track:', '');
  const audible = () => decks.find((d) => !d.paused && d.volume > 0);
  const deckWith = (id: string) => decks.find((d) => srcOf(d) === id)!;
  const sounding = () => decks.filter((d) => !d.paused);
  const last = () => states[states.length - 1];

  function makePlayer(state: Partial<FolderPlayback> = {}): FolderPlayer {
    decks = [];
    const env: FolderPlayerEnv = {
      createAudio: () => {
        const deck = new FakeAudio();
        decks.push(deck);
        return deck as AudioDeck;
      },
      urlFor: (id) => `track:${id}`,
      isServed: async () => served,
      now: () => Date.now(),
      rng: () => 0.5,
      onChange: (s) => states.push(s),
      onNotice: (t) => notices.push(t),
      persist: (p) => persisted.push(p),
    };
    const p = new FolderPlayer(env, {
      station: null,
      trackId: null,
      shuffle: false,
      volume: 0.5,
      ...state,
    });
    p.setLibrary(LIBRARY);
    return p;
  }

  /** Volumes of `watched` every ramp tick for `ms`. */
  function volumesOver(watched: FakeAudio, ms: number): number[] {
    const out = [watched.volume];
    for (let t = 0; t < ms; t += MUSIC_RAMP_TICK_MS) {
      vi.advanceTimersByTime(MUSIC_RAMP_TICK_MS);
      out.push(watched.volume);
    }
    return out;
  }

  const nonIncreasing = (values: number[]) =>
    values.every((v, i) => i === 0 || v <= values[i - 1] + 1e-9);

  beforeEach(() => {
    vi.useFakeTimers();
    states = [];
    notices = [];
    persisted = [];
    served = true;
    player = makePlayer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks tracks this browser cannot decode and never queues them', () => {
    expect(last().unplayable).toEqual(['t3']);
    player.playStation('a1', { startId: 't2' });
    vi.advanceTimersByTime(MUSIC_START_FADE_MS + 100);
    // t2 plays; t4 (not t3) is preloaded on an idle deck.
    expect(srcOf(audible()!)).toBe('t2');
    expect(decks.map(srcOf).filter(Boolean).sort()).toEqual(['t2', 't4']);
  });

  it('fades the first track in, then crossfades into the next as it ends', () => {
    player.playStation('a1');
    const first = deckWith('t1');
    expect(first.paused).toBe(false);
    expect(first.volume).toBe(0);
    vi.advanceTimersByTime(MUSIC_START_FADE_MS + 100);
    expect(first.volume).toBeCloseTo(0.5);
    expect(last()).toMatchObject({ playing: true, trackId: 't1', station: 'a1' });
    expect(persisted[persisted.length - 1]).toEqual({ station: 'a1', track: 't1', playing: true });

    // 1 s left of a 100 s track: the crossfade starts on the preloaded deck.
    const second = deckWith('t2');
    expect(second.paused).toBe(true);
    first.duration = 100;
    first.currentTime = 99;
    first.emit('timeupdate');
    expect(second.paused).toBe(false);
    expect(last().trackId).toBe('t2');
    vi.advanceTimersByTime(MUSIC_CROSSFADE_MS / 2);
    expect(first.volume).toBeGreaterThan(0);
    expect(second.volume).toBeGreaterThan(0);
    vi.advanceTimersByTime(MUSIC_CROSSFADE_MS);
    expect(first.paused).toBe(true);
    expect(second.volume).toBeCloseTo(0.5);
    // The fading deck kept its track to the end; the next one is buffered.
    expect(first.loads).toEqual(['track:t1']);
    expect(sounding()).toEqual([second]);
    expect(decks.filter((d) => d.paused).map(srcOf)).toContain('t4');
  });

  it('never pushes a fading track back up when Next is pressed during the fade-in', () => {
    player.setVolume(1);
    player.playStation('a1');
    vi.advanceTimersByTime(80);
    const outgoing = deckWith('t1');
    expect(outgoing.volume).toBeGreaterThan(0.2);
    expect(outgoing.volume).toBeLessThan(0.35);
    player.next();
    const volumes = volumesOver(outgoing, MUSIC_SKIP_FADE_MS + 100);
    expect(nonIncreasing(volumes)).toBe(true);
    expect(Math.max(...volumes)).toBeLessThan(0.35);
    expect(outgoing.paused).toBe(true);
    expect(outgoing.loads).toEqual(['track:t1']);
    expect(srcOf(audible()!)).toBe('t2');
    expect(audible()!.volume).toBeCloseTo(1);
  });

  it('fades both tracks out from where they are when Next is pressed mid-crossfade', () => {
    player.setVolume(1);
    player.playStation('a1');
    vi.advanceTimersByTime(MUSIC_START_FADE_MS + 100);
    const first = deckWith('t1');
    first.duration = 100;
    first.currentTime = 98.6;
    first.emit('timeupdate');
    const second = deckWith('t2');
    vi.advanceTimersByTime(200);
    const before = { first: first.volume, second: second.volume };
    expect(before.first).toBeGreaterThan(0.8);
    expect(before.second).toBeGreaterThan(0.1);

    player.next();
    const third = deckWith('t4');
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
    const firstVolumes = [first.volume];
    const secondVolumes = [second.volume];
    for (let t = 0; t < MUSIC_SKIP_FADE_MS + 100; t += MUSIC_RAMP_TICK_MS) {
      vi.advanceTimersByTime(MUSIC_RAMP_TICK_MS);
      firstVolumes.push(first.volume);
      secondVolumes.push(second.volume);
    }
    expect(firstVolumes[0]).toBeCloseTo(before.first);
    expect(secondVolumes[0]).toBeCloseTo(before.second);
    expect(nonIncreasing(firstVolumes)).toBe(true);
    expect(nonIncreasing(secondVolumes)).toBe(true);
    // Neither sounding deck was reloaded mid-fade.
    expect(first.loads).toEqual(['track:t1']);
    expect(second.loads).toEqual(['track:t2']);
    expect(sounding()).toEqual([third]);
    expect(third.volume).toBeCloseTo(1);
    expect(last().trackId).toBe('t4');
  });

  it('ends with one track at full volume after a burst of skips', () => {
    player.setVolume(1);
    player.playStation('a1');
    vi.advanceTimersByTime(MUSIC_START_FADE_MS + 100);
    player.next();
    vi.advanceTimersByTime(MUSIC_RAMP_TICK_MS);
    player.next();
    vi.advanceTimersByTime(MUSIC_RAMP_TICK_MS);
    player.next();
    vi.advanceTimersByTime(MUSIC_SKIP_FADE_MS + 100);
    expect(last().trackId).toBe('t1');
    expect(sounding()).toHaveLength(1);
    expect(srcOf(sounding()[0])).toBe('t1');
    expect(sounding()[0].volume).toBeCloseTo(1);
  });

  it('skips a track that fails to decode and says so when nothing can play', () => {
    player.playStation('a1');
    vi.advanceTimersByTime(MUSIC_START_FADE_MS + 100);
    const current = deckWith('t1');
    current.error = { code: MEDIA_ERR_DECODE };
    current.emit('error');
    expect(last().trackId).toBe('t2');
    expect(last().unplayable).toContain('t1');
    for (let i = 0; i < 3; i++) {
      const deck = sounding()[0];
      if (!deck) break;
      deck.error = { code: MEDIA_ERR_DECODE };
      deck.emit('error');
    }
    expect(last().playing).toBe(false);
    expect(notices).toContain("These files can't play in this browser.");
  });

  it('writes off a track the server serves but the browser rejects', async () => {
    player.playStation('a1');
    vi.advanceTimersByTime(MUSIC_START_FADE_MS + 100);
    const current = deckWith('t1');
    current.error = { code: MEDIA_ERR_SRC_NOT_SUPPORTED };
    current.emit('error');
    await flush();
    expect(last().unplayable).toContain('t1');
    expect(last()).toMatchObject({ playing: true, trackId: 't2' });
  });

  it('keeps a track that failed to arrive, stops, and loads it again on play', async () => {
    player.playStation('a1');
    vi.advanceTimersByTime(MUSIC_START_FADE_MS + 100);

    // The server stopped answering (restart, rotated token): a 403 or a
    // refused connection looks like "source not supported" to the browser.
    served = false;
    const current = deckWith('t1');
    current.error = { code: MEDIA_ERR_SRC_NOT_SUPPORTED };
    current.emit('error');
    await flush();
    expect(last()).toMatchObject({ playing: false, trackId: 't1' });
    expect(last().unplayable).not.toContain('t1');
    expect(notices).toEqual(["Couldn't load the track from Poke Agents. Press play to try again."]);
    // Not the user's pause: a reload still resumes the music.
    expect(persisted[persisted.length - 1].playing).toBe(true);

    const loadsBefore = decks.reduce((n, d) => n + d.loads.length, 0);
    player.resume();
    expect(last()).toMatchObject({ playing: true, trackId: 't1' });
    expect(decks.reduce((n, d) => n + d.loads.length, 0)).toBe(loadsBefore + 1);
    expect(srcOf(sounding()[0])).toBe('t1');

    // A network error mid-track is never the file's fault either.
    const again = sounding()[0];
    again.error = { code: MEDIA_ERR_NETWORK };
    again.emit('error');
    expect(last()).toMatchObject({ playing: false, trackId: 't1' });
    expect(last().unplayable).not.toContain('t1');
  });

  it('stays paused with a notice when the browser blocks autoplay', async () => {
    for (const deck of decks) deck.playResult = blocked;
    player.playStation('a1');
    await flush();
    expect(last().playing).toBe(false);
    expect(notices).toEqual(['Press play to start the music.']);
    expect(persisted[persisted.length - 1].playing).toBe(false);
  });

  it('keeps the remembered music when a resume without a gesture is blocked', async () => {
    const fresh = makePlayer({ station: 'a1', trackId: 't2' });
    for (const deck of decks) deck.playResult = blocked;
    const onBlocked = vi.fn();
    persisted = [];
    fresh.resume({ onBlocked });
    await flush();
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
    expect(persisted.every((p) => p.playing)).toBe(true);
    expect(last().playing).toBe(false);

    // The next gesture is a real one.
    for (const deck of decks) deck.playResult = () => Promise.resolve();
    fresh.resume({ onBlocked });
    await flush();
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(last()).toMatchObject({ playing: true, trackId: 't2' });
  });

  it('ignores a late autoplay refusal from a start that was replaced', async () => {
    let reject: (err: unknown) => void = () => {};
    // The first start goes to the first deck; its refusal arrives after Next.
    decks[0].playResult = () =>
      new Promise<void>((_, r) => {
        reject = r;
      });
    player.playStation('a1');
    player.next();
    reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    await flush();
    expect(last()).toMatchObject({ playing: true, trackId: 't2' });
    expect(notices).toEqual([]);
  });

  it('pauses, resumes, skips and changes volume', () => {
    player.playStation('a1');
    vi.advanceTimersByTime(MUSIC_START_FADE_MS + 100);
    player.pause();
    expect(decks.every((d) => d.paused)).toBe(true);
    expect(last().playing).toBe(false);
    player.toggle();
    expect(last().playing).toBe(true);
    player.next();
    vi.advanceTimersByTime(1_000);
    expect(last().trackId).toBe('t2');
    player.setVolume(0.2);
    expect(audible()!.volume).toBeCloseTo(0.2);
    expect(last().volume).toBe(0.2);
  });

  it('resumes the remembered station from the remembered track', () => {
    const fresh = makePlayer({ station: 'a1', trackId: 't4' });
    fresh.resume();
    expect(last()).toMatchObject({ playing: true, trackId: 't4' });
  });

  it('falls back to every album when the remembered one left the folder', () => {
    const fresh = makePlayer({ station: 'gone', trackId: 'old' });
    fresh.resume();
    expect(last()).toMatchObject({ playing: true, station: 'all', trackId: 't1' });
  });
});
