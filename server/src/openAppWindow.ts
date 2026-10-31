/**
 * Open URLs on the host for the standalone CLI: the office in a Chromium
 * app-mode window (`--open`), and Conductor deep links (`openExternal`).
 *
 * Every launch goes through execFile with an argument array: never a shell,
 * so nothing in a URL is ever interpreted. The office URL carries the server
 * token; it travels only inside the `--app=` argument.
 */

import { execFile } from 'child_process';

import { OPEN_COMMAND_TIMEOUT_MS } from './constants.js';

/** Runs a program with arguments; resolves when it exits 0. */
export type ExecFn = (file: string, args: readonly string[]) => Promise<void>;

/** Chromium browsers that honor `--app=<url>`, in the order --open tries them. */
export const APP_BROWSERS = [
  { id: 'chrome', label: 'Google Chrome', bundleId: 'com.google.Chrome' },
  { id: 'edge', label: 'Microsoft Edge', bundleId: 'com.microsoft.edgemac' },
  { id: 'brave', label: 'Brave', bundleId: 'com.brave.Browser' },
  { id: 'chromium', label: 'Chromium', bundleId: 'org.chromium.Chromium' },
  { id: 'vivaldi', label: 'Vivaldi', bundleId: 'com.vivaldi.Vivaldi' },
  { id: 'chrome-canary', label: 'Chrome Canary', bundleId: 'com.google.Chrome.canary' },
] as const;

/** Values --browser accepts: one of APP_BROWSERS, or `default` for the
 *  system browser in a normal window. */
export const BROWSER_IDS = [...APP_BROWSERS.map((b) => b.id), 'default'] as const;
export type BrowserId = (typeof BROWSER_IDS)[number];

export function isBrowserId(value: string): value is BrowserId {
  return (BROWSER_IDS as readonly string[]).includes(value);
}

/** macOS `open`, by absolute path so PATH can't substitute it. */
const MAC_OPEN = '/usr/bin/open';
const LINUX_OPEN = 'xdg-open';
const DEFAULT_BROWSER_LABEL = 'the default browser';

export interface OpenOptions {
  platform?: NodeJS.Platform;
  exec?: ExecFn;
}

/**
 * Open the office URL in an app window and say where it went.
 *
 * macOS: `open -n -b <bundleId> --args --app=<url>` for each candidate in
 * turn. `open -b` fails when no app has that bundle id, so the first success
 * wins; `-n` is required, or a browser that is already running ignores
 * `--args`. `browser` narrows the candidates to one; when it (or every
 * candidate) is missing, or `browser` is `default`, the URL opens in the
 * default browser. Linux: `xdg-open`. Rejects when nothing could open it.
 */
export async function openAppWindow(
  url: string,
  options: OpenOptions & { browser?: BrowserId } = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? execFileAsync;
  if (platform === 'darwin') {
    const candidates =
      options.browser === 'default'
        ? []
        : APP_BROWSERS.filter((b) => options.browser === undefined || b.id === options.browser);
    for (const browser of candidates) {
      try {
        await exec(MAC_OPEN, ['-n', '-b', browser.bundleId, '--args', `--app=${url}`]);
        return browser.label;
      } catch {
        // Not installed (or refused): try the next one.
      }
    }
    await exec(MAC_OPEN, [url]);
    return DEFAULT_BROWSER_LABEL;
  }
  if (platform === 'linux') {
    await exec(LINUX_OPEN, [url]);
    return DEFAULT_BROWSER_LABEL;
  }
  throw new Error(`opening a window is not supported on ${platform}`);
}

/**
 * Hand a deep link (already validated by the caller) to the app registered
 * for its scheme: `/usr/bin/open <url>` on macOS, `xdg-open <url>` on Linux.
 */
export async function openWithSystem(url: string, options: OpenOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? execFileAsync;
  if (platform === 'darwin') return exec(MAC_OPEN, [url]);
  if (platform === 'linux') return exec(LINUX_OPEN, [url]);
  throw new Error(`Opening links is not supported on ${platform}.`);
}

function execFileAsync(file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: OPEN_COMMAND_TIMEOUT_MS }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
