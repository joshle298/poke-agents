/**
 * Pure text helpers for the Conductor chrome (DOM-free, Node-tested).
 */

import { conductorKeyCandidates } from '../../../core/src/conductorKey.js';
import type { ConductorKeyStorage, ConductorStatus } from '../../../core/src/messages.js';
import {
  CONDUCTOR_DEEP_LINK_HOST,
  CONDUCTOR_DEEP_LINK_PROTOCOL,
  CONDUCTOR_SCOPE_ALL_LABEL,
  PARTY_NAME_SPLIT_MIN_CHARS,
  PARTY_NAME_TAIL_CHARS,
  PARTY_NAME_TAIL_MAX_CHARS,
} from '../constants.js';

/**
 * A name split for an ellipsis in its middle: the `head` is cut when it
 * doesn't fit, the `tail` always shows, so "recorder-platform-review-1" and
 * "recorder-platform-review-2" stay apart as "recorder-pl…review-1". Only
 * identifier-like names (no spaces) longer than PARTY_NAME_SPLIT_MIN_CHARS
 * are split; titles keep their start (tail empty).
 */
export function splitNameTail(name: string): { head: string; tail: string } {
  if (name.length <= PARTY_NAME_SPLIT_MIN_CHARS || /\s/.test(name)) return { head: name, tail: '' };
  const segments = name.split(/(?<=[-_./])/);
  let tail = '';
  for (let i = segments.length - 1; i > 0; i--) {
    const next = segments[i] + tail;
    if (next.length > PARTY_NAME_TAIL_MAX_CHARS) break;
    tail = next;
  }
  if (!tail) tail = name.slice(-PARTY_NAME_TAIL_CHARS);
  return { head: name.slice(0, name.length - tail.length), tail };
}

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

/**
 * The Conductor CLI's full path inside the Conductor app on a Mac, where it
 * usually is not on PATH. Quoted: the path has a space.
 */
export const CONDUCTOR_CLI_LOGIN_COMMAND =
  '"$HOME/Library/Application Support/com.conductor.app/bin/conductor" auth login';

/** Pasted text, trimmed, when it has a Conductor API key's shape or is one
 *  key pasted twice (conductorKeyCandidates); else null. The server checks
 *  the same shape and then the key itself (GET /me), a single copy first. */
export function apiKeyFromText(text: string): string | null {
  return conductorKeyCandidates(text).length > 0 ? text.trim() : null;
}

/** A key's prefix and last four characters, to show which key the Mac app
 *  found on the clipboard without showing the key: "abcde_…wxyz". */
export function maskedKeyHint(key: string): string {
  const prefix = /^[a-z]{2,12}_/.exec(key)?.[0] ?? '';
  return `${prefix}…${key.slice(-4)}`;
}

/** A connect's reply split for the empty office: its first line ("Connected
 *  as <account>") as the title, and the rest (the Keychain refused the key)
 *  as a note. */
export function splitConnectedMessage(message: string | undefined): {
  headline: string;
  note?: string;
} {
  const [headline, ...rest] = (message?.trim() || 'Connected to Conductor').split('\n');
  const note = rest.join(' ').trim();
  return note ? { headline: headline.trim(), note } : { headline: headline.trim() };
}

/** What the card says when the browser refused to read the clipboard. */
export function pasteBlockedMessage(platform: string): string {
  return `Clipboard access was blocked. Paste with ${/mac|iphone|ipad/i.test(platform) ? 'Cmd' : 'Ctrl'}+V.`;
}

/** The variable an `env` key came from (CONDUCTOR_API_KEY when unknown). */
function envName(status: ConductorStatus | null): string {
  return status?.authEnv ?? 'CONDUCTOR_API_KEY';
}

/** Said wherever the office keeps a key in the Keychain: the item trusts
 *  /usr/bin/security, so programs running as the user read it unprompted. */
const KEYCHAIN_READABLE_NOTE = 'apps you run can read it without asking';

/** Where the key in use came from, for Settings. Never the key. */
export function authSourceText(status: ConductorStatus | null): string | null {
  switch (status?.authSource) {
    case 'env':
      return `Signed in with ${envName(status)} from the environment.`;
    case 'app':
      return `API key saved by Poke Agents in the macOS Keychain (${KEYCHAIN_READABLE_NOTE}).`;
    case 'session':
      // On a Mac this means the Keychain refused the key: an app opened from
      // Finder can't take an environment variable.
      return status.keyStorage === 'keychain'
        ? "API key kept until Poke Agents quits: the Keychain didn't save it. Connect again next time."
        : 'API key kept until Poke Agents quits. Set CONDUCTOR_API_KEY to stay signed in.';
    case 'cli':
      return 'Signed in through the Conductor CLI.';
    default:
      return null;
  }
}

/** Where a key pasted on the Connect card is kept, said once on the card. */
export function keyStorageNote(storage: ConductorKeyStorage | undefined): string {
  return storage === 'keychain'
    ? `Poke Agents saves the key in your macOS Keychain, where ${KEYCHAIN_READABLE_NOTE}.`
    : 'Poke Agents keeps the key until it quits. Set CONDUCTOR_API_KEY to stay signed in.';
}

/** The Sign out confirmation. On a Mac the Conductor CLI's own sign-in, when
 *  there is one, takes over (and macOS may ask before Poke Agents reads it). */
export function signOutConfirmText(status: ConductorStatus | null): string {
  return status?.keyStorage === 'keychain'
    ? "Poke Agents forgets the API key it saved. If the Conductor CLI is signed in, the office switches to that sign-in (macOS may ask to allow Keychain access); otherwise its sessions leave the office. Conductor's own sign-in is not touched."
    : 'Poke Agents forgets the API key, and its sessions leave the office. To connect again you need an API key.';
}

/** Sign out is offered only for a key Poke Agents itself keeps: never for
 *  the environment or the Conductor CLI's own sign-in. */
export function canSignOut(status: ConductorStatus | null): boolean {
  return status?.authSource === 'app' || status?.authSource === 'session';
}

/** A sign-in rejected while it came from the environment: the office can't
 *  fix that (the environment wins), so the card says what to change instead. */
export function envKeyRejected(status: ConductorStatus | null): boolean {
  return status?.state === 'unauthorized' && status.authSource === 'env';
}

/** What to change when Conductor rejects a key from the environment, naming
 *  the variable it came from. */
export function envKeyRejectedText(status: ConductorStatus | null): string {
  return `Conductor rejected the key in ${envName(status)}. Update it, then restart Poke Agents.`;
}

/** Why a session the user expects may be missing from the office. */
export const CLOUD_ONLY_NOTE =
  'Only cloud workspaces appear: local (Mac) workspaces have no API. The Conductor API needs Conductor Pro.';

/** One line describing the Conductor connection, for Settings, the Sessions
 *  modal and the empty office. Never includes the token (it never has it).
 *  The sign-in states point at the Connect card, in the browser and the Mac
 *  app alike: no step needs a restart unless the key comes from the
 *  environment. */
export function conductorStatusLine(status: ConductorStatus | null, now: number): string {
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
      return 'Not connected to Conductor. Connect with an API key.';
    case 'unauthorized':
      return envKeyRejected(status)
        ? envKeyRejectedText(status)
        : 'Conductor rejected the API key. Connect with a new one.';
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
