/**
 * Conductor provider constants. Every timing, size and name the provider uses
 * lives here (constants policy: no magic numbers in the modules).
 */

import type { ConductorScope } from '../../../../../core/src/messages.js';

// ── API and auth ────────────────────────────────────────────

export const CONDUCTOR_PROVIDER_ID = 'conductor';
export const CONDUCTOR_DISPLAY_NAME = 'Conductor';
export const CONDUCTOR_DEFAULT_BASE_URL = 'https://api.conductor.build';
export const ENV_API_KEY = 'CONDUCTOR_API_KEY';
export const ENV_API_TOKEN = 'CONDUCTOR_API_TOKEN';
export const ENV_API_URL = 'CONDUCTOR_API_URL';
/** Budget override (requests per minute), same as `--conductor-budget`. */
export const ENV_BUDGET = 'POKE_AGENTS_CONDUCTOR_BUDGET';
/** The Conductor CLI stores its token as a generic password under this service. */
export const KEYCHAIN_SERVICE = 'com.conductor.cli';
/** Keychain account prefix; the account is `default:<normalized base url>`. */
export const KEYCHAIN_ACCOUNT_PREFIX = 'default';
/** Absolute path, never resolved through PATH or a shell. */
export const SECURITY_BIN = '/usr/bin/security';
/** The Keychain may show an "allow access" prompt; give the user time to answer. */
export const KEYCHAIN_TIMEOUT_MS = 120_000;
export const AUTH_REQUIRED_MESSAGE =
  'Sign in with `conductor auth login` or set CONDUCTOR_API_KEY, then restart.';

// ── Client budget (token bucket) ────────────────────────────

export const DEFAULT_BUDGET_PER_MINUTE = 120;
/** The effective budget never drops below this, however many 429s arrive. */
export const MIN_BUDGET_PER_MINUTE = 12;
/** Bucket capacity as a fraction of the per-minute budget (startup burst). */
export const BUCKET_BURST_FRACTION = 0.25;
/** After a general 429 the budget recovers by this fraction of the configured
 *  budget per minute. */
export const BUDGET_RECOVERY_FRACTION_PER_MINUTE = 0.1;
/** Random delay added to every retry-after so clients don't stampede. */
export const RETRY_AFTER_JITTER_MS = 1_000;
/** Used when a 429 carries no usable retry-after header. */
export const DEFAULT_RETRY_AFTER_MS = 10_000;
/** 5xx and network failures: 1, 2, 4, 8 s ... capped. */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 15_000;

/** Request priorities: lower runs first when the bucket is short. */
export const PRIORITY_USER = 0;
export const PRIORITY_FOCUS = 1;
export const PRIORITY_HOT = 2;
export const PRIORITY_DISCOVERY = 3;
export const PRIORITY_WARM = 4;
export const PRIORITY_BACKGROUND = 5;
/** A request waiting this long moves up one priority level, but never past
 *  PRIORITY_HOT: under a saturated budget, background work (PC Box listings,
 *  off-screen onboarding) is otherwise never served and holds its unit slots. */
export const PRIORITY_AGING_MS = 15_000;

// ── Messages feed ───────────────────────────────────────────

/** The API silently caps `limit` at 100. */
export const MESSAGES_PAGE_LIMIT = 100;
/** First offset probed when searching for the tail of a feed. */
export const TAIL_PROBE_START = 128;
/** With a cached cursor, the first probe lands this far into its sessionIndex
 *  (indices have small permanent gaps, so the cursor's offset is a bit lower). */
export const TAIL_HINT_FRACTION = 0.97;
/** Stop the binary search once the tail is known within this many rows; the
 *  last page then still holds at least this many recent items. */
export const TAIL_WINDOW = 50;
/** Pages drained in one steady poll before switching to a tail re-probe. */
export const MAX_DRAIN_PAGES = 5;

// ── Discovery and polling cadence ───────────────────────────

export const TICK_MS = 500;
export const DISCOVERY_INTERVAL_MS = 15_000;
/** Every in-scope workspace's session list is refreshed at least this often. */
export const FULL_LIST_INTERVAL_MS = 5 * 60_000;
/** Lists of recently active workspaces are refreshed when older than this. */
export const SESSION_LIST_MAX_AGE_MS = 60_000;
/** A workspace whose lastActivityAt advanced is re-listed at most this often
 *  (planIntervals budgets for it). */
export const SESSION_LIST_MIN_GAP_MS = 60_000;
/** Archived session listings (PC Box) per workspace, at most this often. */
export const ARCHIVED_LIST_INTERVAL_MS = 2 * 60_000;
/** How long a listSessions() call keeps the archived listings refreshing. */
export const ARCHIVE_INTEREST_MS = 5 * 60_000;
/** An open PC Box lists this many of the most recently active workspaces at
 *  discovery priority (the rest in the background), so recent deposits show
 *  within seconds even when steady polls fill the budget. A deposit counts as
 *  workspace activity, so they are where recent deposits are. Two at a time
 *  (the list class), at most once per ARCHIVED_LIST_INTERVAL_MS each. */
export const ARCHIVED_LIST_PROMPT_WORKSPACES = 24;
export const WORKSPACES_PAGE_LIMIT = 100;
export const SESSIONS_PAGE_LIMIT = 100;
/** A workspace's session list is read at most this many pages deep. */
export const MAX_SESSION_LIST_PAGES = 10;
/** Units of work (a poll, a session's onboarding, a list) in flight at once. */
export const MAX_CONCURRENT_UNITS = 8;
/** Per-class limits, so slow background work never holds every slot. */
export const UNIT_CLASS_LIMITS = {
  discovery: 1,
  list: 2,
  onboard: 3,
  background: 2,
  poll: 6,
} as const;
/** Pinned sessions outside the discovered workspaces are resolved this often. */
export const PINNED_RESOLVE_INTERVAL_MS = 10 * 60_000;

export const FOCUS_POLL_MS = 2_000;
export const FOCUS_POLL_MAX_MS = 3_000;
export const HOT_POLL_MS = 2_500;
export const WARM_POLL_MS = 15_000;
export const WARM_POLL_MAX_MS = 30_000;
/** Sessions in scope but not shown never poll faster than this. */
export const OFFSCREEN_POLL_MS = 30_000;
export const STATUS_POLL_MS = 30_000;
export const STATUS_POLL_MAX_MS = 60_000;
/** Ceiling for the stretched hot and warm intervals. */
export const POLL_STRETCH_MAX_MS = 120_000;
/** Fraction of the effective budget the planner may schedule. */
export const BUDGET_PLANNING_FRACTION = 0.9;
/** Share of the budget steady polls get while sessions are still onboarding. */
export const ONBOARDING_POLL_SHARE = 0.5;

/** A message within this window keeps a session Hot. */
export const HOT_RECENT_MS = 60_000;
/** Done sessions with activity within this window are Warm. */
export const WARM_RECENT_MS = 15 * 60_000;
/** Done sessions in a `ready` workspace stay Warm for this long. */
export const WARM_READY_WORKSPACE_MS = 60 * 60_000;
/** How long a live link or a user action keeps a session Hot. */
export const PROMOTION_MS = 60_000;
/** A workspace's activity asks each of its other sessions for one catch-up
 *  poll, at most this often per session (it does not promote them). */
export const WORKSPACE_CATCHUP_MIN_GAP_MS = 60_000;
/** A focused session (open Pokédex) stays focused this long after the last
 *  request asked for it: twice the panel's 5 s refresh. */
export const FOCUS_TTL_MS = 10_000;
/** A focused session's linked sessions poll as Hot when their link carried
 *  activity this recently; at most this many of them. */
export const FOCUS_PEER_RECENT_MS = 15 * 60_000;
export const FOCUS_PEERS_MAX = 4;
/** A shown session walks in once its message count (its level) is known; if
 *  reading it fails, or takes longer than this after onboarding (a starved
 *  budget), it walks in anyway. */
export const LEVEL_WAIT_MAX_MS = 3 * 60_000;
/** A session withdrawn from the PC Box is shown like a pinned one this long;
 *  afterwards the withdrawal counts as its activity for the scope window. */
export const RESTORE_PIN_MS = 10 * 60_000;
/** Switch model: a create-session that failed on the network or with a 5xx is
 *  retried this many times (same session and message ids, so Conductor
 *  deduplicates), after 1 s, then 2 s. */
export const CONTINUE_RETRY_MAX = 2;
export const CONTINUE_RETRY_BASE_MS = 1_000;
/** Switch model: the same request again (same session, choice and message)
 *  within this long reuses the last create's session and message ids, so a
 *  click after a lost answer can't start a second session. */
export const CONTINUE_REUSE_MS = 10 * 60_000;
/** A session the office just created is kept even when a session listing that
 *  was already in flight comes back without it. */
export const CREATED_LIST_GRACE_MS = 60_000;
/** The user's favorite models (Switch model) are read again after this long,
 *  and a refusal (404: local organizations have none) is kept as long. */
export const FAVORITES_TTL_MS = 5 * 60_000;
/** A favorites read that failed for another reason (network, 5xx, 429) is
 *  tried again after this long. */
export const FAVORITES_RETRY_MS = 30_000;
/** Polls further apart than this are catch-ups, not steady tail polls. */
export const STEADY_POLL_GAP_MS = 60_000;
/** Feed items newer than this (and from a steady poll) animate links and notices. */
export const LIVE_WINDOW_MS = 30_000;
/** Reconcile immediately when the feed is quiet this long while we believe active. */
export const QUIET_RECONCILE_MS = 90_000;
/** A just-sent user message keeps the session "Starting" for this long. */
export const STARTING_GRACE_MS = 120_000;
/** Detail-only upserts (message count, activity time) are throttled to this. */
export const DETAILS_THROTTLE_MS = 10_000;
/** sessionsChanged is debounced by this much. */
export const SESSIONS_CHANGED_DEBOUNCE_MS = 500;

// ── Links ───────────────────────────────────────────────────

/** A sender-side edge without a message id merges with a receiver edge within this. */
export const LINK_MERGE_WINDOW_MS = 120_000;
/** Sender-side edges whose target never resolved are dropped after this. */
export const PENDING_EDGE_TTL_MS = 10 * 60_000;
export const LINK_PREVIEW_MAX = 140;
/** Upper bound on remembered edges and processed link observations. */
export const LINK_MEMORY_MAX = 5_000;

// ── Scope and visibility ────────────────────────────────────

export const DEFAULT_SCOPE: ConductorScope = {
  creator: 'me',
  activeWithinHours: 6,
  showIdle: true,
  maxSessions: 24,
};
export const MAX_ACTIVE_WITHIN_HOURS = 24 * 30;
export const MAX_SESSIONS_LIMIT = 200;
/** A shown session stays until it falls this many places past the cap. */
export const CAP_HYSTERESIS = 4;
export const MAX_CHILDREN_PER_LEAD = 12;

// ── Context windows ─────────────────────────────────────────

/** Codex `gpt-*` models; the API states no window, so this is the configured one. */
export const GPT_CONTEXT_WINDOW = 272_000;
export const CLAUDE_MODEL_PREFIX = 'claude-';
export const GPT_MODEL_PREFIX = 'gpt-';

// ── Text limits ─────────────────────────────────────────────

export const ERROR_MESSAGE_MAX = 200;
export const NOTICE_TEXT_MAX = 140;
export const LOG_CAPACITY = 40;
export const LOG_PROMPT_MAX = 600;
export const LOG_ASSISTANT_MAX = 400;
export const LOG_USER_MAX = 400;
export const LOG_TOOL_KEEP = 5;
/** Item keys remembered per log so replayed pages never duplicate entries. */
export const LOG_KEY_MEMORY = 2_000;
export const USER_ACTION_DETAIL_MAX = 120;
/** A pending question (sessionDetail.question): its text, and up to this many
 *  options of at most this length each. */
export const QUESTION_TEXT_MAX = 1_200;
export const QUESTION_OPTIONS_MAX = 8;
export const QUESTION_OPTION_MAX = 120;

// ── Chat history (getSessionHistory) ───────────────────────

/** Feed items per history page (the API's page cap). */
export const HISTORY_PAGE_ITEMS = 100;
/** Cursors this provider issues: `o<offset>`. */
export const HISTORY_CURSOR_PATTERN = /^o(\d{1,9})$/;

// ── Persistence ─────────────────────────────────────────────

export const STATE_FILE_NAME = 'conductor-state.json';
/** Held by the one office process that polls Conductor (pollerLock.ts). */
export const POLLER_LOCK_FILE_NAME = 'conductor.lock';
export const STATE_FILE_VERSION = 1;
export const STATE_FILE_MODE = 0o600;
/** User decisions (scope, hidden, pinned, a withdrawal) are written this soon... */
export const STATE_SAVE_DEBOUNCE_MS = 1_000;
/** ...and poll bookkeeping (cursors, activity times) at most this often. */
export const STATE_LAZY_SAVE_MS = 30_000;
/** Entries neither hidden nor pinned go once nothing touched them for this long. */
export const STATE_STALE_ENTRY_MS = 30 * 24 * 60 * 60_000;
/** At most this many session entries; the least recent go first. */
export const STATE_SESSIONS_MAX = 2_000;
/** A listed session's seenAt is refreshed at most this often. */
export const STATE_SEEN_REFRESH_MS = 24 * 60 * 60_000;

export const LOG_PREFIX = '[Pixel Agents] Conductor:';
