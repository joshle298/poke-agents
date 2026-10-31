// ── JSONL File Watching ─────────────────────────────────────
export const JSONL_POLL_INTERVAL_MS = 1000;
export const FILE_WATCHER_POLL_INTERVAL_MS = 500;
export const PROJECT_SCAN_INTERVAL_MS = 1000;

// ── Heuristic Agent Status Detection ────────────────────────
// These timers are the fallback when CLI hooks are not active
// (hookDelivered = false). When hooks are working, these are
// suppressed and the server receives instant events instead.
/** Delay before sending agentToolDone (prevents UI flicker on rapid tool transitions) */
export const TOOL_DONE_DELAY_MS = 300;
/** Heuristic: time after a non-exempt tool starts before showing permission bubble.
 *  Not used for teammates -- false positives on slow tools (WebFetch/WebSearch).
 *  Teammates rely on the lead's routed Notification(permission_prompt) hook. */
export const PERMISSION_TIMER_DELAY_MS = 7000;
/** Heuristic: silence duration before marking a text-only turn as complete */
export const TEXT_IDLE_DELAY_MS = 5000;
/** Heuristic: idle threshold for per-agent /clear detection (content check prevents stealing) */
export const CLEAR_IDLE_THRESHOLD_MS = 2000;

// ── External Session Detection ──────────────────────────────
export const EXTERNAL_SCAN_INTERVAL_MS = 3000;
/** Only adopt JSONL files modified within this window */
export const EXTERNAL_ACTIVE_THRESHOLD_MS = 120_000; // 2 minutes
/** Remove external agents after this much inactivity */
// export const EXTERNAL_STALE_TIMEOUT_MS = 300_000; // 5 minutes - deprecated
export const EXTERNAL_STALE_CHECK_INTERVAL_MS = 30_000;
/** Cooldown after user closes an agent via X. Must be > EXTERNAL_ACTIVE_THRESHOLD_MS
 *  so the file's mtime becomes stale before the dismissal expires. */
export const DISMISSED_COOLDOWN_MS = 180_000; // 3 minutes

// ── Context Window Usage ────────────────────────────────────
/** Window size assumed until a transcript proves otherwise. Transcripts never
 *  state the model's context limit, so this is the floor, not the truth. */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
/** Known window sizes, ascending. The smallest tier that fits the largest
 *  context observed so far wins; beyond the last tier we round up to a whole
 *  multiple of it, so an unknown future window still reads under 100%. */
export const CONTEXT_WINDOW_TIERS = [200_000, 1_000_000] as const;
/** How much of a transcript's tail to read when seeding an agent's context on
 *  adoption or restore. Comfortably more than one turn's worth of records. */
export const CONTEXT_SEED_TAIL_BYTES = 256 * 1024;

// ── Global Session Scanning ─────────────────────────────────
/** Only adopt global JSONL files larger than this (filters out empty/init-only sessions) */
export const GLOBAL_SCAN_ACTIVE_MIN_SIZE = 3_072; // 3KB
/** Only adopt global JSONL files modified within this window */
export const GLOBAL_SCAN_ACTIVE_MAX_AGE_MS = 600_000; // 10 minutes

// ── Directory Suggestions ───────────────────────────────────
/** How much of a session transcript is read to recover the working directory it
 *  records. The cwd sits on the first records, so the head is enough — whole
 *  transcripts run to megabytes and there is one per session on the machine. */
export const DIRECTORY_SUGGESTION_HEAD_BYTES = 8_192;
/** Transcripts tried per session directory before moving on. Every session in
 *  one directory shares a cwd (the directory name encodes it), so the extra
 *  attempts only cover empty or half-written files. */
export const DIRECTORY_SUGGESTION_FILES_PER_SESSION_DIR = 5;
/** Upper bound on suggestions returned, so a long agent history can't flood the
 *  Directory modal on a phone. The newest survive the cut — the list is ordered
 *  by when a session last ran there. */
export const DIRECTORY_SUGGESTION_LIMIT = 10;

// ── Display Truncation + Pixel Agents Server paths ──────────
// Centralized in core/src/constants.ts; re-exported here for back-compat.
export {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  HOOK_API_PREFIX,
  HOOK_SCRIPTS_DIR,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../core/src/constants.js';

// ── Multi-Server Discovery ──────────────────────────────────
/** Subdirectory (under SERVER_JSON_DIR) holding one registry entry per live
 *  server, so a hook event can fan out to every running instance instead of
 *  only the single legacy server.json pointer. See server/src/server.ts. */
export const SERVERS_DIR = 'servers';
/** Valid explicit TCP port range. Port 0 remains an internal-only signal for
 *  OS-assigned ephemeral binding and is never accepted from persisted records
 *  or the CLI's --port option. */
export const MIN_PORT = 1;
export const MAX_PORT = 65_535;
/** Format version stamped on every registry entry (both the per-server records
 *  and the legacy server.json). Bump on breaking field changes; additive
 *  fields (servesSpa, protocol itself) don't require a bump -- readers already
 *  tolerate unknown/missing fields (see ServerConfig.debugLog precedent). */
export const SERVER_REGISTRY_PROTOCOL_VERSION = 1;

// ── WebSocket close codes (application range 4000-4999) ────
/** The handshake's token is missing or wrong: the embedded `/ws` Bearer header,
 *  or the `?token=` query on `/terminal/:agentId` (an untokened standalone `/ws`
 *  still connects, unprivileged -- see wsAuth.ts). */
export const WS_CLOSE_UNAUTHORIZED = 4001;

/** Standalone mode: the handshake's Origin is not this server's own origin, or
 *  its Host is a DNS name off the allowlist (wsAuth.standaloneConnectionHostAllowed).
 *  WebSocket connects bypass CORS, so this is what stands between a drive-by
 *  or DNS-rebound web page and the office feed. */
export const WS_CLOSE_FORBIDDEN_ORIGIN = 4003;
/** Distinct refused Host names logged per process (each name once). */
export const REFUSED_HOST_LOG_MAX = 32;
/** Terminal socket: the agent has no PTY on this server (never spawned, or
 *  already exited). The route only ever attaches; it cannot start one. */
export const WS_CLOSE_NO_SESSION = 4004;

export const HOOK_EVENT_BUFFER_MS = 5_000;
/** Grace period after SessionEnd(reason=clear/resume) before triggering onSessionEnd.
 *  /clear and /resume fire SessionEnd then SessionStart within ms. This timeout is a
 *  safety net: if SessionStart never arrives (e.g. the CLI crashes mid-transition),
 *  the agent is cleaned up instead of staying as a zombie with pendingClear forever. */
export const SESSION_END_GRACE_MS = 2000;
export const MAX_HOOK_BODY_SIZE = 65_536; // 64KB

// ── Standalone Embedded Terminal ────────────────────────────
/** PTY module ids tried in order by the loader. @lydell/node-pty ships prebuilt
 *  binaries for all six platform/arch targets as optionalDependencies with no
 *  install scripts; official node-pty has no Linux prebuild and relies on
 *  install scripts that npm >=11.16 gates by default. Keeping a candidate LIST
 *  means anyone who prefers the Microsoft package can just install it.
 *  See docs/design/standalone-terminal.md. */
export const PTY_MODULE_CANDIDATES = ['@lydell/node-pty', 'node-pty'] as const;
/** Loopback hostnames. Used to warn when the server binds off-loopback, and
 *  always part of the privileged-Host allowlist (wsAuth.privilegedHostnames). */
export const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '::1'] as const;
/** Wildcard bind addresses: listen targets, never a name a browser sends as
 *  Host, so binding to one adds nothing to the privileged-Host allowlist. */
export const WILDCARD_HOSTNAMES = ['0.0.0.0', '::'] as const;

/** Scrollback lines the per-session headless-xterm mirror retains. Matches the
 *  browser's TERMINAL_SCROLLBACK_LINES so a reattach replays the same depth the
 *  client would have kept. Bounds the serialized replay snapshot. */
export const TERMINAL_MIRROR_SCROLLBACK_LINES = 5_000;
/** Terminal size used until the browser reports its real geometry. */
export const TERMINAL_DEFAULT_COLS = 80;
export const TERMINAL_DEFAULT_ROWS = 24;
/** TERM value exported into the PTY. */
export const TERMINAL_TERM_NAME = 'xterm-256color';
/** Grace period between SIGHUP and SIGKILL when disposing a PTY. */
export const TERMINAL_KILL_GRACE_MS = 2_000;
/** How long shutdown waits past the SIGKILL escalation for the exits to land. */
export const TERMINAL_SHUTDOWN_SLACK_MS = 1_000;
/** unavailableReason() when the operator opted out with --no-terminal. Shown
 *  verbatim as the disabled + Agent button's tooltip in the browser. */
export const TERMINAL_DISABLED_BY_FLAG_REASON = 'Terminal disabled with --no-terminal.';
/** terminalAvailability reason for an UNPRIVILEGED /ws client (no valid token,
 *  or a Host outside the allowlist): the PTY may work, but this connection may
 *  not open one. Launching an agent starts a shell as the operator, so it is
 *  gated exactly like the hooks toggle (wsAuth.standaloneHandshakeVerdict). */
export const TERMINAL_REQUIRES_TOKEN_REASON =
  'Open the URL the CLI printed (with its ?token=), at localhost or a name passed with --allowed-host, to launch agents from this browser.';
/** directoryRejected reason when the shared config write behind a Directory
 *  save or delete failed. The detail (permissions, disk full, ...) is on the
 *  host's console, where writeConfig logged it. */
export const DIRECTORY_WRITE_FAILED_REASON =
  "Couldn't save the change: writing ~/.pixel-agents/config.json failed (see the host's log).";
/** Standalone persists its server token here (mode 0600, beside server.json) so
 *  the tokened URL a browser bookmarked keeps working across restarts. The
 *  embedded (VS Code) server still mints a fresh token per process. */
export const STANDALONE_TOKEN_FILE_NAME = 'standalone-token';

/** unavailableReason() when Claude Code tracking is off (the default; --claude
 *  turns it on). The embedded terminal only ever launches Claude Code, so a
 *  Conductor-only office has nothing to run in it. */
export const TERMINAL_DISABLED_NO_CLAUDE_REASON =
  'Terminal needs Claude Code tracking. Restart with --claude to launch agents from the browser.';

// ── Standalone CLI ──────────────────────────────────────────
/** Port tried first when --port is not given. A fixed port keeps the office's
 *  origin stable across restarts (installed PWA, app-window bounds,
 *  localStorage). Busy -> the CLI falls back to an OS-assigned port. */
export const DEFAULT_STANDALONE_PORT = 41510;
/** Bounds for --conductor-budget (Conductor API requests per minute). */
export const CONDUCTOR_BUDGET_MIN = 1;
export const CONDUCTOR_BUDGET_MAX = 6_000;
/** How long `open` / `xdg-open` may take before the attempt counts as failed. */
export const OPEN_COMMAND_TIMEOUT_MS = 10_000;
/** `--open` launch codes (launchCodes.ts): random bytes per code, how long an
 *  unused one stays valid (a cold browser start included), and how many may
 *  wait at once. */
export const LAUNCH_CODE_BYTES = 24;
export const LAUNCH_CODE_TTL_MS = 120_000;
export const LAUNCH_CODE_MAX = 8;
/** Routes: the CLI mints a code (Bearer token), the window redeems it. */
export const LAUNCH_CODE_API_PATH = '/api/launch-code';
export const LAUNCH_PATH_PREFIX = '/launch';
/** How long the CLI waits for the server to mint a launch code. */
export const LAUNCH_CODE_REQUEST_TIMEOUT_MS = 5_000;

// ── Stream providers (Conductor) ────────────────────────────
/** The agentLinks snapshot is broadcast at most this often (debounced). */
export const STREAM_SNAPSHOT_DEBOUNCE_MS = 500;
/** agentMessage animations: at most one per sender/receiver pair in this window... */
export const AGENT_MESSAGE_PAIR_INTERVAL_MS = 2_000;
/** ...and at most this many per second across the whole office. */
export const AGENT_MESSAGE_MAX_PER_SECOND = 6;
/** Error messages shown on an errored (fainted) agent are cut to this length. */
export const AGENT_ERROR_MESSAGE_MAX_LENGTH = 200;
/** Notices and link previews are cut to this length. */
export const STREAM_TEXT_MAX_LENGTH = 200;
/** Links kept in memory; the oldest (by last message) go first past this. */
export const STREAM_LINKS_MAX = 500;
/** Remembered stream sessions (agent id + Pokémon) in <namespace>-state.json;
 *  the oldest entries go first past this. */
export const STREAM_AGENT_MEMORY_MAX = 1_000;
/** A stream agent that went active is shown working at least this long: a
 *  turn that started and ended within one poll would otherwise flash by
 *  unseen (its turn end is broadcast once this has passed). */
export const STREAM_TURN_MIN_ACTIVE_MS = 2_500;
/** An evolved (or promoted) species is announced once its sprites load, or
 *  after this long, whichever comes first (the office keeps the old one meanwhile). */
export const STREAM_SPECIES_LOAD_TIMEOUT_MS = 15_000;
/** Upper bounds a setConductorScope request may ask for (a year of activity,
 *  and more characters than any office can seat). */
export const CONDUCTOR_SCOPE_MAX_HOURS = 24 * 365;
export const CONDUCTOR_SCOPE_MAX_SESSIONS = 500;
/** Longest message the office may send to a session. */
export const SESSION_MESSAGE_MAX_LENGTH = 32_000;
/** Switch model: the new session's name ("<original name> · <model>") is cut
 *  to this length, the original name giving way first. */
export const CONTINUE_SESSION_NAME_MAX_LENGTH = 120;
/** Switch model: favorite models kept from Conductor's list. */
export const MODEL_FAVORITES_MAX = 24;
/** Longest id, effort or agent value a continueWithModel request may carry
 *  before it is even looked up in the catalog. */
export const MODEL_CHOICE_FIELD_MAX_LENGTH = 64;
/** Longest deep link openExternal accepts. */
export const EXTERNAL_URL_MAX_LENGTH = 2_048;
/** Deep-link schemes openExternal opens on the host (conductor:, conductor-dev:, ...). */
export const EXTERNAL_URL_SCHEME_PATTERN = /^conductor(-[a-z0-9-]+)?:$/;
/** The only host a deep link may name (conductor://workspace?id=...&session=...). */
export const EXTERNAL_URL_HOST = 'workspace';

// ── Layout/Config Persistence ──────────────────────────────
export const LAYOUT_FILE_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = 'layoutRevision';
/** The Pokémon Town, under `assets/`: the standalone office's layout until the
 *  user saves one (VS Code keeps the classic default-layout-N.json). */
export const TOWN_LAYOUT_FILE = 'layouts/pokemon-town.json';
export const CONFIG_FILE_NAME = 'config.json';

// ── Avatar Customization ────────────────────────────────────
/** Number of pre-colored bundled character palettes (char_0.png–char_5.png).
 *  Mirrors `PALETTE_COUNT` in webview-ui/src/constants.ts; kept separate
 *  because the server has no DOM/sprite access and cannot import the webview
 *  constant. The two values must stay in sync. */
export const PALETTE_COUNT = 6;
/** Inclusive upper bound for a valid agent hue shift, in degrees. Used by
 *  clientMessageHandler to guard saveAgentSeats payloads from a remote or
 *  hand-edited source corrupting the stored values with out-of-range values. */
export const HUE_SHIFT_MAX_DEG = 360;
