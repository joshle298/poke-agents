/**
 * Poke Agents desktop app: the Electron main process.
 *
 * The app is a window onto the standalone office, nothing more. It runs the
 * office server in this process (Conductor on; no Claude Code tracking, no
 * terminal, no hook installs), or attaches to a `poke-agents` server already
 * running with the same access, and loads the office's tokened URL in its own
 * window. On top it adds what a browser window can't: native notifications
 * when a session needs you or faints, and the Dock badge.
 *
 * Coding happens in Conductor. The office only ever asks Conductor's API to
 * act on explicit clicks; this process adds no writes of its own.
 */

import { app, BrowserWindow, dialog, Menu, screen, session, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { type StandaloneOffice, startStandalone } from '../../../server/src/standalone.js';
import { parseDesktopArgs } from '../args.js';
import { AttentionTracker } from '../attention.js';
import {
  APP_NAME,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  FEED_RETRY_MS,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  POKEMON_THEME_SETTING,
  RECONNECT_QUIET_MS,
  REUSED_SERVER_CHECK_MS,
  STOP_TIMEOUT_MS,
  USER_AGENT_PRODUCT,
  WINDOW_BACKGROUND,
  WINDOW_STATE_FILE,
  WINDOW_STATE_SAVE_DELAY_MS,
} from '../constants.js';
import { classifyNavigation } from '../navigation.js';
import { feedFromStore, subscribeToOffice } from '../officeFeed.js';
import { speciesName } from '../species.js';
import { parseWindowState, placeWindow, type WindowState } from '../windowState.js';
import { buildMenuTemplate } from './menu.js';
import { Notifier } from './notifier.js';
import { runSmoke } from './smoke.js';

const args = parseDesktopArgs(process.argv, process.env);
const isMac = process.platform === 'darwin';

let office: StandaloneOffice | null = null;
let officeWindow: BrowserWindow | null = null;
let detachFeed: (() => void) | null = null;
let restarting: Promise<void> | null = null;
let quitting = false;
let stopped = false;

const tracker = new AttentionTracker({ speciesName });
const notifier = new Notifier(tracker, {
  windowFocused: () => officeWindow?.isFocused() ?? false,
  windowOpen: () => officeWindow !== null,
  focusOffice: () => showOffice(),
});

// ── Paths ─────────────────────────────────────────────────────

/** The built office (assets/ + webview/): beside main.js in development, in
 *  the app's Resources folder when packaged. */
function officeRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'office')
    : path.join(__dirname, 'office');
}

/** The 1024 px icon, for the Dock and window in unpackaged runs (a packaged
 *  macOS app uses its .icns). */
function devIconPath(): string {
  return path.join(__dirname, '..', 'resources', 'icon.png');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An error box, or a log line in a smoke run (nobody is there to close a box). */
function reportError(title: string, err: unknown): void {
  if (args.smoke) console.error(`[Poke Agents] ${title}: ${errorText(err)}`);
  else dialog.showErrorBox(title, errorText(err));
}

// ── The office server ─────────────────────────────────────────

/** Start the office in this process, or attach to a compatible running one,
 *  and start feeding notifications from it. */
async function startOffice(): Promise<StandaloneOffice> {
  const started = await startStandalone({
    distRoot: officeRoot(),
    conductor: true,
    claude: false,
    terminal: false,
    // Conductor deep links (already validated by the server) open in the
    // Conductor app.
    openExternal: (url) => shell.openExternal(url),
  });
  attachFeed(started);
  return started;
}

function attachFeed(target: StandaloneOffice): void {
  detachFeed?.();
  notifier.reset();
  if (target.ownsServer) {
    tracker.setThemed(
      target.store.getAdapter()?.getSetting<boolean>(POKEMON_THEME_SETTING, true) !== false,
    );
    detachFeed = feedFromStore(target.store, (message) => notifier.handle(message));
    return;
  }
  // A `poke-agents` CLI serves this office: watch it over a read-only socket,
  // and take over when it stops.
  const subscription = subscribeToOffice({
    url: `ws://${target.host}:${target.port}/ws`,
    listener: (message) => notifier.handle(message),
    onConnect: () => {
      notifier.reset();
      tracker.quiet(RECONNECT_QUIET_MS);
    },
    retryMs: FEED_RETRY_MS,
  });
  const watch = setInterval(() => {
    if (!isProcessAlive(target.pid)) void restartOffice();
  }, REUSED_SERVER_CHECK_MS);
  detachFeed = () => {
    clearInterval(watch);
    subscription.close();
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Stop the office and start it again (a new sign-in, or the reused server
 *  went away), then point the window at it. */
function restartOffice(): Promise<void> {
  restarting ??= (async () => {
    detachFeed?.();
    detachFeed = null;
    const previous = office;
    office = null;
    await previous?.stop();
    if (quitting) return;
    try {
      office = await startOffice();
      void officeWindow?.loadURL(office.url);
    } catch (err) {
      reportError(`${APP_NAME} could not restart the office`, err);
    }
  })().finally(() => {
    restarting = null;
  });
  return restarting;
}

/** Menu: re-read the Conductor sign-in (after `conductor auth login`). */
function reconnectConductor(): void {
  if (!office) return;
  if (office.ownsServer) {
    void restartOffice();
    return;
  }
  void dialog.showMessageBox({
    type: 'info',
    message: 'This office runs in Terminal',
    detail: `A poke-agents server (PID ${office.pid}) serves this office. Restart it there to reconnect to Conductor.`,
  });
}

async function shutdown(): Promise<void> {
  const timeout = new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS));
  // A restart in flight finishes first (it starts nothing once quitting), so
  // the office it stops or starts is the one stopped here.
  if (restarting) await Promise.race([restarting, timeout]);
  detachFeed?.();
  detachFeed = null;
  const current = office;
  office = null;
  if (!current) return;
  await Promise.race([current.stop(), timeout]);
}

// ── The window ────────────────────────────────────────────────

function windowStatePath(): string {
  return path.join(app.getPath('userData'), WINDOW_STATE_FILE);
}

function readWindowState(): WindowState | null {
  try {
    return parseWindowState(JSON.parse(fs.readFileSync(windowStatePath(), 'utf-8')));
  } catch {
    return null;
  }
}

function writeWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  const state: WindowState = {
    bounds: window.getNormalBounds(),
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
  };
  const file = windowStatePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.warn(`[Poke Agents] Could not save the window position: ${errorText(err)}`);
  }
}

function createOfficeWindow(url: string): BrowserWindow {
  const placement = placeWindow(
    readWindowState(),
    screen.getAllDisplays().map((display) => display.workArea),
    {
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      defaultWidth: DEFAULT_WINDOW_WIDTH,
      defaultHeight: DEFAULT_WINDOW_HEIGHT,
    },
  );
  const window = new BrowserWindow({
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: APP_NAME,
    backgroundColor: WINDOW_BACKGROUND,
    show: false,
    ...(!app.isPackaged && !isMac ? { icon: devIconPath() } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  window.once('ready-to-show', () => {
    if (placement.maximized) window.maximize();
    window.show();
    if (placement.fullScreen) window.setFullScreen(true);
  });
  // The page would rename the window to its <title>; the window is the app.
  window.on('page-title-updated', (event) => event.preventDefault());

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSave = (): void => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => writeWindowState(window), WINDOW_STATE_SAVE_DELAY_MS);
  };
  window.on('resize', scheduleSave);
  window.on('move', scheduleSave);
  window.on('close', () => {
    clearTimeout(saveTimer);
    writeWindowState(window);
  });
  window.on('closed', () => {
    if (officeWindow === window) officeWindow = null;
  });

  guardNavigation(window);
  void window.loadURL(url);
  return window;
}

/**
 * The window only ever shows the office. Web links open in the default
 * browser, Conductor deep links in the Conductor app (after the server's own
 * allowlist), and every other navigation, popup or <webview> is refused.
 */
function guardNavigation(window: BrowserWindow): void {
  const mayLoad = (target: string): boolean => {
    const origin = office ? new URL(office.url).origin : '';
    switch (classifyNavigation(target, origin)) {
      case 'office':
        return true;
      case 'browser':
      case 'conductor':
        void shell.openExternal(target);
        return false;
      default:
        console.warn('[Poke Agents] Blocked a navigation the office does not make.');
        return false;
    }
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    mayLoad(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!mayLoad(url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!mayLoad(url)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

/** Bring the office forward, reopening the window if it was closed. */
function showOffice(): void {
  if (!office) return;
  if (!officeWindow) {
    officeWindow = createOfficeWindow(office.url);
    return;
  }
  if (officeWindow.isMinimized()) officeWindow.restore();
  officeWindow.show();
  officeWindow.focus();
}

/** The office asks for nothing beyond writing to the clipboard. */
function limitPermissions(): void {
  const allowed = (permission: string): boolean => permission === 'clipboard-sanitized-write';
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(allowed(permission)),
  );
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed(permission));
}

// ── App lifecycle ─────────────────────────────────────────────

async function main(): Promise<void> {
  // One app per user: a second launch brings the first one's window forward.
  // A smoke run is a throwaway process and never takes the lock.
  if (!args.smoke && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => showOffice());
  app.on('activate', () => showOffice());
  // macOS keeps the app in the Dock with no window; Cmd+Q quits.
  app.on('window-all-closed', () => {
    if (!isMac || args.smoke) app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    void shutdown().finally(() => {
      stopped = true;
      // On a later turn: a quit requested while this will-quit is still
      // being dispatched (shutdown can settle that fast) is swallowed by the
      // quit it just cancelled.
      setImmediate(() => app.quit());
    });
  });
  process.on('SIGINT', () => app.quit());
  process.on('SIGTERM', () => app.quit());

  await app.whenReady();
  app.userAgentFallback = `${app.userAgentFallback} ${USER_AGENT_PRODUCT}/${app.getVersion()}`;
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'MIT License. A fork of Pixel Agents by Pablo De Lucca.',
    credits:
      'Your Conductor cloud sessions as Pokémon. Not affiliated with Nintendo, The Pokémon Company, Creatures or GAME FREAK.',
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        isMac,
        isPackaged: app.isPackaged,
        actions: { reconnectConductor },
      }),
    ),
  );
  if (isMac && !app.isPackaged) app.dock?.setIcon(devIconPath());
  limitPermissions();

  try {
    office = await startOffice();
  } catch (err) {
    reportError(`${APP_NAME} could not start`, err);
    stopped = true;
    app.exit(1);
    return;
  }

  officeWindow = createOfficeWindow(office.url);
  if (!args.smoke) return;

  // Never print the URL: it carries the token.
  console.log(
    `[Poke Agents] smoke: office server at ${office.host}:${office.port} (${office.ownsServer ? 'started in this app' : `reused from PID ${office.pid}`})`,
  );
  const rendered = await runSmoke(officeWindow, args.smokeOut ?? path.resolve('smoke.png'));
  if (rendered) {
    app.quit();
    return;
  }
  await shutdown();
  stopped = true;
  app.exit(1);
}

main().catch((err: unknown) => {
  console.error(`[Poke Agents] ${errorText(err)}`);
  app.exit(1);
});
