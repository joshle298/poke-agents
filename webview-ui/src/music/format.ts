/** Pure helpers the Jukebox panel, the pill and the folder player share. */

import type {
  MusicAlbum,
  MusicLibrary,
  MusicSourceId,
  MusicState,
  MusicTrack,
} from '../../../core/src/messages.js';
import { RADIO_STATION_NAME } from '../../../core/src/radioCredits.js';
import {
  MUSIC_NOW_PLAYING_SEPARATOR,
  MUSIC_STATION_ALL,
  MUSIC_STATION_RADIO,
} from './constants.js';
import { type AppSource, isPageSource, type MusicStoreState } from './musicStore.js';

export const SOURCE_LABELS: Readonly<Record<MusicSourceId, string>> = {
  radio: 'Radio',
  folder: 'My music',
  apple: 'Apple Music',
  spotify: 'Spotify',
};

export const APP_NAMES: Readonly<Record<AppSource, string>> = {
  apple: 'Music',
  spotify: 'Spotify',
};

/** "Track · Album", or whichever of the two is known. */
export function nowPlayingText(track?: string, album?: string): string {
  return [track, album].filter((s): s is string => !!s).join(MUSIC_NOW_PLAYING_SEPARATOR);
}

export interface TrackRef {
  track: MusicTrack;
  /** The folder album, or the radio station as one. */
  album: MusicAlbum;
  /** Who made a radio track (folder tracks have no artist). */
  artist?: string;
  /** The track's volume factor: a radio track's loudness match, else 1. */
  gain: number;
}

/** Poke Agents Radio as an album, so the folder player can queue it. */
export function radioAlbum(library: MusicLibrary | null): MusicAlbum {
  return {
    id: MUSIC_STATION_RADIO,
    name: RADIO_STATION_NAME,
    tracks: (library?.radioTracks ?? []).map(({ id, title, mimeType }) => ({
      id,
      title,
      mimeType,
    })),
  };
}

/** Every radio and folder track by id. */
export function indexTracks(library: MusicLibrary | null): Map<string, TrackRef> {
  const map = new Map<string, TrackRef>();
  const radio = radioAlbum(library);
  (library?.radioTracks ?? []).forEach(({ artist, gain }, i) => {
    const track = radio.tracks[i];
    map.set(track.id, { track, album: radio, artist, gain });
  });
  for (const album of library?.albums ?? []) {
    for (const track of album.tracks) map.set(track.id, { track, album, gain: 1 });
  }
  return map;
}

/** A station's tracks in order: 'radio' = the radio's, 'all' = every folder
 *  album's, else one folder album's. */
export function stationTrackIds(library: MusicLibrary | null, station: string): string[] {
  if (station === MUSIC_STATION_RADIO) return (library?.radioTracks ?? []).map((t) => t.id);
  const albums = library?.albums ?? [];
  const chosen =
    station === MUSIC_STATION_ALL ? albums : albums.filter((album) => album.id === station);
  return chosen.flatMap((album) => album.tracks.map((t) => t.id));
}

/** "Track · Artist" for a radio track, "Track · Album" for a folder one. */
export function trackLine(ref: TrackRef): string {
  return nowPlayingText(ref.track.title, ref.artist ?? ref.album.name);
}

/** "03", or "2-03" on a multi-disc album; empty without a number. */
export function trackNumberLabel(track: MusicTrack, multiDisc: boolean): string {
  if (track.trackNumber === undefined) return '';
  const number = String(track.trackNumber).padStart(2, '0');
  return multiDisc && track.discNumber !== undefined ? `${track.discNumber}-${number}` : number;
}

export function isMultiDisc(album: MusicAlbum): boolean {
  return new Set(album.tracks.map((t) => t.discNumber ?? 1)).size > 1;
}

/** The footer line for an app source. */
export function appNowPlaying(state: MusicState | undefined, source: 'apple' | 'spotify'): string {
  const name = APP_NAMES[source];
  if (!state) return `${name}: nothing yet`;
  if (state.error) return state.error;
  if (!state.running) return `${name} isn't open`;
  const text = nowPlayingText(state.track, state.album);
  if (!text) return `${name}: nothing playing`;
  return state.playing ? text : `${text} (paused)`;
}

export function trackCountLabel(count: number): string {
  return count === 1 ? '1 track' : `${count} tracks`;
}

/** What the pill shows: the active source's now-playing line while it plays. */
export function pillText(state: MusicStoreState): string | null {
  const source = state.activeSource;
  if (isPageSource(source)) {
    const { playing, trackId } = state.folder;
    if (!playing || !trackId) return null;
    const ref = indexTracks(state.library).get(trackId);
    return ref ? trackLine(ref) : null;
  }
  const app = state.apps[source];
  if (!app?.playing) return null;
  return nowPlayingText(app.track, app.album) || APP_NAMES[source];
}
