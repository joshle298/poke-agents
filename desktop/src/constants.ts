/** Desktop app constants (the app's own; the office's live in server/src/constants.ts). */

export const APP_NAME = 'Poke Agents';

/** Product token the app adds to its window's user agent. The office matches
 *  it (DESKTOP_APP_USER_AGENT_PRODUCT in webview-ui/src/constants.ts) to word
 *  its sign-in steps for the app. */
export const USER_AGENT_PRODUCT = 'PokeAgentsDesktop';

/** The office's night-dark background (--color-bg-dark), painted before the
 *  first frame so the window never flashes white. */
export const WINDOW_BACKGROUND = '#1a1c2c';

// ── Window ────────────────────────────────────────────────────

export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 820;
/** Below this the office's party bar and toolbar start to collide. */
export const MIN_WINDOW_WIDTH = 720;
export const MIN_WINDOW_HEIGHT = 480;
/** File in the app's userData folder that remembers the window's frame. */
export const WINDOW_STATE_FILE = 'window-state.json';
/** Coalesce move/resize bursts into one write. */
export const WINDOW_STATE_SAVE_DELAY_MS = 500;

// ── Notifications and the Dock badge ─────────────────────────

/** A session's state within this long of it entering the office is where it
 *  already was (adoption, a replay), not news. */
export const ADOPTION_GRACE_MS = 5_000;
/** After connecting to an office another process runs, its replay of the
 *  whole office is not news either. */
export const RECONNECT_QUIET_MS = 8_000;
/** The same session and reason notify at most once per this long. */
export const NOTICE_DEDUPE_MS = 2 * 60_000;
/** At most this many notifications per window, across all sessions. */
export const NOTICE_RATE_MAX = 3;
export const NOTICE_RATE_WINDOW_MS = 30_000;
/** Notifications kept referenced for their click handler. */
export const MAX_RETAINED_NOTIFICATIONS = 20;
/** Longest error text a "fainted" notification shows. */
export const NOTICE_ERROR_MAX_LENGTH = 140;

// ── Office connection ─────────────────────────────────────────

/** The office's Pokémon theme switch, a shared setting the server keeps
 *  (KEY_POKEMON_THEME in server/src/clientMessageHandler.ts). */
export const POKEMON_THEME_SETTING = 'pixel-agents.pokemonTheme';

/** How often to check that a reused office server (a `poke-agents` CLI) is
 *  still running, so the app can start its own when it stops. */
export const REUSED_SERVER_CHECK_MS = 2_000;
/** Delay before reconnecting the notification feed to a reused office. */
export const FEED_RETRY_MS = 2_000;
/** Longest wait for the in-process office to stop on quit. */
export const STOP_TIMEOUT_MS = 5_000;

// ── Smoke run (--smoke) ───────────────────────────────────────

/** Longest wait for the office to render. */
export const SMOKE_TIMEOUT_MS = 45_000;
/** Extra time after it renders, for sessions and sprites to arrive. */
export const SMOKE_SETTLE_MS = 8_000;
export const SMOKE_POLL_MS = 500;
