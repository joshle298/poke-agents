import { describe, expect, it } from 'vitest';

import type { MusicLibrary, MusicState } from '../../core/src/messages.js';
import {
  appNowPlaying,
  nowPlayingText,
  pillText,
  stationTrackIds,
  trackNumberLabel,
} from '../src/music/format.js';
import { MusicStore, pendingKey } from '../src/music/musicStore.js';
import { readMusicPrefs } from '../src/music/preferences.js';

const PREFS = {
  source: 'apple' as const,
  station: null,
  track: null,
  shuffle: false,
  volume: 0.6,
  playing: false,
};

function library(overrides: Partial<MusicLibrary> = {}): MusicLibrary {
  return {
    type: 'musicLibrary',
    sources: [
      { id: 'folder', available: true },
      { id: 'apple', available: true },
      { id: 'spotify', available: false, reason: "Spotify isn't installed." },
    ],
    folderPath: '~/.pixel-agents/music',
    albums: [
      {
        id: 'a1',
        name: 'Pokémon Emerald',
        tracks: [
          { id: 't1', title: 'Opening', trackNumber: 1, mimeType: 'audio/mpeg' },
          { id: 't2', title: 'Hometown', trackNumber: 2, mimeType: 'audio/mpeg' },
        ],
      },
      {
        id: 'a2',
        name: 'Pokémon X & Y',
        tracks: [
          { id: 't3', title: 'Route', trackNumber: 5, discNumber: 2, mimeType: 'audio/mp4' },
        ],
      },
    ],
    appleAlbums: [],
    appleLibraryScanned: false,
    stations: [],
    ...overrides,
  };
}

const PLAYING: MusicState = {
  type: 'musicState',
  source: 'apple',
  running: true,
  playing: true,
  track: 'Battle',
  album: 'Super Music Collection',
};

describe('MusicStore', () => {
  it('starts on the remembered source', () => {
    const store = new MusicStore(PREFS);
    expect(store.getState().tab).toBe('apple');
    expect(store.getState().activeSource).toBe('apple');
    expect(store.getState().folder.volume).toBe(0.6);
  });

  it('takes the library, falling back to My music when the tab is unavailable', () => {
    const store = new MusicStore({ ...PREFS, source: 'spotify' });
    store.apply(library());
    expect(store.getState().library?.albums).toHaveLength(2);
    expect(store.getState().tab).toBe('folder');
  });

  it('keeps each app state, and settles pending commands with their result', () => {
    const store = new MusicStore(PREFS);
    store.apply(PLAYING);
    expect(store.getState().apps.apple?.track).toBe('Battle');

    store.markPending('apple', 'scanLibrary');
    expect(store.getState().pending[pendingKey('apple', 'scanLibrary')]).toBe(true);
    store.apply({ type: 'musicActionResult', action: 'scanLibrary', source: 'apple', ok: true });
    expect(store.getState().pending).toEqual({});
    expect(store.getState().notice).toBeNull();

    store.apply({
      type: 'musicActionResult',
      action: 'play',
      source: 'apple',
      ok: false,
      message: 'Allow control of Music.',
    });
    const notice = store.getState().notice!;
    expect(notice).toMatchObject({ text: 'Allow control of Music.', tone: 'error' });
    store.dismissNotice(notice.seq);
    expect(store.getState().notice).toBeNull();
  });

  it('drops pending commands when the connection drops (their replies are lost)', () => {
    const store = new MusicStore(PREFS);
    store.markPending('apple', 'scanLibrary');
    store.markPending('folder', 'openFolder');
    store.clearPending();
    expect(store.getState().pending).toEqual({});
    const before = store.getState();
    store.clearPending();
    expect(store.getState()).toBe(before);
  });

  it('ignores messages that are not about music', () => {
    const store = new MusicStore(PREFS);
    const before = store.getState();
    store.apply({ type: 'agentClosed', id: 1 });
    expect(store.getState()).toBe(before);
  });
});

describe('Jukebox text', () => {
  it('reads "Track · Album"', () => {
    expect(nowPlayingText('Route', 'Pokémon X & Y')).toBe('Route · Pokémon X & Y');
    expect(nowPlayingText(undefined, 'Album')).toBe('Album');
    expect(nowPlayingText()).toBe('');
  });

  it('lists station tracks in album order', () => {
    expect(stationTrackIds(library(), 'all')).toEqual(['t1', 't2', 't3']);
    expect(stationTrackIds(library(), 'a2')).toEqual(['t3']);
    expect(stationTrackIds(null, 'all')).toEqual([]);
  });

  it('labels track numbers, with the disc on multi-disc albums', () => {
    const track = { id: 't', title: 'x', trackNumber: 5, discNumber: 2, mimeType: 'audio/mp4' };
    expect(trackNumberLabel(track, false)).toBe('05');
    expect(trackNumberLabel(track, true)).toBe('2-05');
    expect(trackNumberLabel({ id: 't', title: 'x', mimeType: 'audio/mp4' }, true)).toBe('');
  });

  it('shows the pill only while the active source plays', () => {
    const store = new MusicStore({ ...PREFS, source: 'folder' });
    store.apply(library());
    expect(pillText(store.getState())).toBeNull();
    store.setFolder({ ...store.getState().folder, playing: true, trackId: 't2', station: 'a1' });
    expect(pillText(store.getState())).toBe('Hometown · Pokémon Emerald');

    store.setActiveSource('apple');
    expect(pillText(store.getState())).toBeNull();
    store.apply(PLAYING);
    expect(pillText(store.getState())).toBe('Battle · Super Music Collection');
    store.apply({ ...PLAYING, track: undefined, album: undefined });
    expect(pillText(store.getState())).toBe('Music');
  });

  it('describes an app that is closed, refused or paused', () => {
    expect(appNowPlaying(undefined, 'spotify')).toBe('Spotify: nothing yet');
    expect(appNowPlaying({ ...PLAYING, running: false, playing: false }, 'apple')).toBe(
      "Music isn't open",
    );
    expect(appNowPlaying({ ...PLAYING, error: 'Allow control of Music.' }, 'apple')).toBe(
      'Allow control of Music.',
    );
    expect(appNowPlaying({ ...PLAYING, playing: false }, 'apple')).toBe(
      'Battle · Super Music Collection (paused)',
    );
  });
});

describe('music preferences', () => {
  it('falls back to defaults without storage (Node)', () => {
    expect(readMusicPrefs()).toEqual({
      source: 'folder',
      station: null,
      track: null,
      shuffle: false,
      volume: 0.6,
      playing: false,
    });
  });
});
