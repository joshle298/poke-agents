/** Pure helpers the Jukebox panel, the pill and the folder player share. */

import type {
  MusicAlbum,
  MusicLibrary,
  MusicSourceId,
  MusicState,
  MusicTrack,
} from '../../../core/src/messages.js';
import { MUSIC_NOW_PLAYING_SEPARATOR, MUSIC_STATION_ALL } from './constants.js';
import type { MusicStoreState } from './musicStore.js';

export const SOURCE_LABELS: Readonly<Record<MusicSourceId, string>> = {
  folder: 'My music',
  apple: 'Apple Music',
  spotify: 'Spotify',
};

export const APP_NAMES: Readonly<Record<Exclude<MusicSourceId, 'folder'>, string>> = {
  apple: 'Music',
  spotify: 'Spotify',
};

/** "Track · Album", or whichever of the two is known. */
export function nowPlayingText(track?: string, album?: string): string {
  return [track, album].filter((s): s is string => !!s).join(MUSIC_NOW_PLAYING_SEPARATOR);
}

export interface TrackRef {
  track: MusicTrack;
  album: MusicAlbum;
}

/** Every folder track by id. */
export function indexTracks(library: MusicLibrary | null): Map<string, TrackRef> {
  const map = new Map<string, TrackRef>();
  for (const album of library?.albums ?? []) {
    for (const track of album.tracks) map.set(track.id, { track, album });
  }
  return map;
}

/** A folder station's tracks in album order ('all' = every album). */
export function stationTrackIds(library: MusicLibrary | null, station: string): string[] {
  const albums = library?.albums ?? [];
  const chosen =
    station === MUSIC_STATION_ALL ? albums : albums.filter((album) => album.id === station);
  return chosen.flatMap((album) => album.tracks.map((t) => t.id));
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
  if (source === 'folder') {
    const { playing, trackId } = state.folder;
    if (!playing || !trackId) return null;
    const ref = state.library?.albums
      .flatMap((album) => album.tracks.map((track) => ({ track, album })))
      .find((r) => r.track.id === trackId);
    return ref ? nowPlayingText(ref.track.title, ref.album.name) : null;
  }
  const app = state.apps[source];
  if (!app?.playing) return null;
  return nowPlayingText(app.track, app.album) || APP_NAMES[source];
}
