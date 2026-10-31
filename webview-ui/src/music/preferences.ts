/**
 * What the Jukebox remembers per device (localStorage `pixel-agents.music.*`):
 * the last source (Poke Agents Radio until the user picks another), the page
 * player's station and track, shuffle, volume, and whether radio or folder
 * music was playing (so it can resume on the first click). Storage can be
 * missing (Node tests) or blocked (private windows); reads fall back and
 * writes become no-ops.
 */

import type { MusicSourceId } from '../../../core/src/messages.js';
import {
  MUSIC_DEFAULT_VOLUME,
  MUSIC_PREF_PLAYING,
  MUSIC_PREF_SHUFFLE,
  MUSIC_PREF_SOURCE,
  MUSIC_PREF_STATION,
  MUSIC_PREF_TRACK,
  MUSIC_PREF_VOLUME,
} from './constants.js';

export interface MusicPrefs {
  source: MusicSourceId;
  /** Page player station: MUSIC_STATION_RADIO, MUSIC_STATION_ALL or an album id. */
  station: string | null;
  track: string | null;
  shuffle: boolean;
  /** Page player volume, 0..1. */
  volume: number;
  playing: boolean;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    const s = storage();
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Full or blocked: the choice still applies for this session.
  }
}

const SOURCES: readonly MusicSourceId[] = ['radio', 'folder', 'apple', 'spotify'];
/** Nothing chosen yet: the built-in station. */
const DEFAULT_SOURCE: MusicSourceId = 'radio';
const ID = /^[A-Za-z0-9._-]{1,120}$/;

export function readMusicPrefs(): MusicPrefs {
  const source = read(MUSIC_PREF_SOURCE);
  const volume = Number(read(MUSIC_PREF_VOLUME));
  const station = read(MUSIC_PREF_STATION);
  const track = read(MUSIC_PREF_TRACK);
  return {
    source: SOURCES.includes(source as MusicSourceId) ? (source as MusicSourceId) : DEFAULT_SOURCE,
    station: station && ID.test(station) ? station : null,
    track: track && ID.test(track) ? track : null,
    shuffle: read(MUSIC_PREF_SHUFFLE) === '1',
    volume:
      read(MUSIC_PREF_VOLUME) !== null && Number.isFinite(volume) && volume >= 0 && volume <= 1
        ? volume
        : MUSIC_DEFAULT_VOLUME,
    playing: read(MUSIC_PREF_PLAYING) === '1',
  };
}

export function writeMusicPrefs(prefs: Partial<MusicPrefs>): void {
  if (prefs.source !== undefined) write(MUSIC_PREF_SOURCE, prefs.source);
  if (prefs.station !== undefined) write(MUSIC_PREF_STATION, prefs.station);
  if (prefs.track !== undefined) write(MUSIC_PREF_TRACK, prefs.track);
  if (prefs.shuffle !== undefined) write(MUSIC_PREF_SHUFFLE, prefs.shuffle ? '1' : '0');
  if (prefs.volume !== undefined) write(MUSIC_PREF_VOLUME, String(prefs.volume));
  if (prefs.playing !== undefined) write(MUSIC_PREF_PLAYING, prefs.playing ? '1' : '0');
}
