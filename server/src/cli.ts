#!/usr/bin/env node

/**
 * Standalone CLI entry point: `poke-agents`
 *
 * Parses the flags and starts the standalone office (standalone.ts, shared
 * with the desktop app): Fastify with SPA serving and WebSocket, assets loaded
 * once at startup, the full state sent to each client on webviewReady. Then
 * prints the tokened URL and, with --open, opens it in an app window.
 *
 * Providers: Conductor cloud sessions are tracked by default (--no-conductor
 * turns it off); Claude Code tracking -- hooks, transcript scanners and the
 * embedded terminal -- is opt-in with --claude. --demo replaces Conductor
 * with a scripted story of synthetic sessions.
 */

import {
  CONDUCTOR_BUDGET_MAX,
  CONDUCTOR_BUDGET_MIN,
  DEFAULT_STANDALONE_PORT,
  MAX_PORT,
  MIN_PORT,
  WILDCARD_HOSTNAMES,
} from './constants.js';
import { MusicService } from './music/musicService.js';
import {
  BROWSER_IDS,
  type BrowserId,
  isBrowserId,
  openAppWindow,
  requestLaunchUrl,
} from './openAppWindow.js';
import {
  DEMO_SEED_MAX,
  DEMO_SPEED_MAX,
  DEMO_SPEED_MIN,
} from './providers/stream/demo/constants.js';
import { type StandaloneOffice, startStandalone } from './standalone.js';
import { normalizeHostname } from './wsAuth.js';

export { startOnPreferredPort } from './standalone.js';

// ── Argument parsing ──────────────────────────────────────────

export interface CliArgs {
  /** Unset -> DEFAULT_STANDALONE_PORT, falling back to an OS-assigned port when
   *  it is busy (see startOnPreferredPort). --port picks a fixed one, no fallback. */
  port?: number;
  host: string;
  /** False when --no-terminal was passed: the office only watches agents; the
   *  browser can neither launch them nor attach to their terminals. */
  terminal: boolean;
  /** --allowed-host names (repeatable): extra Host names, beyond loopback and a
   *  specific --host, that a browser may connect under (any other DNS name is
   *  refused) and a tokened session is privileged under -- typically a reverse
   *  proxy's public name. See wsAuth.privilegedHostnames and
   *  wsAuth.standaloneConnectionHostAllowed. */
  allowedHosts: string[];
  /** --rotate-token: replace the persisted server token before starting. */
  rotateToken: boolean;
  /** Track Conductor cloud sessions. On by default; --no-conductor turns it off. */
  conductor: boolean;
  /** Track local Claude Code sessions (hooks, scanners, embedded terminal).
   *  Off by default; --claude turns it on. */
  claude: boolean;
  /** --open / --app: open the office in an app window once it is running. */
  open: boolean;
  /** --browser <id>: which browser --open uses (default: the first installed). */
  browser?: BrowserId;
  /** --conductor-budget <n>: Conductor API requests per minute (provider default otherwise). */
  conductorBudget?: number;
  /** False with --no-sprites: never download Pokémon sprites. */
  sprites: boolean;
  /** False with --no-sounds: never download cries or serve the sound pack. */
  sounds: boolean;
  /** --demo: play synthetic sessions instead of connecting to Conductor.
   *  --demo-seed / --demo-speed imply it. */
  demo: boolean;
  /** --demo-seed <n>: varies the demo's generated history and later rounds. */
  demoSeed?: number;
  /** --demo-speed <x>: demo script speed factor. */
  demoSpeed?: number;
}

/** Thrown by parseArgs on an invalid --port. Kept separate from process.exit so
 *  the parsing logic stays a pure, unit-testable function -- main() is the only
 *  place that turns a bad argument into an exit code. */
export class CliArgsError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    host: '127.0.0.1',
    terminal: true,
    allowedHosts: [],
    rotateToken: false,
    conductor: true,
    claude: false,
    open: false,
    sprites: true,
    sounds: true,
    demo: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') {
      const raw = argv[i + 1];
      if (raw === undefined) {
        throw new CliArgsError(
          `Missing value for ${argv[i]}: expected an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
        throw new CliArgsError(
          `Invalid --port "${raw}": must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      args.port = parsed;
      i++;
    } else if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[i + 1];
      i++;
    } else if (argv[i] === '--allowed-host') {
      const raw = argv[i + 1];
      const name = normalizeHostname(raw);
      if (name === null || (WILDCARD_HOSTNAMES as readonly string[]).includes(name)) {
        throw new CliArgsError(
          raw === undefined
            ? 'Missing value for --allowed-host: expected a host name, e.g. my-mac.tailnet.ts.net.'
            : `Invalid --allowed-host "${raw}": expected a host name, e.g. my-mac.tailnet.ts.net.`,
        );
      }
      args.allowedHosts.push(raw as string);
      i++;
    } else if (argv[i] === '--rotate-token') {
      args.rotateToken = true;
    } else if (argv[i] === '--no-terminal') {
      args.terminal = false;
    } else if (argv[i] === '--conductor') {
      args.conductor = true;
    } else if (argv[i] === '--no-conductor') {
      args.conductor = false;
    } else if (argv[i] === '--claude') {
      args.claude = true;
    } else if (argv[i] === '--no-claude') {
      args.claude = false;
    } else if (argv[i] === '--open' || argv[i] === '--app') {
      args.open = true;
    } else if (argv[i] === '--browser') {
      const raw = argv[i + 1];
      if (raw === undefined || !isBrowserId(raw)) {
        throw new CliArgsError(
          `${raw === undefined ? 'Missing value for --browser' : `Invalid --browser "${raw}"`}: expected one of ${BROWSER_IDS.join(', ')}.`,
        );
      }
      args.browser = raw;
      i++;
    } else if (argv[i] === '--conductor-budget') {
      const raw = argv[i + 1];
      const parsed = Number(raw);
      if (
        raw === undefined ||
        !Number.isInteger(parsed) ||
        parsed < CONDUCTOR_BUDGET_MIN ||
        parsed > CONDUCTOR_BUDGET_MAX
      ) {
        throw new CliArgsError(
          `${raw === undefined ? 'Missing value for --conductor-budget' : `Invalid --conductor-budget "${raw}"`}: expected requests per minute, an integer between ${CONDUCTOR_BUDGET_MIN} and ${CONDUCTOR_BUDGET_MAX}.`,
        );
      }
      args.conductorBudget = parsed;
      i++;
    } else if (argv[i] === '--no-sprites') {
      args.sprites = false;
    } else if (argv[i] === '--no-sounds') {
      args.sounds = false;
    } else if (argv[i] === '--demo') {
      args.demo = true;
    } else if (argv[i] === '--demo-seed') {
      const raw = argv[i + 1];
      const parsed = Number(raw);
      if (raw === undefined || !Number.isInteger(parsed) || parsed < 0 || parsed > DEMO_SEED_MAX) {
        throw new CliArgsError(
          `${raw === undefined ? 'Missing value for --demo-seed' : `Invalid --demo-seed "${raw}"`}: expected an integer between 0 and ${DEMO_SEED_MAX}.`,
        );
      }
      args.demo = true;
      args.demoSeed = parsed;
      i++;
    } else if (argv[i] === '--demo-speed') {
      const raw = argv[i + 1];
      const parsed = Number(raw);
      if (
        raw === undefined ||
        raw.trim() === '' ||
        !Number.isFinite(parsed) ||
        parsed < DEMO_SPEED_MIN ||
        parsed > DEMO_SPEED_MAX
      ) {
        throw new CliArgsError(
          `${raw === undefined ? 'Missing value for --demo-speed' : `Invalid --demo-speed "${raw}"`}: expected a speed factor between ${DEMO_SPEED_MIN} and ${DEMO_SPEED_MAX}.`,
        );
      }
      args.demo = true;
      args.demoSpeed = parsed;
      i++;
    } else if (argv[i] === '--help') {
      console.log(`Usage: poke-agents [options]

Options:
  --port, -p <number>   Port to listen on (default: ${DEFAULT_STANDALONE_PORT}, or an
                        OS-assigned port when that one is busy)
  --host <string>       Host to bind to (default: 127.0.0.1)
  --allowed-host <name> Also accept this host name, e.g. a reverse proxy's
                        (Tailscale Serve), for viewing and for the tokened
                        URL. Repeatable. Other names are refused (DNS-rebinding
                        defence); IP addresses may watch, and only localhost
                        and a specific --host may make changes
  --rotate-token        Replace the server token. Every URL that carried the
                        old one (bookmarks, other devices) stops working
  --open, --app         Open the office in an app window (Chromium browsers;
                        otherwise the default browser)
  --browser <id>        Browser for --open: ${BROWSER_IDS.join(', ')}
  --no-conductor        Don't track Conductor cloud sessions
  --conductor-budget <n>
                        Conductor API requests per minute (default: 120)
  --claude              Also track local Claude Code sessions (hooks, terminal,
                        + Agent)
  --no-terminal         With --claude: disable the embedded terminal (watch
                        agents only; no launching or attaching from the browser)
  --no-sprites          Never download Pokémon sprites (also
                        POKE_AGENTS_SPRITES=off)
  --no-sounds           Never download Pokémon cries or serve a sound pack
                        (also POKE_AGENTS_SOUNDS=off)
  --demo                Play a scripted demo with synthetic sessions instead of
                        connecting to Conductor (no account needed)
  --demo-seed <n>       Vary the demo's generated history and later rounds
                        (the first round is always the same)
  --demo-speed <x>      Demo speed factor, ${DEMO_SPEED_MIN} to ${DEMO_SPEED_MAX} (default: 1; also
                        POKE_AGENTS_DEMO_SPEED)
  --help                Show this help message`);
      process.exit(0);
    }
  }
  if (args.demo && args.claude) {
    throw new CliArgsError(
      '--demo shows synthetic sessions only and cannot be combined with --claude.',
    );
  }
  return args;
}

// ── Main ──────────────────────────────────────────────────────

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[Pixel Agents] ${errorText(err)}`);
    process.exit(1);
  }

  if (!args.claude && !args.conductor && !args.demo) {
    console.warn(
      '[Pixel Agents] Both Conductor and Claude Code tracking are off: the office will stay empty. Drop --no-conductor or add --claude.',
    );
  }

  // dist/ contains both the CLI bundle and the assets/ + webview/ directories
  let office: StandaloneOffice;
  try {
    office = await startStandalone({
      distRoot: __dirname,
      port: args.port,
      host: args.host,
      terminal: args.terminal,
      allowedHosts: args.allowedHosts,
      rotateToken: args.rotateToken,
      conductor: args.conductor && !args.demo,
      claude: args.claude,
      conductorBudget: args.conductorBudget,
      sprites: args.sprites,
      sounds: args.sounds,
      // The Jukebox: ~/.pixel-agents/music, plus Music/Spotify on macOS.
      music: new MusicService(),
      ...(args.demo ? { demo: { seed: args.demoSeed, speed: args.demoSpeed } } : {}),
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }

  if (args.rotateToken) {
    console.log(
      '[Pixel Agents] Server token rotated: URLs carrying the old token no longer grant access. Open the new URL below on each device.',
    );
  }

  // The printed URL carries the token, which is what makes the session it
  // loads privileged enough to approve a hook install or act on a session.
  console.log(`\n  Poke Agents running at ${office.url}\n`);

  // --open also runs against a reused server: it just opens another window
  // onto the running office. The window gets a one-time launch URL, never
  // the token itself (a browser's argv is readable by other local users).
  if (args.open) {
    requestLaunchUrl(office.baseUrl, office.token)
      .then((launchUrl) => openAppWindow(launchUrl, { browser: args.browser }))
      .then((via) => console.log(`[Pixel Agents] Opened the office in ${via}`))
      .catch((err: unknown) =>
        console.warn(
          `[Pixel Agents] Could not open a window (${errorText(err)}). Open the URL above.`,
        ),
      );
  }

  // ── Graceful shutdown ──
  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    await office.stop();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// Only auto-run when this file is executed directly (`node dist/cli.js`), not
// when it's imported for its exports (e.g. `parseArgs` in tests) -- importing
// it unconditionally used to start a real server and install real Claude
// hooks as a side effect of module load.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
