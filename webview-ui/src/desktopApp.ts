/**
 * Whether the office runs in the Poke Agents desktop app (desktop/), which
 * tags its window's user agent. The app opens from Finder without the
 * shell's environment and has a menu to reconnect to Conductor, so a few
 * instructions read differently there. DOM-free, so Node tests import it.
 */

import { DESKTOP_APP_USER_AGENT_PRODUCT } from './constants.js';

/** Whether a user agent is the desktop app's window. */
export function isDesktopAppUserAgent(userAgent: string): boolean {
  return userAgent
    .split(' ')
    .some((product) => product.startsWith(`${DESKTOP_APP_USER_AGENT_PRODUCT}/`));
}

export const isDesktopApp: boolean = isDesktopAppUserAgent(
  (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? '',
);
