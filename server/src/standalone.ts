/**
 * The standalone office as one start function: assets, store, runtime, the
 * HTTP/WS server (or a compatible one already running), Conductor polling and,
 * with Claude Code tracking, hooks and scanners.
 *
 * Two surfaces call it: the `poke-agents` CLI (cli.ts), which prints the URL
 * and maybe opens a browser window, and the desktop app's main process
 * (desktop/), which loads the URL in its own window. Everything the office
 * does is decided here, so the two never drift.
 */

import * as os from 'os';
import * as path from 'path';

import type { StreamProvider } from '../../core/src/provider.js';
import { AgentRuntime } from './agentRuntime.js';
import { AgentStateStore } from './agentStateStore.js';
import {
  buildAssetCache,
  loadAllCharacters,
  loadAllFurniture,
  loadAllPets,
} from './assetReload.js';
import { setSoundsEnabled } from './audio/sounds.js';
import type {
  AssetCache,
  OpenExternalSideEffect,
  ReloadAssetsSideEffect,
} from './clientMessageHandler.js';
import {
  getHooksConsent,
  getHooksEnabled,
  grantHooksConsent,
  readConfig,
} from './configPersistence.js';
import {
  DEFAULT_STANDALONE_PORT,
  SERVER_JSON_DIR,
  TERMINAL_DISABLED_BY_FLAG_REASON,
  TERMINAL_DISABLED_NO_CLAUDE_REASON,
} from './constants.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { openWithSystem } from './openAppWindow.js';
import { setEvolutionPreloader } from './pokemon/agentLevel.js';
import { ensureSpeciesLoaded, setPokemonSpritesEnabled } from './pokemon/pokemonAssets.js';
import { claudeProvider, copyHookScript, hookProviderById } from './providers/index.js';
import { createConductorProvider } from './providers/stream/conductor/conductor.js';
import { acquirePollerLock, type PollerLock } from './providers/stream/conductor/pollerLock.js';
import {
  DEMO_OPEN_EXTERNAL_REFUSAL,
  DEMO_STATE_FILE_STEM,
} from './providers/stream/demo/constants.js';
import { createDemoProvider } from './providers/stream/demo/demo.js';
import { PixelAgentsServer, type ServerConfig } from './server.js';
import { PtySessionManager } from './terminal/ptySessionManager.js';
import { isLoopbackHost } from './wsAuth.js';

export interface StandaloneOptions {
  /** Directory holding the built `assets/` and `webview/` (the CLI's dist/). */
  distRoot: string;
  /** Root holding `dist/hooks/claude-hook.js`, copied when Claude hooks are
   *  installed. Defaults to distRoot's parent (the package root). */
  packageRoot?: string;
  /** Fixed port, never replaced. Unset: DEFAULT_STANDALONE_PORT, or an
   *  OS-assigned port when that one is busy (startOnPreferredPort). */
  port?: number;
  /** Bind address. Default 127.0.0.1. */
  host?: string;
  /** With `claude`: the embedded terminal (default on). Without `claude` there
   *  is never a terminal: it only ever runs Claude Code. */
  terminal?: boolean;
  /** Extra privileged Host names (see wsAuth.privilegedHostnames). */
  allowedHosts?: readonly string[];
  /** Replace the persisted server token before starting. */
  rotateToken?: boolean;
  /** Track Conductor cloud sessions. */
  conductor: boolean;
  /** Track local Claude Code sessions (hooks, scanners, embedded terminal). */
  claude: boolean;
  /** Conductor API requests per minute (provider default otherwise). */
  conductorBudget?: number;
  /** False: never download Pokémon sprites. POKE_AGENTS_SPRITES=off does the same. */
  sprites?: boolean;
  /** False: never download Pokémon cries or serve the sound pack.
   *  POKE_AGENTS_SOUNDS=off does the same. */
  sounds?: boolean;
  /** Opens a validated Conductor deep link on the host. Default: the system opener. */
  openExternal?: OpenExternalSideEffect;
  /** Directory whose Claude Code sessions are scanned. Default: process.cwd(). */
  cwd?: string;
  /** Play the scripted demo (synthetic sessions) instead of connecting to
   *  Conductor: `poke-agents --demo`. Implies no Conductor; its seats and
   *  agents persist apart from the real office's (`demo-state.json`). */
  demo?: { seed?: number; speed?: number };
}

/** A running office, owned by this process or reused from another one. */
export interface StandaloneOffice {
  /** The tokened URL to open: a reachable host (never a wildcard bind address). */
  url: string;
  /** `url` without the token (`http://host:port`): the base for a one-time
   *  launch URL (openAppWindow.requestLaunchUrl). */
  baseUrl: string;
  /** Host and port of `url`. */
  host: string;
  port: number;
  /** The server token. `url` carries it; never log either. */
  token: string;
  /** False when a compatible server another process runs was reused. */
  ownsServer: boolean;
  /** PID of the process serving the office. */
  pid: number;
  /** This process's store. Its events are the office's only when ownsServer. */
  store: AgentStateStore;
  /** The last conductorStatus message this process's Conductor poller sent,
   *  or null (none yet, Conductor off, the server is reused, or another
   *  office holds the Conductor lock). For a listener that subscribes to
   *  `store` after the start. */
  conductorStatus(): Record<string, unknown> | null;
  /** Stop polling, terminals, the runtime and the server (when owned). Idempotent. */
  stop(): Promise<void>;
}

// ── Hooks consent ─────────────────────────────────────────────
// First-run consent is asked IN THE APP, not here: the server sends a
// hooksConsentRequest to privileged (tokened) connections during the
// webviewReady handshake (clientMessageHandler.ts), and the browser renders
// the dialog — the same UX the VS Code webview shows. Startup itself never
// prompts; a headless run just starts without hooks until consent is granted
// through the UI. The one exception that needs no dialog is the silent-grant
// migration below (our hooks already installed by a pre-consent version).

/**
 * Copy the bundled hook script into ~/.pixel-agents/hooks/, reporting failure.
 *
 * Callers run this BEFORE installing the settings.json entries and abort when
 * it returns false: an entry whose command points at a missing script makes
 * Claude Code spawn a dead `node` process for every event, which is strictly
 * worse than no hooks at all.
 */
function copyHookScriptOrReport(packageRoot: string, context = ''): boolean {
  if (copyHookScript(packageRoot)) return true;
  console.error(`[Pixel Agents] Hooks NOT installed${context}: hook script missing.`);
  return false;
}

// ── Terminal status reporting ─────────────────────────────────

/**
 * Log one clear line about terminal availability, plus a security warning when
 * a working terminal is bound to a non-loopback address.
 *
 * The reason string matters: the most likely failure (npm >=11.16 gating
 * node-pty's install scripts, so it imports but can't spawn) is invisible
 * otherwise -- the user would just see a + Agent button that does nothing.
 *
 * Opting out with --no-terminal is not a failure, so it gets a quiet
 * confirmation instead of the reinstall hint, and skips the non-loopback shell
 * warning (there is no shell surface to warn about).
 */
function reportTerminalStatus(
  ptyManager: PtySessionManager,
  host: string,
  enabledByFlag: boolean,
): void {
  if (!enabledByFlag) {
    console.log(
      '[Pixel Agents] Terminal disabled (--no-terminal): agents can be watched but not launched from the browser.',
    );
    return;
  }

  if (!ptyManager.isAvailable()) {
    console.warn(
      `[Pixel Agents] Terminal disabled: ${ptyManager.unavailableReason()}\n` +
        `[Pixel Agents] The office still works; you just can't launch agents from the browser.\n` +
        `[Pixel Agents] To enable it, reinstall so the optional PTY module is present.`,
    );
    return;
  }

  console.log(`[Pixel Agents] Terminal enabled (via ${ptyManager.moduleId()})`);

  if (!isLoopbackHost(host)) {
    console.warn(
      `[Pixel Agents] WARNING: bound to ${host}, not loopback. The terminal is a shell:\n` +
        `[Pixel Agents] anyone who can reach this port AND has the auth token can run commands\n` +
        `[Pixel Agents] as you, and plain HTTP sends that token unencrypted. Behind a reverse\n` +
        `[Pixel Agents] proxy (e.g. Tailscale Serve), keep --host 127.0.0.1 and pass the proxy's\n` +
        `[Pixel Agents] name with --allowed-host instead.`,
    );
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Port choice ───────────────────────────────────────────────

/** Why a listen failed, when the OS said the port is taken. */
function isAddressInUse(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'EADDRINUSE';
}

/**
 * Start on the explicit --port, or on DEFAULT_STANDALONE_PORT with one retry
 * on an OS-assigned port when that is busy. An explicit port never falls
 * back: the operator asked for that one.
 */
export async function startOnPreferredPort<T>(
  start: (port: number | undefined) => Promise<T>,
  explicitPort: number | undefined,
  log: (message: string) => void = console.log,
): Promise<T> {
  if (explicitPort !== undefined) return start(explicitPort);
  try {
    return await start(DEFAULT_STANDALONE_PORT);
  } catch (err) {
    if (!isAddressInUse(err)) throw err;
    log(
      `[Pixel Agents] Port ${DEFAULT_STANDALONE_PORT} is busy; using another one (pass --port to choose).`,
    );
    return start(undefined);
  }
}

/** The machine-wide Conductor poller lock (`~/.pixel-agents/conductor.lock`).
 *  An unwritable data directory must not keep Conductor off, so a failure to
 *  take it counts as acquired. */
function acquireConductorLock(port: number): PollerLock {
  try {
    return acquirePollerLock({ dir: path.join(os.homedir(), SERVER_JSON_DIR), port });
  } catch (err) {
    console.warn(`[Pixel Agents] Could not take the Conductor lock: ${errorText(err)}`);
    return { acquired: true, release: () => undefined };
  }
}

/** The host to put in the office URL: a wildcard bind address is a bind
 *  target, not an address you can browse to (`--host 0.0.0.0` used to print a
 *  dead `http://0.0.0.0:PORT`). Under a wildcard the office stays readable from
 *  the LAN at this machine's own address; only privileged actions need the
 *  token the URL carries. */
export function displayHostFor(host: string): string {
  return host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host;
}

// ── Start ─────────────────────────────────────────────────────

/**
 * Start the standalone office, or attach to a compatible one already running
 * (same capability and access, see sameStandaloneAccess). Rejects only when
 * no server could be started; a Conductor failure never takes the office down.
 */
export async function startStandalone(opts: StandaloneOptions): Promise<StandaloneOffice> {
  const host = opts.host ?? '127.0.0.1';
  const terminal = opts.terminal ?? true;
  const distRoot = opts.distRoot;
  const packageRoot = opts.packageRoot ?? path.dirname(distRoot);
  const staticDir = path.join(distRoot, 'webview');

  if (opts.sprites === false || process.env.POKE_AGENTS_SPRITES === 'off') {
    setPokemonSpritesEnabled(false);
  }
  if (opts.sounds === false || process.env.POKE_AGENTS_SOUNDS === 'off') {
    setSoundsEnabled(false);
  }

  // ── Load assets on startup (same pipeline as VS Code extension) ──
  // External asset directories are merged at startup too, so directories added
  // in a previous session survive a restart. buildAssetCache is the shared
  // loader used by both the standalone server and the VS Code adapter.
  console.log('[Pixel Agents] Loading assets...');
  const assetCache: AssetCache = await buildAssetCache(
    distRoot,
    readConfig().externalAssetDirectories,
  );
  const charCount = assetCache.characters?.characters.length ?? 0;
  const petCount = assetCache.pets?.pets.length ?? 0;
  const furnitureCount = assetCache.furniture?.catalog.length ?? 0;
  console.log(
    `[Pixel Agents] Assets loaded: ${charCount} characters, ${petCount} pets, ${furnitureCount} furniture items`,
  );

  // ── Store + adapter (shared settings + standalone-scoped agents/seats) ──
  // The demo keeps its seats and agents apart, so it never moves the real
  // office's characters or leaves synthetic sessions in its memory.
  const demo = opts.demo;
  const conductorOn = opts.conductor && !demo;
  const store = new AgentStateStore();
  const adapter = demo
    ? new FileStateAdapter({ namespace: 'standalone', stateFileStem: DEMO_STATE_FILE_STEM })
    : new FileStateAdapter({ namespace: 'standalone' });
  store.setAdapter(adapter);
  // A Claude agent's evolution waits for its new species' sprites (as the
  // stream driver's does), so the office plays the flash.
  setEvolutionPreloader((dex, shiny) => ensureSpeciesLoaded(dex, shiny, store));

  const server = new PixelAgentsServer();

  // Terminals for agents this server launches. Construction is cheap -- the
  // native module is resolved (and probed) lazily on first use, so a user who
  // never opens a terminal never pays for it. With --no-terminal, a disabled
  // manager reports "unavailable" through the same plumbing (availability
  // broadcast, session route, launcher), so nothing downstream special-cases it.
  // The terminal only ever runs Claude Code, so it is off without --claude.
  const ptyManager = !opts.claude
    ? PtySessionManager.disabled(TERMINAL_DISABLED_NO_CLAUDE_REASON)
    : terminal
      ? new PtySessionManager()
      : PtySessionManager.disabled(TERMINAL_DISABLED_BY_FLAG_REASON);

  // Create runtime first (before server.start, so we can pass it in)
  const runtime = new AgentRuntime(store, claudeProvider);

  // Wire hook events: HTTP POST -> runtime -> hookEventHandler -> agents.
  // Without --claude, hooks a previous run installed are ignored.
  if (opts.claude) {
    server.onHookEvent((providerId, event) => {
      runtime.handleHookEvent(providerId, event);
    });
  }

  // onSetHooksEnabled side effect: install/uninstall the named provider's
  // hooks when the user toggles in the UI (or answers the consent ask).
  // Captures config from the outer scope after server.start().
  let currentConfig: { port: number; token: string } | null = null;
  const onSetHooksEnabled = async (providerId: string, enabled: boolean): Promise<void> => {
    if (!currentConfig || !opts.claude) return;
    const provider = hookProviderById(providerId);
    if (!provider) return; // unknown id: nothing to install into
    if (enabled) {
      // An explicit toggle in the UI IS the consent to modify the
      // provider's settings file. The bundled claude-hook.js script belongs
      // to the Claude provider alone; another provider's install must
      // neither copy it nor be blocked by it.
      grantHooksConsent(provider.id);
      if (
        provider.id === claudeProvider.id &&
        !copyHookScriptOrReport(packageRoot, ' (user toggle)')
      ) {
        return;
      }
      try {
        await provider.installHooks(`http://127.0.0.1:${currentConfig.port}`, currentConfig.token);
      } catch (err) {
        console.error(`[Pixel Agents] ${errorText(err)}`);
        return;
      }
      console.log('[Pixel Agents] Hooks installed (user toggle)');
    } else {
      try {
        await provider.uninstallHooks();
        console.log('[Pixel Agents] Hooks uninstalled (user toggle)');
      } catch (err) {
        console.error(`[Pixel Agents] ${errorText(err)}`);
      }
    }
  };

  // onReloadAssets side effect: re-run the shared loaders (bundled + external
  // dirs) after an external-asset-directory change, then re-broadcast the
  // updated sprites to the requesting client. Mutates the assetCache object in
  // place so already-open sockets (which captured the same reference) and
  // future webviewReady handshakes both observe the new assets. Only
  // characters/pets/furniture can come from external dirs, so only those three
  // are reloaded and re-sent (mirrors the VS Code reload path).
  const onReloadAssets: ReloadAssetsSideEffect = async (send): Promise<void> => {
    const externalDirs = readConfig().externalAssetDirectories;
    const [characters, pets, furniture] = await Promise.all([
      loadAllCharacters(distRoot, externalDirs),
      loadAllPets(distRoot, externalDirs),
      loadAllFurniture(distRoot, externalDirs),
    ]);
    assetCache.characters = characters;
    assetCache.pets = pets;
    assetCache.furniture = furniture;
    if (characters) {
      send({ type: 'characterSpritesLoaded', characters: characters.characters });
    }
    if (pets) {
      send({
        type: 'petSpritesLoaded',
        pets: pets.pets,
        petNames: pets.manifests.map((m) => m.name),
      });
    }
    if (furniture) {
      send({
        type: 'furnitureAssetsLoaded',
        catalog: furniture.catalog,
        sprites: Object.fromEntries(furniture.sprites),
      });
    }
    console.log('[Pixel Agents] Assets reloaded (external directory change)');
  };

  let config: ServerConfig;
  try {
    config = await startOnPreferredPort(
      (port) =>
        server.start({
          store,
          runtime,
          embedded: false,
          host,
          port,
          staticDir,
          assetCache,
          onSetHooksEnabled,
          onReloadAssets,
          ptyManager,
          allowedHosts: opts.allowedHosts ?? [],
          rotateToken: opts.rotateToken ?? false,
          claude: opts.claude,
          conductor: conductorOn,
          demo: demo !== undefined,
          // Demo sessions exist nowhere else: "Open in Conductor" says so.
          openExternal: demo
            ? () => Promise.reject(new Error(DEMO_OPEN_EXTERNAL_REFUSAL))
            : (opts.openExternal ?? ((url) => openWithSystem(url))),
        }),
      opts.port,
    );
  } catch (err) {
    runtime.dispose();
    throw err;
  }
  currentConfig = { port: config.port, token: config.token };
  const ownsServer = server.isOwner();

  // ── Conductor: poll only from the process that owns the server (a reused
  // server already runs its own poller). Started without awaiting, so the
  // office URL is ready at once and sessions stream in as they are found.
  // A Conductor failure never takes the office down with it.
  let conductor: StreamProvider | null = null;
  let conductorLock: PollerLock | null = null;
  if (demo && ownsServer) {
    // No lock: the demo never polls Conductor, so a real office may run beside it.
    try {
      conductor = createDemoProvider({
        seed: demo.seed,
        speed: demo.speed,
        log: (message) => console.log(`[Pixel Agents] Demo: ${message}`),
      });
      // No stream memory: every run replays the same story from the start.
      const sink = runtime.attachStreamProvider(conductor);
      void conductor.start(sink).catch((err: unknown) => {
        console.error(`[Pixel Agents] The demo failed to start: ${errorText(err)}`);
      });
    } catch (err) {
      console.error(`[Pixel Agents] The demo is unavailable: ${errorText(err)}`);
      conductor = null;
    }
  }
  if (conductorOn && ownsServer) {
    // One poller per machine: an office in another mode (no shared server)
    // would otherwise double the API traffic and overwrite this one's state.
    conductorLock = acquireConductorLock(config.port);
  }
  if (conductorLock && !conductorLock.acquired) {
    const { pid, port } = conductorLock.holder;
    console.warn(
      `[Pixel Agents] Conductor sessions are already tracked by the Poke Agents office${port ? ` on port ${port}` : ''} (PID ${pid}). This office shows no Conductor sessions: open that one, or stop it and restart this one.`,
    );
  } else if (conductorLock) {
    try {
      conductor = createConductorProvider({
        budgetPerMinute: opts.conductorBudget,
        log: (message) => console.log(`[Pixel Agents] Conductor: ${message}`),
      });
      const sink = runtime.attachStreamProvider(conductor, { memory: adapter });
      void conductor.start(sink).catch((err: unknown) => {
        console.error(`[Pixel Agents] Conductor failed to start: ${errorText(err)}`);
      });
    } catch (err) {
      console.error(`[Pixel Agents] Conductor is unavailable: ${errorText(err)}`);
      conductor = null;
    }
  }

  if (!opts.claude) {
    console.log(
      '[Pixel Agents] Claude Code tracking is off (pass --claude for local sessions, hooks and the terminal).',
    );
  } else {
    reportTerminalStatus(ptyManager, host, terminal);

    // Sync runtime refs with persisted settings BEFORE first scan tick. The
    // runtime's single hooksEnabled ref follows the Claude provider until the
    // scanners grow per-provider awareness alongside the Settings UI.
    runtime.hooksEnabled.current = getHooksEnabled(claudeProvider.id);
    runtime.watchAllSessions.current = adapter.getSetting('pixel-agents.watchAllSessions', false);

    // Install hooks on startup if the persisted setting says so — gated on the
    // one-time consent to modify ~/.claude/settings.json.
    if (runtime.hooksEnabled.current) {
      let consent = getHooksConsent(claudeProvider.id) === 'granted';
      if (!consent && (await claudeProvider.areHooksInstalled())) {
        // Our hooks are already installed and already firing — a pre-consent
        // version put them there. Grant and continue with NO prompt: the
        // install below is the 14 -> 12 migration, and it only ever REDUCES
        // scope (it drops UserPromptSubmit and TaskCreated, the two events that
        // forwarded prompt text and were consumed by nothing). Asking would buy
        // this user no protection they do not already have, so they are not
        // asked. A fresh install still is, in full — in the browser UI, when a
        // tokened client connects (clientMessageHandler's webviewReady).
        grantHooksConsent(claudeProvider.id);
        consent = true;
      }
      if (!consent) {
        console.log(
          '[Pixel Agents] Hooks not installed: modifying ~/.claude/settings.json needs one-time approval — open the URL below to review and approve it.',
        );
      } else if (copyHookScriptOrReport(packageRoot)) {
        try {
          await claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
          console.log('[Pixel Agents] Hooks installed');
        } catch (err) {
          console.error(`[Pixel Agents] ${errorText(err)}`);
        }
      }
    } else {
      // Without this line, a persisted hooks-off makes startup skip the entire
      // consent/install flow with zero output — indistinguishable from a bug.
      console.log(
        '[Pixel Agents] Hooks disabled — enable "Instant Detection (Hooks)" in the UI settings to install them.',
      );
    }

    // Start scanning for external sessions (Claude running in user's terminal)
    const dirs = claudeProvider.getSessionDirs?.(opts.cwd ?? process.cwd());
    if (dirs && dirs[0]) {
      const projectDir = dirs[0];
      console.log(`[Pixel Agents] Scanning project dir: ${projectDir}`);
      runtime.startProjectScan(projectDir);
      runtime.startExternalScanning(projectDir);
      runtime.startStaleCheck();
    }
  }

  // The URL has to be REACHABLE and has to carry the token, which is what
  // makes the session it loads privileged enough to act (see
  // standaloneTokenValid in wsAuth.ts).
  const displayHost = displayHostFor(host);

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      // Stop polling first: nothing should adopt agents into a runtime that is
      // tearing them down.
      await conductor?.stop().catch((err: unknown) => {
        console.error(`[Pixel Agents] Conductor stop failed: ${errorText(err)}`);
      });
      if (conductorLock?.acquired) conductorLock.release();
      // Kill child terminals before the runtime tears their agents down, and
      // wait for them: exiting now would cancel the SIGKILL escalation and
      // leave a child that ignores SIGHUP orphaned on a dead server.
      await ptyManager.disposeAll();
      runtime.dispose();
      await server.stop();
    })();
    return stopping;
  };

  const baseUrl = `http://${displayHost}:${config.port}`;
  return {
    url: `${baseUrl}/?token=${config.token}`,
    baseUrl,
    host: displayHost,
    port: config.port,
    token: config.token,
    ownsServer,
    pid: config.pid,
    store,
    conductorStatus: () =>
      runtime
        .streamDrivers()
        .find((driver) => driver.provider.id === conductor?.id)
        ?.statusMessage() ?? null,
    stop,
  };
}
