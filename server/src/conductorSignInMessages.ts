/**
 * The office's Connect to Conductor card: `connectConductor { apiKey }` and
 * `disconnectConductor`, both privileged (dispatched after
 * handleClientMessage's read-only gate; refused with a reply before it). Each
 * is answered to its sender only with conductorActionResult, action `connect`
 * or `disconnect`.
 *
 * The key is handed to the sign-in controller and never echoed: replies carry
 * fixed refusals or "Connected as <account>", and failures are logged by
 * their kind only, never with a message that could quote the key.
 */

import type { ConductorAction } from '../../core/src/messages.js';
import type { ClientMessageContext } from './clientMessageHandler.js';
import {
  API_KEY_WIRE_MAX_LENGTH,
  KEY_INVALID_MESSAGE,
} from './providers/stream/conductor/constants.js';
import { SignInError } from './providers/stream/conductor/signIn.js';

type WsSend = (message: Record<string, unknown>) => void;

const NOT_AVAILABLE_MESSAGE = 'Connecting to Conductor is not available in this office.';
const READ_ONLY_MESSAGE = 'Read-only office: open the tokened URL to make changes.';
const CONNECT_FAILED_MESSAGE = "Couldn't connect to Conductor.";
const DISCONNECT_FAILED_MESSAGE = "Couldn't sign out of Conductor.";

/** Every message type this module handles. */
export const CONDUCTOR_SIGN_IN_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'connectConductor',
  'disconnectConductor',
]);

type SignInAction = Extract<ConductorAction, 'connect' | 'disconnect'>;

function actionOf(type: unknown): SignInAction {
  return type === 'connectConductor' ? 'connect' : 'disconnect';
}

function reply(send: WsSend, action: SignInAction, ok: boolean, message?: string): void {
  send({ type: 'conductorActionResult', action, ok, message });
}

export function handleConductorSignInMessage(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): void {
  const action = actionOf(msg.type);
  const control = ctx.conductorSignIn;
  if (!control) return reply(send, action, false, NOT_AVAILABLE_MESSAGE);
  if (action === 'connect') {
    const apiKey = msg.apiKey;
    // Oversize or non-string payloads stop here, before any work.
    if (typeof apiKey !== 'string' || apiKey.length > API_KEY_WIRE_MAX_LENGTH) {
      return reply(send, action, false, KEY_INVALID_MESSAGE);
    }
    void settle(control.connect(apiKey), send, action, CONNECT_FAILED_MESSAGE);
    return;
  }
  void settle(control.disconnect(), send, action, DISCONNECT_FAILED_MESSAGE);
}

async function settle(
  run: Promise<{ message: string }>,
  send: WsSend,
  action: SignInAction,
  fallback: string,
): Promise<void> {
  try {
    const result = await run;
    reply(send, action, true, result.message);
  } catch (err) {
    if (err instanceof SignInError) {
      reply(send, action, false, err.message);
      return;
    }
    // Unexpected: say what kind only (a message could quote a request).
    console.error(
      `[Pixel Agents] Conductor ${action} failed unexpectedly (${err instanceof Error ? err.name : typeof err}).`,
    );
    reply(send, action, false, fallback);
  }
}

/** The read-only gate's answer: a refusal that settles the card's pending state. */
export function refuseConductorSignInMessage(msg: Record<string, unknown>, send: WsSend): void {
  reply(send, actionOf(msg.type), false, READ_ONLY_MESSAGE);
}
