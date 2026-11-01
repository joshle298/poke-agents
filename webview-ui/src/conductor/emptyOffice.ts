/**
 * What the empty office's card says (DOM-free, Node-tested): the Connect card,
 * "Connected as …", "No sessions in scope", a connection problem, or
 * "Connecting to Conductor…" with how long it has been. ConductorEmptyOffice
 * draws it.
 *
 * Everything comes from the store's newest state: the conductorStatus the
 * server last sent (it replays it on every handshake, reconnects included),
 * and whether sessions are present. The card never says "Connecting" once
 * the server reported another state, and shows nothing while sessions are in
 * the office or the server says it shows some.
 */

import type { ConductorStatus } from '../../../core/src/messages.js';
import { CONDUCTOR_CONNECTED_NOTICE_MS, CONDUCTOR_SLOW_CONNECT_MS } from '../constants.js';
import type { TransportState } from '../transport/types.js';
import type { SignInOutcome } from './conductorStore.js';
import { needsSignIn, splitConnectedMessage } from './format.js';

export type EmptyOfficeCard =
  | { kind: 'signIn' }
  /** Right after a connect from the card: its reply's first line. */
  | { kind: 'justConnected'; headline: string; note?: string }
  | { kind: 'noSessions' }
  /** Waiting for Conductor; `slow` past CONDUCTOR_SLOW_CONNECT_MS. */
  | { kind: 'connecting'; elapsedMs: number; slow: boolean }
  /** The office's own socket to Poke Agents is down: what it last heard
   *  about Conductor may be out of date, so it doesn't repeat it. */
  | { kind: 'reconnecting' }
  /** Unreachable, rate limited, disabled: the status line says which. */
  | { kind: 'problem' };

export interface EmptyOfficeInput {
  status: ConductorStatus | null;
  signIn: SignInOutcome | null;
  /** ConductorState.connectingSince. */
  connectingSince: number | null;
  /** Agents the store knows are in the office. */
  agentCount: number;
  transportState: TransportState;
  now: number;
}

/** The card for an office with Conductor on and nobody in it, or null when
 *  sessions are present (in the office, or reported shown by the server). */
export function emptyOfficeCard(input: EmptyOfficeInput): EmptyOfficeCard | null {
  const { status, signIn, now } = input;
  if (input.agentCount > 0 || (status?.visibleCount ?? 0) > 0) return null;
  if (needsSignIn(status)) return { kind: 'signIn' };
  const state = status?.state ?? 'connecting';
  if (
    signIn?.action === 'connect' &&
    signIn.ok &&
    now - signIn.at < CONDUCTOR_CONNECTED_NOTICE_MS
  ) {
    return { kind: 'justConnected', ...splitConnectedMessage(signIn.message) };
  }
  if (state === 'connected') return { kind: 'noSessions' };
  if (state !== 'connecting') return { kind: 'problem' };
  if (input.transportState === 'reconnecting' || input.transportState === 'disconnected') {
    return { kind: 'reconnecting' };
  }
  const elapsedMs = Math.max(0, now - (input.connectingSince ?? now));
  return { kind: 'connecting', elapsedMs, slow: elapsedMs >= CONDUCTOR_SLOW_CONNECT_MS };
}
