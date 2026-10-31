import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MusicLibrary } from '../../core/src/messages.js';
import { MUSIC_CROSSFADE_MS, MUSIC_START_FADE_MS } from '../src/music/constants.js';
import { type AudioDeck, FolderPlayer, type FolderPlayerEnv } from '../src/music/folderPlayer.js';
import type { FolderPlayback } from '../src/music/musicStore.js';

/** Just enough of an <audio> element: events, play/pause, src and volume. */
class FakeAudio {
  src = '';
  currentTime = 0;
  duration = Number.NaN;
  volume = 1;
  paused = true;
  preload = '';
  playResult: Promise<void> = Promise.resolve();
  private listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  play() {
    this.paused = false;
    return this.playResult;
  }
  pause() {
    this.paused = true;
  }
  canPlayType(type: string) {
    return type === 'audio/x-nope' ? '' : 'maybe';
  }
}

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

describe('FolderPlayer', () => {
  let decks: FakeAudio[];
  let states: FolderPlayback[];
  let notices: string[];
  let persisted: { station: string | null; track: string | null; playing: boolean }[];
  let player: FolderPlayer;

  const srcOf = (deck: FakeAudio) => deck.src.replace('track:', '');
  const audible = () => decks.find((d) => !d.paused && d.volume > 0);
  const last = () => states[states.length - 1];

  beforeEach(() => {
    vi.useFakeTimers();
    decks = [];
    states = [];
    notices = [];
    persisted = [];
    const env: FolderPlayerEnv = {
      createAudio: () => {
        const deck = new FakeAudio();
        decks.push(deck);
        return deck as AudioDeck;
      },
      urlFor: (id) => `track:${id}`,
      now: () => Date.now(),
      rng: () => 0.5,
      onChange: (s) => states.push(s),
      onNotice: (t) => notices.push(t),
      persist: (p) => persisted.push(p),
    };
    player = new FolderPlayer(env, { station: null, trackId: null, shuffle: false, volume: 0.5 });
    player.setLibrary(LIBRARY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks tracks this browser cannot decode and never queues them', () => {
    expect(last().unplayable).toEqual(['t3']);
    player.playStation('a1', { startId: 't2' });
    vi.advanceTimersByTime(MUSIC_START_FADE_MS + 100);
    // t2 plays; t4 (not t3) is preloaded on the idle deck.
    expect(srcOf(audible()!)).toBe('t2');
    expect(decks.map(srcOf).sort()).toEqual(['t2', 't4']);
  });

  it('fades the first track in, then crossfades into the next as it ends', () => {
    player.playStation('a1');
    const first = audible() ?? decks.find((d) => !d.paused)!;
    expect(srcOf(first)).toBe('t1');
    expect(first.volume).toBe(0);
    vi.advanceTimersByTime(MUSIC_START_FADE_MS + 100);
    expect(first.volume).toBeCloseTo(0.5);
    expect(last()).toMatchObject({ playing: true, trackId: 't1', station: 'a1' });
    expect(persisted[persisted.length - 1]).toEqual({ station: 'a1', track: 't1', playing: true });

    // 1 s left of a 100 s track: the crossfade starts on the preloaded deck.
    const second = decks.find((d) => d !== first)!;
    expect(srcOf(second)).toBe('t2');
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
    // The deck that faded out now holds the track after next.
    expect(srcOf(first)).toBe('t4');
  });

  it('skips a track that fails to load and says so when nothing can play', () => {
    player.playStation('a1');
    vi.advanceTimersByTime(MUSIC_START_FADE_MS + 100);
    const current = decks.find((d) => !d.paused)!;
    current.emit('error');
    expect(last().trackId).toBe('t2');
    expect(last().unplayable).toContain('t1');
    for (let i = 0; i < 3; i++) decks.find((d) => !d.paused)?.emit('error');
    expect(last().playing).toBe(false);
    expect(notices).toContain("These files can't play in this browser.");
  });

  it('stays paused with a notice when the browser blocks autoplay', async () => {
    for (const deck of decks) {
      deck.playResult = Promise.reject(
        Object.assign(new Error('blocked'), { name: 'NotAllowedError' }),
      );
      deck.playResult.catch(() => {});
    }
    player.playStation('a1');
    await Promise.resolve();
    await Promise.resolve();
    expect(last().playing).toBe(false);
    expect(notices).toEqual(['Press play to start the music.']);
    expect(persisted[persisted.length - 1].playing).toBe(false);
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
    const fresh = new FolderPlayer(
      {
        createAudio: () => new FakeAudio(),
        urlFor: (id) => `track:${id}`,
        now: () => Date.now(),
        rng: () => 0.5,
        onChange: (s) => states.push(s),
        onNotice: () => {},
        persist: () => {},
      },
      { station: 'a1', trackId: 't4', shuffle: false, volume: 0.5 },
    );
    fresh.setLibrary(LIBRARY);
    fresh.resume();
    expect(last()).toMatchObject({ playing: true, trackId: 't4' });
  });

  it('falls back to every album when the remembered one left the folder', () => {
    const fresh = new FolderPlayer(
      {
        createAudio: () => new FakeAudio(),
        urlFor: (id) => `track:${id}`,
        now: () => Date.now(),
        rng: () => 0.5,
        onChange: (s) => states.push(s),
        onNotice: () => {},
        persist: () => {},
      },
      { station: 'gone', trackId: 'old', shuffle: false, volume: 0.5 },
    );
    fresh.setLibrary(LIBRARY);
    fresh.resume();
    expect(last()).toMatchObject({ playing: true, station: 'all', trackId: 't1' });
  });
});
