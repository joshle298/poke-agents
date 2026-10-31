/** Desktop app constants (the app's own; the office's live in server/src/constants.ts). */

export const APP_NAME = 'Poke Agents';

/** Product token the app adds to its window's user agent, so the office can
 *  tell its window (DESKTOP_APP_USER_AGENT_PRODUCT in webview-ui/src/constants.ts). */
export const USER_AGENT_PRODUCT = 'PokeAgentsDesktop';

/** Global the preload exposes to the office (DESKTOP_BRIDGE_GLOBAL in
 *  webview-ui/src/constants.ts). */
export const DESKTOP_BRIDGE_GLOBAL = 'pokeAgentsDesktop';
/** IPC: the office's Reconnect button (renderer → main). */
export const IPC_RECONNECT_CONDUCTOR = 'poke-agents:reconnect-conductor';
/** IPC: the Connect card asks for a Conductor API key on the clipboard, on a
 *  Paste click or when the window regains focus after "Get an API key"
 *  (renderer → main, answered with key-shaped text or null). */
export const IPC_READ_CLIPBOARD_KEY = 'poke-agents:read-clipboard-key';
/** IPC: app commands for the office (main → renderer): open a session's
 *  Pokédex, open Settings. */
export const IPC_OFFICE_COMMAND = 'poke-agents:office-command';
/** Commands the preload keeps for an office that hasn't subscribed yet. */
export const MAX_EARLY_COMMANDS = 4;

/** Help → Poke Agents Help: the README's Mac app section. */
export const HELP_URL = 'https://github.com/joshle298/poke-agents#mac-app';
/** About panel and Info.plist copyright (electron-builder.yml says the same). */
export const COPYRIGHT = '© 2026 Josh Le. MIT License. Based on Pixel Agents by Pablo De Lucca.';

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
/** File in the app's userData folder for one-time app events (the
 *  notifications introduction). */
export const APP_STATE_FILE = 'app-state.json';
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
/** At most this many notifications per window, across all sessions. Those
 *  over the limit fold into one summary once the window has room. */
export const NOTICE_RATE_MAX = 3;
export const NOTICE_RATE_WINDOW_MS = 30_000;
/** Notification id of that summary (a newer one replaces it). */
export const SUMMARY_NOTICE_ID = 'summary';
/** Most sessions a summary names before "and N more". */
export const SUMMARY_MAX_NAMES = 3;
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
/** Longest wait for the app's answer to the smoke run's Reconnect click. */
export const SMOKE_RECONNECT_TIMEOUT_MS = 20_000;
