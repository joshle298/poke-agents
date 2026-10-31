/**
 * Demo provider constants (constants policy: no magic numbers in the modules).
 */

/** The demo stands in for Conductor: the office keys its chrome (party bar,
 *  Pokédex, PC Box, Sessions modal) off this provider id. */
export const DEMO_PROVIDER_ID = 'conductor';
export const DEMO_DISPLAY_NAME = 'Conductor demo';
/** Shown as the account in the status line ("Conductor: demo mode · …"). */
export const DEMO_ACCOUNT = 'demo mode, synthetic sessions';
export const DEMO_CREATOR_NAME = 'Demo User';
export const DEMO_LOG_PREFIX = '[Pixel Agents] Demo:';
/** The demo office's seats and agents: `~/.pixel-agents/demo-state.json`. */
export const DEMO_STATE_FILE_STEM = 'demo';

/** Speed factor override, same as `--demo-speed`. */
export const ENV_DEMO_SPEED = 'POKE_AGENTS_DEMO_SPEED';
export const DEFAULT_DEMO_SPEED = 1;
export const DEMO_SPEED_MIN = 0.25;
export const DEMO_SPEED_MAX = 20;
/** The story itself is fixed; the seed varies the generated history, replies
 *  and later rounds. */
export const DEFAULT_DEMO_SEED = 42;
export const DEMO_SEED_MAX = 2_147_483_647;

/** How often the player advances the script (real time). */
export const DEMO_TICK_MS = 100;
/** Safety stop for one advance (a long stall at high speed plays at most this
 *  many events, the rest on the next tick). */
export const DEMO_EVENTS_PER_ADVANCE_MAX = 5_000;
/** Length of one round of the story (script seconds); then the next round starts. */
export const DEMO_CYCLE_SEC = 300;

/** Session list broadcasts: membership and flags at once, activity times alone
 *  at most this often (as the Conductor poller throttles them). */
export const DEMO_SESSIONS_ACTIVITY_THROTTLE_MS = 10_000;

/** Pokédex detail: the newest entries, with at most this many tool rows (the
 *  Conductor log keeps the last 5 tool labels). */
export const DEMO_DETAIL_ENTRIES = 40;
export const DEMO_DETAIL_TOOL_ROWS = 5;
/** Per session, the full log is kept up to this many entries (oldest dropped). */
export const DEMO_TRANSCRIPT_MAX = 1_500;
/** Level and activity facts (agentDetails) at most this often per session. */
export const DEMO_DETAILS_THROTTLE_MS = 1_500;
/** Chat history page size. */
export const DEMO_HISTORY_PAGE = 30;
/** History cursors: `t<index of the first entry of the newer page>`. */
export const DEMO_HISTORY_CURSOR_PATTERN = /^t(\d{1,6})$/;

/** Default durations (script seconds). */
export const DEMO_SAY_SEC = 1.2;
export const DEMO_BEGIN_SEC = 0.4;
/** A short pause after a message lands before the receiver starts on it. */
export const DEMO_RECEIVE_DELAY_SEC = 0.8;

/** Context growth: a tool adds this base plus a share per second it ran. */
export const DEMO_TOOL_TOKENS_BASE = 2_400;
export const DEMO_TOOL_TOKENS_PER_SEC = 900;
export const DEMO_SAY_TOKENS = 600;

/** Synthetic history before the demo starts: spread over this many minutes. */
export const DEMO_BACKSTORY_SPAN_MIN = 90;
export const DEMO_BACKSTORY_MAX_ENTRIES = 72;

/** Deep links look like Conductor's, but the demo never opens them. */
export const DEMO_DEEP_LINK_BASE = 'conductor://workspace';
export const DEMO_OPEN_EXTERNAL_REFUSAL =
  "This is a demo session: it doesn't exist in Conductor, so there is nothing to open.";
