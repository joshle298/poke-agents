/**
 * Pure text helpers for the Conductor chrome (DOM-free, Node-tested).
 */

import {
  CONDUCTOR_KEY_PATTERN,
  CONDUCTOR_KEY_WIRE_MAX_LENGTH,
} from '../../../core/src/constants.js';
import type {
  ConductorAuthSource,
  ConductorKeyStorage,
  ConductorStatus,
} from '../../../core/src/messages.js';
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

/** A pasted Conductor API key, trimmed, when it has a key's shape; else null.
 *  The server checks the same shape and then the key itself (GET /me). */
export function apiKeyFromText(text: string): string | null {
  const key = text.trim();
  return key.length <= CONDUCTOR_KEY_WIRE_MAX_LENGTH && CONDUCTOR_KEY_PATTERN.test(key)
    ? key
    : null;
}

/** Where the key in use came from, for Settings. Never the key. */
export function authSourceText(source: ConductorAuthSource | undefined): string | null {
  switch (source) {
    case 'env':
      return 'Signed in with an environment variable (CONDUCTOR_API_KEY).';
    case 'app':
      return 'API key saved in the macOS Keychain by Poke Agents.';
    case 'session':
      return 'API key kept for this session only. Set CONDUCTOR_API_KEY to stay signed in.';
    case 'cli':
      return 'Signed in through the Conductor CLI.';
    default:
      return null;
  }
}

/** Where a key pasted on the Connect card is kept, said once on the card. */
export function keyStorageNote(storage: ConductorKeyStorage | undefined): string {
  return storage === 'keychain'
    ? 'Poke Agents keeps the key in your macOS Keychain.'
    : 'Poke Agents keeps the key for this session only. Set CONDUCTOR_API_KEY to stay signed in.';
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
        ? 'Conductor rejected the key in CONDUCTOR_API_KEY. Update it, then restart Poke Agents.'
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
