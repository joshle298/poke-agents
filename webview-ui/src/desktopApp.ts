/**
 * The Poke Agents desktop app (desktop/) as the office sees it: the small
 * bridge the app's preload script exposes (reconnect to Conductor, a key on
 * the clipboard for the Connect card, app commands), and the product token
 * the app adds to its window's user agent. DOM-free, so Node tests import it.
 */

import { DESKTOP_APP_USER_AGENT_PRODUCT, DESKTOP_BRIDGE_GLOBAL } from './constants.js';

/** Whether a user agent is the desktop app's window. */
export function isDesktopAppUserAgent(userAgent: string): boolean {
  return userAgent
    .split(' ')
    .some((product) => product.startsWith(`${DESKTOP_APP_USER_AGENT_PRODUCT}/`));
}

/** What the app asks the office to do (its menu, a notification click). */
export type DesktopCommand = { type: 'openSession'; agentId: number } | { type: 'openSettings' };

/** The preload's API (desktop/src/electron/preload.ts). */
export interface DesktopBridge {
  /** Re-read the Conductor sign-in and restart polling. */
  reconnectConductor(): void;
  /** Paste: a Conductor API key on the clipboard, or null. Answers only
   *  during a user's click (the preload checks user activation), only for the
   *  focused office window, and only key-shaped text. */
  readClipboardKey(): Promise<string | null>;
  /** The clipboard suggestion: on the first focus after "Get an API key",
   *  text shaped like a Conductor key (CONDUCTOR_KEY_SUGGEST_PATTERN in
   *  desktop/src/constants.ts), or
   *  null. The app answers once per opening of the API keys page and reads
   *  nothing otherwise. Absent in an app older than the office it shows. */
  clipboardKeySuggestion?(): Promise<string | null>;
  /** Receive app commands; returns the unsubscribe. */
  onCommand(listener: (command: unknown) => void): () => void;
}

/** The bridge, in the desktop app only. */
export const desktopBridge: DesktopBridge | undefined = (
  globalThis as Record<string, unknown> & { [DESKTOP_BRIDGE_GLOBAL]?: DesktopBridge }
)[DESKTOP_BRIDGE_GLOBAL];

/** A command from the app, or null for anything else. */
export function parseDesktopCommand(raw: unknown): DesktopCommand | null {
  if (raw === null || typeof raw !== 'object') return null;
  const command = raw as Record<string, unknown>;
  if (command.type === 'openSettings') return { type: 'openSettings' };
  if (
    command.type === 'openSession' &&
    typeof command.agentId === 'number' &&
    Number.isInteger(command.agentId) &&
    command.agentId > 0
  ) {
    return { type: 'openSession', agentId: command.agentId };
  }
  return null;
}
