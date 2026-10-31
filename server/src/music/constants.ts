/**
 * Jukebox constants (server/src/music/). Kept beside the module, like
 * pokemon/constants.ts, because nothing outside it reads them.
 *
 * The Jukebox only plays music the user is entitled to: Poke Agents Radio's
 * freely licensed tracks (radioCatalog.ts), audio files they put in the music
 * folder, and the Music and Spotify apps they already use. The radio is the
 * only audio it downloads. It never talks to Conductor.
 */

// ── Poke Agents Radio ──────────────────────────────────────────
/** Under ~/.pixel-agents/. One file per track: `<id>.ogg` or `<id>.mp3`. */
export const RADIO_CACHE_SUBDIR = ['cache', 'music', 'radio'] as const;
/** Radio track ids, `radio-<slug>`, as radioCredits.ts lists them. */
export const RADIO_ID_PATTERN = /^radio-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RADIO_ID_MAX_LENGTH = 64;
/** Integrated loudness (LUFS) the station plays every track at: a louder
 *  track is turned down to it; none is turned up, so the quietest tracks sit
 *  within about a decibel below. */
export const RADIO_TARGET_LUFS = -18;
/** A track is a few MB; one download may take this long on a slow line. */
export const RADIO_FETCH_TIMEOUT_MS = 120_000;
export const RADIO_FETCH_CONCURRENCY = 2;
/** After a download failed (offline, upstream down, checksum mismatch), the
 *  track isn't asked for again for this long, doubling per consecutive failure
 *  up to RADIO_FAILURE_BACKOFF_MAX_MS. */
export const RADIO_FAILURE_BACKOFF_MS = 30 * 1000;
export const RADIO_FAILURE_BACKOFF_MAX_MS = 30 * 60 * 1000;
/** Hosts the manifest may download from (radioCatalog.test.ts checks every URL). */
export const RADIO_SOURCE_HOSTS: readonly string[] = ['opengameart.org', 'incompetech.com'];

// ── Music folder ───────────────────────────────────────────────
/** Under ~/.pixel-agents/. One subfolder per game or album. */
export const MUSIC_DIR_NAME = 'music';
/** Audio files the folder source lists, by lower-cased extension, with the
 *  Content-Type they are served as. Browsers decode all of these (Chromium:
 *  every one except Apple Lossless inside .m4a). */
export const MUSIC_AUDIO_TYPES: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
};
/** Folder levels below the music folder that a scan enters (Artist/Album/Disc 1). */
export const MUSIC_SCAN_MAX_DEPTH = 4;
/** Tracks one scan lists; the rest are reported as truncated. */
export const MUSIC_SCAN_MAX_TRACKS = 5_000;
/** Directory entries one scan may visit, so a huge tree can't stall the server. */
export const MUSIC_SCAN_MAX_ENTRIES = 50_000;
/** A library request within this long of the last scan reuses it. */
export const MUSIC_SCAN_REUSE_MS = 2_000;
/** Album and track ids: the first hex digits of a SHA-256 of the relative path. */
export const MUSIC_ID_HEX_LENGTH = 24;
export const MUSIC_ID_PATTERN = /^[a-f0-9]{24}$/;
/** Folder names that hold one disc of the album above them ("Disc 2", "CD1"). */
export const MUSIC_DISC_FOLDER_PATTERN = /^(?:disc|disk|cd)\s*(\d{1,2})$/i;
/** The album name for files directly in the music folder. */
export const MUSIC_LOOSE_TRACKS_ALBUM = 'Other tracks';

// ── Route ──────────────────────────────────────────────────────
export const MUSIC_ROUTE_PREFIX = '/api/music';
/** Never cached beyond revalidation: a replaced folder file keeps its id. */
export const MUSIC_ROUTE_CACHE_CONTROL = 'private, no-cache';

// ── macOS apps ─────────────────────────────────────────────────
export const OSASCRIPT_PATH = '/usr/bin/osascript';
/** Controls (pause, next, status) answer quickly or count as failed. */
export const OSASCRIPT_TIMEOUT_MS = 10_000;
/** Commands that may launch the app first (play, resume, open a link). A cold
 *  Spotify gets up to 10 s to answer before it is told to play, and the first
 *  command also waits while macOS asks whether to allow control of the app. */
export const OSASCRIPT_LAUNCH_TIMEOUT_MS = 30_000;
/** Scanning a large Music library takes longer. */
export const OSASCRIPT_SCAN_TIMEOUT_MS = 60_000;
export const OSASCRIPT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** Where the apps live. Music ships with macOS 10.15+; Spotify is optional. */
export const MUSIC_APP_PATHS = ['/System/Applications/Music.app', '/Applications/Music.app'];
export const SPOTIFY_APP_PATHS = ['/Applications/Spotify.app', '~/Applications/Spotify.app'];
/** Longest string the server passes to a script as an argument. */
export const OSASCRIPT_ARG_MAX_LENGTH = 1_000;
/** Pokémon albums kept from one Music library scan. */
export const APPLE_ALBUMS_MAX = 500;
/** Longest album, artist or track name kept from the apps. */
export const MUSIC_NAME_MAX_LENGTH = 200;

// ── Saved stations ─────────────────────────────────────────────
/** ~/.pixel-agents/music.json: saved Apple Music and Spotify links. */
export const MUSIC_STATE_FILE_NAME = 'music.json';
export const MUSIC_STATE_FILE_VERSION = 1;
export const MUSIC_STATE_FILE_MODE = 0o600;
export const MUSIC_STATIONS_MAX = 100;
/** Longest link the Jukebox accepts from a paste. */
export const MUSIC_LINK_MAX_LENGTH = 500;

// ── Spotify titles ─────────────────────────────────────────────
/** Spotify's oEmbed endpoint names an album or playlist without sign-in. Asked
 *  once, when the user saves a Spotify link. */
export const SPOTIFY_OEMBED_URL = 'https://open.spotify.com/oembed';
export const SPOTIFY_OEMBED_TIMEOUT_MS = 5_000;
export const SPOTIFY_OEMBED_MAX_BYTES = 64 * 1024;
