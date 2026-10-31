/**
 * Pure text helpers for the Conductor chrome (DOM-free, Node-tested).
 */

import type { ConductorStatus } from '../../../core/src/messages.js';
import {
  CONDUCTOR_DEEP_LINK_HOST,
  CONDUCTOR_DEEP_LINK_PROTOCOL,
  CONDUCTOR_SCOPE_ALL_LABEL,
} from '../constants.js';

/** Compact age: "now", "42s", "5m", "3h", "2d". */
export function shortAge(at: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - at) / 1000));
  if (sec < 5) return 'now';
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "5m ago", or "just now". */
export function agoText(at: number, now: number): string {
  const age = shortAge(at, now);
  return age === 'now' ? 'just now' : `${age} ago`;
}

/** Conductor's workspace label: "#12 fix-login", "#12", or the name alone. */
export function workspaceLabel(number?: number, name?: string): string {
  if (number !== undefined && name) return `#${number} ${name}`;
  if (number !== undefined) return `#${number}`;
  return name ?? '';
}

/** "claude-sonnet · claude", or whichever half is known. */
export function modelLabel(model?: string, harness?: string): string {
  return [model, harness].filter(Boolean).join(' · ');
}

/** Sign-in steps shown when no Conductor token was found. */
const CONDUCTOR_SIGN_IN_TEXT =
  'Sign in with `conductor auth login` or set CONDUCTOR_API_KEY, then restart.';

/** The Conductor CLI command that saves a sign-in to the Keychain. */
export const CONDUCTOR_LOGIN_COMMAND = 'conductor auth login';

/** Where the desktop app's menu item lives. */
const APP_RECONNECT_MENU_ITEM = 'Poke Agents > Reconnect to Conductor';

/** The desktop app's next step after signing in, for one-line statuses. */
const APP_SIGN_IN_TEXT = `Run \`${CONDUCTOR_LOGIN_COMMAND}\` in Terminal, then choose ${APP_RECONNECT_MENU_ITEM}.`;

/** One sign-in step: text around at most one highlighted command or label.
 *  `copy` marks a command the reader can click to copy. */
export interface SignInStep {
  lead: string;
  accent?: string;
  copy?: boolean;
  tail?: string;
}

/**
 * The steps to sign in to Conductor, worded for where the office runs. The
 * desktop app starts from Finder without the shell's environment, so it can't
 * see CONDUCTOR_API_KEY; it reads the Keychain login (macOS asks whether
 * `security` may read it) and reconnects from its own Reconnect button
 * (`canReconnect`) or menu. A terminal-started server reads both, and
 * restarts to pick them up.
 */
export function signInSteps(desktopApp: boolean, canReconnect = false): SignInStep[] {
  const login: SignInStep = { lead: 'Run ', accent: CONDUCTOR_LOGIN_COMMAND, copy: true };
  if (desktopApp) {
    const keychain = '. If macOS asks to use the Keychain, choose Allow.';
    return [
      { ...login, tail: ' in Terminal.' },
      canReconnect
        ? { lead: 'Click ', accent: 'Reconnect', tail: keychain }
        : { lead: 'Choose ', accent: APP_RECONNECT_MENU_ITEM, tail: keychain },
    ];
  }
  return [{ ...login, tail: ', or set CONDUCTOR_API_KEY.' }, { lead: 'Restart Poke Agents.' }];
}

/** Why a session the user expects may be missing from the office. */
export const CLOUD_ONLY_NOTE =
  'Only cloud workspaces appear: local (Mac) workspaces have no API. The Conductor API needs Conductor Pro.';

/** One line describing the Conductor connection, for Settings, the Sessions
 *  modal and the empty office. Never includes the token (it never has it).
 *  In the desktop app the sign-in states name the app's own next step: the
 *  server's message speaks of environment variables and restarts, which an
 *  app opened from Finder can't use. */
export function conductorStatusLine(
  status: ConductorStatus | null,
  now: number,
  desktopApp = false,
): string {
  if (!status) return 'Connecting to Conductor…';
  switch (status.state) {
    case 'connected': {
      const who = status.account ? `Conductor: ${status.account}` : 'Conductor';
      const parts = [who];
      if (status.visibleCount !== undefined && status.sessionCount !== undefined) {
        parts.push(`${status.visibleCount} of ${status.sessionCount} sessions shown`);
      } else if (status.visibleCount !== undefined) {
        parts.push(`${status.visibleCount} sessions shown`);
      }
      if (status.lastSyncAt !== undefined) parts.push(`synced ${agoText(status.lastSyncAt, now)}`);
      return parts.join(' · ');
    }
    case 'connecting':
      return 'Connecting to Conductor…';
    case 'authRequired':
      if (desktopApp) return `No Conductor sign-in found. ${APP_SIGN_IN_TEXT}`;
      return status.message ?? `No Conductor sign-in found. ${CONDUCTOR_SIGN_IN_TEXT}`;
    case 'unauthorized':
      if (desktopApp) return `Conductor rejected the sign-in. ${APP_SIGN_IN_TEXT}`;
      return 'Conductor rejected the sign-in. Run `conductor auth login` again, then restart.';
    case 'unreachable':
      return "Can't reach Conductor. Retrying…";
    case 'rateLimited':
      return 'Conductor is rate limiting this app. Updates slow down for a while.';
    case 'disabled':
      return 'Conductor is off for this server.';
    default:
      return status.message ?? '';
  }
}

/** True for the states where Conductor can't list sessions until the user
 *  signs in. */
export function needsSignIn(status: ConductorStatus | null): boolean {
  return status?.state === 'authRequired' || status?.state === 'unauthorized';
}

/** Activity window label for the Sessions modal: "1h", "24h", "All (30d)".
 *  0 asks for no limit; the server applies it as its longest window. */
export function windowLabel(hours: number): string {
  return hours === 0 ? CONDUCTOR_SCOPE_ALL_LABEL : `${hours}h`;
}

/**
 * The Sessions modal's activity-window choices: the presets (0 = "All", the
 * server's longest window, kept last) plus the server's current value when it is none of them,
 * so the control always shows what the server actually applied.
 */
export function windowOptions(
  presets: readonly number[],
  current: number | undefined,
): Array<{ value: number; label: string }> {
  const values = new Set(presets);
  if (current !== undefined && Number.isFinite(current) && current >= 0) values.add(current);
  return [...values]
    .sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
    .map((value) => ({ value, label: windowLabel(value) }));
}

/**
 * Only Conductor deep links (conductor://workspace?...) may be handed to
 * openExternal. The URL comes from the server, but the client checks too, so
 * a malformed one never reaches the host's opener.
 */
export function isConductorDeepLink(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      CONDUCTOR_DEEP_LINK_PROTOCOL.test(parsed.protocol) &&
      parsed.hostname === CONDUCTOR_DEEP_LINK_HOST
    );
  } catch {
    return false;
  }
}

/** The URL when it is a plain https link (credits pages), else undefined:
 *  server-supplied strings never become javascript: or file: hrefs. */
export function safeHttpsUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
