/**
 * Validators for links the user pastes into the Jukebox. Strict on purpose:
 * only the shapes below are accepted, and what the server keeps (and later
 * hands to an app) is rebuilt from the validated parts, never the pasted text.
 */

import type { MusicStationKind } from '../../../core/src/messages.js';
import { MUSIC_LINK_MAX_LENGTH } from './constants.js';
import { cleanName } from './text.js';

export interface SpotifyLink {
  kind: MusicStationKind;
  /** Base-62 Spotify id (22 characters). */
  id: string;
  /** `spotify:<kind>:<id>`, what the Spotify app plays. */
  uri: string;
  /** `https://open.spotify.com/<kind>/<id>`. */
  url: string;
}

export interface AppleMusicLink {
  kind: Exclude<MusicStationKind, 'track'>;
  storefront: string;
  /** Numeric album id, or a `pl.` playlist id. */
  id: string;
  /** `https://music.apple.com/<storefront>/<kind>/<slug>/<id>`. */
  url: string;
  /** What the Music app is asked to open (`itmss:` routes to the app, not a browser). */
  appUrl: string;
  /** A readable name from the URL slug ("pokemon-x-y" → "Pokemon X Y"), if any. */
  slugName?: string;
}

const SPOTIFY_URI = /^spotify:(album|playlist|track):([A-Za-z0-9]{22})$/;
// open.spotify.com/<kind>/<id>, optionally under a locale (/intl-de/) and with
// a share query (?si=...). The query is dropped.
const SPOTIFY_URL =
  /^https:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[A-Za-z]{2})?\/)?(album|playlist|track)\/([A-Za-z0-9]{22})\/?(?:\?[A-Za-z0-9=&%._~-]*)?$/;

// music.apple.com/<storefront>/album/<slug>/<id> (slug optional), or a
// playlist with a pl. id. An ?i= query names one song of the album; the
// station is the album, so it is dropped with the rest of the query.
const APPLE_URL =
  /^https:\/\/music\.apple\.com\/([a-z]{2})\/(album|playlist)\/(?:([A-Za-z0-9%._~-]{1,200})\/)?(\d{1,15}|pl\.[A-Za-z0-9-]{1,64})\/?(?:\?[A-Za-z0-9=&%._~-]*)?$/;

/** Printable, single-line, bounded: anything else is not a pasted link. */
function cleanInput(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text.length === 0 || text.length > MUSIC_LINK_MAX_LENGTH) return null;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return null;
  }
  return text;
}

export function parseSpotifyLink(input: unknown): SpotifyLink | null {
  const text = cleanInput(input);
  if (!text) return null;
  const match = SPOTIFY_URI.exec(text) ?? SPOTIFY_URL.exec(text);
  if (!match) return null;
  const kind = match[1] as MusicStationKind;
  const id = match[2];
  return {
    kind,
    id,
    uri: `spotify:${kind}:${id}`,
    url: `https://open.spotify.com/${kind}/${id}`,
  };
}

export function parseAppleMusicLink(input: unknown): AppleMusicLink | null {
  const text = cleanInput(input);
  if (!text) return null;
  const match = APPLE_URL.exec(text);
  if (!match) return null;
  const [, storefront, kindText, slug, id] = match;
  const kind = kindText as AppleMusicLink['kind'];
  // Albums have numeric ids, playlists pl. ids.
  if ((kind === 'album') !== /^\d+$/.test(id)) return null;
  const slugName = slug ? nameFromSlug(slug) : undefined;
  const path = `${storefront}/${kind}/${slug ? `${slug}/` : ''}${id}`;
  return {
    kind,
    storefront,
    id,
    url: `https://music.apple.com/${path}`,
    appUrl: `itmss://music.apple.com/${path}?app=music`,
    ...(slugName ? { slugName } : {}),
  };
}

function nameFromSlug(slug: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    return undefined;
  }
  const words = decoded
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return cleanName(words.join(' '));
}
