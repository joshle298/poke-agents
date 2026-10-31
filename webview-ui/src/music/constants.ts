/**
 * Jukebox constants (webview-ui/src/music/). Kept beside the module because
 * nothing outside it reads them.
 */

// ── Folder playback ────────────────────────────────────────────
/** Crossfade between consecutive tracks. */
export const MUSIC_CROSSFADE_MS = 1_500;
/** Crossfade when the user skips (next, previous, picking a track). */
export const MUSIC_SKIP_FADE_MS = 400;
/** Fade-in for the first track after silence. */
export const MUSIC_START_FADE_MS = 300;
/** A short track's crossfade never takes more than this share of it. */
export const MUSIC_CROSSFADE_MAX_SHARE = 1 / 3;
/** Volume ramps and ducks are applied this often while they run. */
export const MUSIC_RAMP_TICK_MS = 40;
/** Previous restarts the track instead when it has played this long. */
export const MUSIC_RESTART_THRESHOLD_SEC = 3;
/** Folder volume when nothing is remembered (0..1). */
export const MUSIC_DEFAULT_VOLUME = 0.6;

// ── Ducking (duckMusic) ────────────────────────────────────────
/** Folder music volume while a cry or alert plays, as a share of normal. */
export const MUSIC_DUCK_LEVEL = 0.25;
/** How fast the music dips under a cry, and how slowly it comes back. */
export const MUSIC_DUCK_ATTACK_MS = 80;
export const MUSIC_DUCK_RELEASE_MS = 600;
/** Longest single duck a caller may ask for. */
export const MUSIC_DUCK_MAX_MS = 15_000;

// ── Apps (Music, Spotify) ──────────────────────────────────────
/** How often the Jukebox asks the app what it is playing while it matters
 *  (the app is the active source, or its tab is open). */
export const MUSIC_APP_POLL_MS = 5_000;
/** A volume slider for an app sends its value once it rests this long. */
export const MUSIC_APP_VOLUME_DEBOUNCE_MS = 300;

// ── UI ─────────────────────────────────────────────────────────
/** Above the office overlays and the Pokédex sheet, below the modals. */
export const MUSIC_PILL_Z_INDEX = 46;
/** The pill sits above the bottom toolbar on desktop. */
export const MUSIC_PILL_BOTTOM_PX = 76;
export const MUSIC_PILL_MAX_WIDTH_PX = 280;
/** Marquee scroll speed (px per second) and the pause at each end. */
export const MUSIC_MARQUEE_PX_PER_SEC = 30;
export const MUSIC_MARQUEE_END_PAUSE_MS = 1_200;
/** Pixel steps per second of marquee movement (a retro, ticking scroll). */
export const MUSIC_MARQUEE_STEPS_PER_SEC = 10;
/** Separator between track and album in the now-playing line. */
export const MUSIC_NOW_PLAYING_SEPARATOR = ' · ';
/** A failure notice in the panel clears itself after this long. */
export const MUSIC_NOTICE_MS = 8_000;

// ── Preferences (localStorage) ─────────────────────────────────
export const MUSIC_PREF_SOURCE = 'pixel-agents.music.source';
export const MUSIC_PREF_STATION = 'pixel-agents.music.station';
export const MUSIC_PREF_VOLUME = 'pixel-agents.music.volume';
export const MUSIC_PREF_SHUFFLE = 'pixel-agents.music.shuffle';
export const MUSIC_PREF_TRACK = 'pixel-agents.music.track';
export const MUSIC_PREF_PLAYING = 'pixel-agents.music.playing';

/** The folder "station" that plays every album. */
export const MUSIC_STATION_ALL = 'all';
