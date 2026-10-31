/**
 * The fixed AppleScripts the Jukebox runs against the Music and Spotify apps on
 * macOS, and parsers for what they print.
 *
 * Every script is a constant below; nothing is ever spliced into script text.
 * Values that vary (an album name from the user's library, a validated Spotify
 * URI, a volume) travel as osascript arguments (`osascript -e <script> <arg>…`),
 * which the script reads from `argv` as plain strings. Each argument is
 * prefixed with ARG_PREFIX, which the script strips, so no value can ever look
 * like an osascript option, and each is checked to be one printable line.
 * Only the actions in the two command tables can be built.
 */

import {
  APPLE_ALBUMS_MAX,
  OSASCRIPT_ARG_MAX_LENGTH,
  OSASCRIPT_SCAN_TIMEOUT_MS,
  OSASCRIPT_TIMEOUT_MS,
} from './constants.js';
import { JukeboxError } from './errors.js';
import { cleanName } from './text.js';

export type MusicAppId = 'apple' | 'spotify';

/** One osascript run: `osascript -e <script> <...args>`. */
export interface OsaCommand {
  script: string;
  args: string[];
  timeoutMs: number;
}

/** Leading character of every argument; the scripts drop it. */
export const ARG_PREFIX = '_';

/** Field and record separators in script output (ASCII unit / record separators). */
const US = '\u001f';
const RS = '\u001e';

/** The Jukebox's queue playlist in the Music app, and the description that
 *  marks it as ours (a user playlist with the same name is never touched). */
export const JUKEBOX_PLAYLIST_NAME = 'Poke Agents Jukebox';
export const JUKEBOX_PLAYLIST_NOTE = 'Queued by Poke Agents. Safe to delete.';

/** Custom script error numbers (AppleScript `error ... number N`). */
export const SCRIPT_ERROR_ALBUM_GONE = 7404;
export const SCRIPT_ERROR_PLAYLIST_TAKEN = 7409;

const MUSIC_APP = 'application id "com.apple.Music"';
const SPOTIFY_APP = 'application id "com.spotify.client"';

/** Tracks the Music library scan and "Shuffle all" consider Pokémon music:
 *  album, album artist or artist naming Pokémon (accented, plain or Japanese). */
const POKEMON_FILTER = [
  'album contains "Pokémon"',
  'album contains "Pokemon"',
  'album contains "ポケモン"',
  'album artist contains "Pokémon"',
  'album artist contains "Pokemon"',
  'artist contains "Pokémon"',
  'artist contains "Pokemon"',
].join(' or ');

/** Reads the player state as a plain word, whatever the app's enumeration. */
const READ_STATE = `
		if player state is playing then
			set st to "playing"
		else if player state is paused then
			set st to "paused"
		else
			set st to "stopped"
		end if`;

function statusScript(app: string, shuffleProperty: string): string {
  return `on run argv
	set US to character id 31
	if ${app} is not running then return "notRunning"
	tell ${app}
		${READ_STATE.trim()}
		set sh to ${shuffleProperty} as text
		set vol to sound volume as text
		set nm to ""
		set al to ""
		set ar to ""
		if st is not "stopped" then
			try
				set t to current track
				set nm to name of t
				set al to album of t
				set ar to artist of t
			end try
		end if
	end tell
	return "running" & US & st & US & sh & US & vol & US & nm & US & al & US & ar
end run`;
}

/** A one-line control that does nothing (and never launches the app) when the
 *  app is closed. */
function controlScript(app: string, body: string): string {
  return `on run argv
	if ${app} is not running then return "notRunning"
	tell ${app}
		${body}
	end tell
	return "ok"
end run`;
}

/** Fill the Jukebox playlist with `trackSpecifier` and play it. */
function queueAndPlayScript(trackSpecifier: string, firstArgIsAlbum: boolean): string {
  const shuffleArg = firstArgIsAlbum ? 2 : 1;
  return `on run argv
	${firstArgIsAlbum ? 'set albumName to text 2 thru -1 of (item 1 of argv)' : ''}
	set wantShuffle to ((item ${shuffleArg} of argv) is "${ARG_PREFIX}true")
	set plName to "${JUKEBOX_PLAYLIST_NAME}"
	set plNote to "${JUKEBOX_PLAYLIST_NOTE}"
	tell ${MUSIC_APP}
		set lib to library playlist 1
		if (count of (${trackSpecifier})) is 0 then error "No matching tracks in your Music library." number ${SCRIPT_ERROR_ALBUM_GONE}
		if exists user playlist plName then
			set pl to user playlist plName
			try
				set owned to ((description of pl) is plNote)
			on error
				-- No playlist descriptions in this Music: the name alone marks it.
				set owned to true
			end try
			if not owned then error "A playlist named ${JUKEBOX_PLAYLIST_NAME} already exists." number ${SCRIPT_ERROR_PLAYLIST_TAKEN}
			delete every track of pl
		else
			set pl to make new user playlist with properties {name:plName}
			try
				set description of pl to plNote
			end try
		end if
		duplicate (${trackSpecifier}) to pl
		set shuffle enabled to wantShuffle
		play pl
	end tell
	return "ok"
end run`;
}

const MUSIC_SCRIPTS = {
  status: statusScript(MUSIC_APP, 'shuffle enabled'),
  listPokemonAlbums: `on run argv
	set US to character id 31
	set RS to character id 30
	tell ${MUSIC_APP}
		set lib to library playlist 1
		try
			set theAlbums to album of (every track of lib whose ${POKEMON_FILTER})
			set theAlbumArtists to album artist of (every track of lib whose ${POKEMON_FILTER})
			set theArtists to artist of (every track of lib whose ${POKEMON_FILTER})
		on error number -1728
			-- Nothing matched.
			return ""
		end try
	end tell
	set AppleScript's text item delimiters to US
	set a to theAlbums as text
	set b to theAlbumArtists as text
	set c to theArtists as text
	set AppleScript's text item delimiters to ""
	return a & RS & b & RS & c
end run`,
  playAlbum: queueAndPlayScript('every track of lib whose album is albumName', true),
  playAllPokemon: queueAndPlayScript(`every track of lib whose ${POKEMON_FILTER}`, false),
  // Resuming may open the app: the user pressed play.
  resume: `on run argv
	tell ${MUSIC_APP} to play
	return "ok"
end run`,
  pause: controlScript(MUSIC_APP, 'pause'),
  next: controlScript(MUSIC_APP, 'next track'),
  previous: controlScript(MUSIC_APP, 'previous track'),
  setShuffle: controlScript(
    MUSIC_APP,
    `set shuffle enabled to ((item 1 of argv) is "${ARG_PREFIX}true")`,
  ),
  setVolume: controlScript(
    MUSIC_APP,
    'set sound volume to ((text 2 thru -1 of (item 1 of argv)) as integer)',
  ),
  openLocation: `on run argv
	set theUrl to text 2 thru -1 of (item 1 of argv)
	tell ${MUSIC_APP}
		open location theUrl
		activate
	end tell
	return "ok"
end run`,
} as const;

/** Waits for a just-launched Spotify to answer before driving it. */
const SPOTIFY_WAIT_READY = `repeat 40 times
			try
				get player state
				exit repeat
			on error
				delay 0.25
			end try
		end repeat`;

const SPOTIFY_SCRIPTS = {
  status: statusScript(SPOTIFY_APP, 'shuffling'),
  // Spotify applies shuffle reliably only once playback has started, so it is
  // set before and again after.
  playUri: `on run argv
	set theUri to text 2 thru -1 of (item 1 of argv)
	set wantShuffle to ((item 2 of argv) is "${ARG_PREFIX}true")
	tell ${SPOTIFY_APP}
		${SPOTIFY_WAIT_READY}
		set shuffling to wantShuffle
		play track theUri
		delay 0.5
		set shuffling to wantShuffle
	end tell
	return "ok"
end run`,
  resume: `on run argv
	tell ${SPOTIFY_APP}
		${SPOTIFY_WAIT_READY}
		play
	end tell
	return "ok"
end run`,
  pause: controlScript(SPOTIFY_APP, 'pause'),
  next: controlScript(SPOTIFY_APP, 'next track'),
  previous: controlScript(SPOTIFY_APP, 'previous track'),
  setShuffle: controlScript(
    SPOTIFY_APP,
    `set shuffling to ((item 1 of argv) is "${ARG_PREFIX}true")`,
  ),
  setVolume: controlScript(
    SPOTIFY_APP,
    'set sound volume to ((text 2 thru -1 of (item 1 of argv)) as integer)',
  ),
} as const;

export type AppleMusicAction = keyof typeof MUSIC_SCRIPTS;
export type SpotifyAction = keyof typeof SPOTIFY_SCRIPTS;

export const APPLE_MUSIC_ACTIONS: ReadonlySet<string> = new Set(Object.keys(MUSIC_SCRIPTS));
export const SPOTIFY_ACTIONS: ReadonlySet<string> = new Set(Object.keys(SPOTIFY_SCRIPTS));

/** Thrown when a command can't be built (unknown action, bad argument). */
export class ScriptArgumentError extends JukeboxError {}

function isValidArg(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > OSASCRIPT_ARG_MAX_LENGTH) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** One osascript argument: a printable single line, prefixed. */
export function osaArg(value: string): string {
  if (!isValidArg(value)) throw new ScriptArgumentError('Invalid script argument.');
  return `${ARG_PREFIX}${value}`;
}

function boolArg(value: boolean): string {
  return osaArg(value ? 'true' : 'false');
}

function volumeArg(volume: unknown): string {
  if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 100) {
    throw new ScriptArgumentError('Volume must be a whole number from 0 to 100.');
  }
  return osaArg(String(volume));
}

const SPOTIFY_URI_ARG = /^spotify:(album|playlist|track):[A-Za-z0-9]{22}$/;
const APPLE_APP_URL_ARG = /^itmss:\/\/music\.apple\.com\/[A-Za-z0-9%._~/-]+\?app=music$/;

export interface AppleMusicParams {
  albumName?: string;
  shuffle?: boolean;
  volume?: number;
  url?: string;
}

export interface SpotifyParams {
  uri?: string;
  shuffle?: boolean;
  volume?: number;
}

/** Build a Music app command. Throws ScriptArgumentError for anything off the
 *  allowlist. */
export function appleMusicCommand(action: string, params: AppleMusicParams = {}): OsaCommand {
  if (!APPLE_MUSIC_ACTIONS.has(action)) throw new ScriptArgumentError('Unknown action.');
  const a = action as AppleMusicAction;
  const args: string[] = [];
  switch (a) {
    case 'playAlbum':
      args.push(osaArg(params.albumName ?? ''), boolArg(params.shuffle ?? false));
      break;
    case 'playAllPokemon':
      args.push(boolArg(params.shuffle ?? true));
      break;
    case 'setShuffle':
      args.push(boolArg(params.shuffle ?? false));
      break;
    case 'setVolume':
      args.push(volumeArg(params.volume));
      break;
    case 'openLocation':
      if (typeof params.url !== 'string' || !APPLE_APP_URL_ARG.test(params.url)) {
        throw new ScriptArgumentError('Invalid Apple Music link.');
      }
      args.push(osaArg(params.url));
      break;
    default:
      break;
  }
  const slow = a === 'listPokemonAlbums' || a === 'playAlbum' || a === 'playAllPokemon';
  return {
    script: MUSIC_SCRIPTS[a],
    args,
    timeoutMs: slow ? OSASCRIPT_SCAN_TIMEOUT_MS : OSASCRIPT_TIMEOUT_MS,
  };
}

/** Build a Spotify app command. Throws ScriptArgumentError for anything off the
 *  allowlist. */
export function spotifyCommand(action: string, params: SpotifyParams = {}): OsaCommand {
  if (!SPOTIFY_ACTIONS.has(action)) throw new ScriptArgumentError('Unknown action.');
  const a = action as SpotifyAction;
  const args: string[] = [];
  switch (a) {
    case 'playUri':
      if (typeof params.uri !== 'string' || !SPOTIFY_URI_ARG.test(params.uri)) {
        throw new ScriptArgumentError('Invalid Spotify link.');
      }
      args.push(osaArg(params.uri), boolArg(params.shuffle ?? false));
      break;
    case 'setShuffle':
      args.push(boolArg(params.shuffle ?? false));
      break;
    case 'setVolume':
      args.push(volumeArg(params.volume));
      break;
    default:
      break;
  }
  return { script: SPOTIFY_SCRIPTS[a], args, timeoutMs: OSASCRIPT_TIMEOUT_MS };
}

// ── Output parsers ─────────────────────────────────────────────

export interface AppStatus {
  running: boolean;
  playing: boolean;
  shuffle?: boolean;
  volume?: number;
  track?: string;
  album?: string;
  artist?: string;
}

/** Parse what a status script printed. */
export function parseStatus(output: string): AppStatus {
  const text = output.replace(/\r?\n$/, '');
  if (text.trim() === 'notRunning') return { running: false, playing: false };
  const [marker, state, shuffle, volume, track, album, artist] = text.split(US);
  if (marker !== 'running') return { running: false, playing: false };
  const vol = Number(volume);
  const status: AppStatus = {
    running: true,
    playing: state === 'playing',
    shuffle: shuffle === 'true',
  };
  if (Number.isInteger(vol) && vol >= 0 && vol <= 100) status.volume = vol;
  const name = cleanName(track);
  const albumName = cleanName(album);
  const artistName = cleanName(artist);
  if (name) status.track = name;
  if (albumName) status.album = albumName;
  if (artistName) status.artist = artistName;
  return status;
}

export interface LibraryAlbum {
  name: string;
  artist?: string;
  trackCount: number;
}

/** Parse the library scan: one album per distinct album name, with the most
 *  common album artist (else track artist) and its track count. */
export function parsePokemonAlbums(output: string): LibraryAlbum[] {
  const [albumsText = '', albumArtistsText = '', artistsText = ''] = output
    .replace(/\r?\n$/, '')
    .split(RS);
  const albums = albumsText.split(US);
  const albumArtists = albumArtistsText.split(US);
  const artists = artistsText.split(US);
  const byName = new Map<string, { name: string; count: number; artists: Map<string, number> }>();
  albums.forEach((raw, i) => {
    // The exact name is what playAlbum hands back to the app; one that could
    // not travel as a script argument could not be played, so it is skipped.
    if (!isValidArg(raw) || raw.trim() === '') return;
    const entry = byName.get(raw) ?? { name: raw, count: 0, artists: new Map() };
    entry.count += 1;
    const artist = cleanName(albumArtists[i]) ?? cleanName(artists[i]);
    if (artist) entry.artists.set(artist, (entry.artists.get(artist) ?? 0) + 1);
    byName.set(raw, entry);
  });
  const result: LibraryAlbum[] = [];
  for (const entry of byName.values()) {
    let artist: string | undefined;
    let best = 0;
    for (const [name, count] of entry.artists) {
      if (count > best) {
        artist = name;
        best = count;
      }
    }
    result.push({ name: entry.name, trackCount: entry.count, ...(artist ? { artist } : {}) });
  }
  result.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return result.slice(0, APPLE_ALBUMS_MAX);
}
