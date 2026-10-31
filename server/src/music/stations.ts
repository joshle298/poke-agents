/**
 * Saved Apple Music and Spotify links (the Jukebox's "stations"), kept in
 * `~/.pixel-agents/music.json` (atomic tmp + rename, mode 0600).
 *
 * Only the canonical link and a display name are stored. Everything an app is
 * later handed (the spotify: URI, the itmss: link) is rebuilt by re-validating
 * the stored link on every load, so an edited file can't smuggle anything into
 * a script argument.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { MusicSourceId, MusicStationKind } from '../../../core/src/messages.js';
import { LAYOUT_FILE_DIR } from '../constants.js';
import {
  MUSIC_STATE_FILE_MODE,
  MUSIC_STATE_FILE_NAME,
  MUSIC_STATE_FILE_VERSION,
  MUSIC_STATIONS_MAX,
  SPOTIFY_OEMBED_MAX_BYTES,
  SPOTIFY_OEMBED_TIMEOUT_MS,
  SPOTIFY_OEMBED_URL,
} from './constants.js';
import { JukeboxError } from './errors.js';
import type { AppleMusicLink, SpotifyLink } from './links.js';
import { parseAppleMusicLink, parseSpotifyLink } from './links.js';
import { cleanName } from './text.js';

export interface Station {
  id: string;
  source: Exclude<MusicSourceId, 'folder'>;
  kind: MusicStationKind;
  name: string;
  url: string;
  /** What the app is handed: a spotify: URI, or an itmss: link for Music. */
  target: string;
}

interface StoredStation {
  source: string;
  url: string;
  name: string;
}

export function defaultMusicStateFile(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, MUSIC_STATE_FILE_NAME);
}

export function spotifyStation(link: SpotifyLink, name?: string): Station {
  return {
    id: `spotify-${link.kind}-${link.id}`,
    source: 'spotify',
    kind: link.kind,
    name: cleanName(name) ?? defaultSpotifyName(link.kind),
    url: link.url,
    target: link.uri,
  };
}

export function appleStation(link: AppleMusicLink, name?: string): Station {
  return {
    id: `apple-${link.kind}-${link.id}`,
    source: 'apple',
    kind: link.kind,
    name: cleanName(name) ?? link.slugName ?? `Apple Music ${link.kind}`,
    url: link.url,
    target: link.appUrl,
  };
}

function defaultSpotifyName(kind: MusicStationKind): string {
  return `Spotify ${kind}`;
}

/** Rebuild a station from what the file holds, or null when it no longer validates. */
function revive(raw: unknown): Station | null {
  if (!raw || typeof raw !== 'object') return null;
  const { source, url, name } = raw as Partial<StoredStation>;
  if (source === 'spotify') {
    const link = parseSpotifyLink(url);
    return link ? spotifyStation(link, name) : null;
  }
  if (source === 'apple') {
    const link = parseAppleMusicLink(url);
    return link ? appleStation(link, name) : null;
  }
  return null;
}

export class StationStore {
  private stations: Station[] | null = null;

  constructor(private readonly file: string = defaultMusicStateFile()) {}

  list(): Station[] {
    if (!this.stations) this.stations = this.load();
    return this.stations;
  }

  get(id: string): Station | undefined {
    return this.list().find((s) => s.id === id);
  }

  /** Save a station (a re-saved link keeps its place and takes the new name). */
  add(station: Station): void {
    const list = this.list();
    const index = list.findIndex((s) => s.id === station.id);
    if (index >= 0) list[index] = station;
    else {
      if (list.length >= MUSIC_STATIONS_MAX) {
        throw new JukeboxError(
          `The Jukebox keeps up to ${MUSIC_STATIONS_MAX} links. Remove one first.`,
        );
      }
      list.push(station);
    }
    this.save(list);
  }

  remove(id: string): boolean {
    const list = this.list();
    const next = list.filter((s) => s.id !== id);
    if (next.length === list.length) return false;
    this.stations = next;
    this.save(next);
    return true;
  }

  private load(): Station[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch {
      return [];
    }
    const rawList = (parsed as { stations?: unknown } | null)?.stations;
    if (!Array.isArray(rawList)) return [];
    const seen = new Set<string>();
    const stations: Station[] = [];
    for (const raw of rawList.slice(0, MUSIC_STATIONS_MAX)) {
      const station = revive(raw);
      if (station && !seen.has(station.id)) {
        seen.add(station.id);
        stations.push(station);
      }
    }
    return stations;
  }

  private save(list: Station[]): void {
    const data = {
      version: MUSIC_STATE_FILE_VERSION,
      stations: list.map(({ source, url, name }): StoredStation => ({ source, url, name })),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: MUSIC_STATE_FILE_MODE });
    fs.renameSync(tmp, this.file);
  }
}

/**
 * The album or playlist title Spotify's oEmbed endpoint reports, or undefined
 * when it can't be had (offline, timeout, unexpected answer). Called once, when
 * the user saves a Spotify link; the request names only the canonical link.
 */
export async function fetchSpotifyTitle(
  link: SpotifyLink,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${SPOTIFY_OEMBED_URL}?url=${encodeURIComponent(link.url)}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(SPOTIFY_OEMBED_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return undefined;
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > SPOTIFY_OEMBED_MAX_BYTES) return undefined;
    const text = await res.text();
    if (text.length > SPOTIFY_OEMBED_MAX_BYTES) return undefined;
    const body = JSON.parse(text) as { title?: unknown };
    return cleanName(body.title);
  } catch {
    return undefined;
  }
}
