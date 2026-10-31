/**
 * What the app says around Reconnect to Conductor. Pure: main.ts shows the
 * dialogs.
 *
 * After a reconnect the user asked for, the office's next settled
 * `conductorStatus` says whether it worked. Signed in: sessions walk in, and
 * nothing more is needed. Still no sign-in, or rejected: the office's card
 * looks the same as before the click, so a dialog says so and what to do.
 */

/** Where a reconnect stands, from one office message. */
export type ReconnectOutcome = 'pending' | 'signedIn' | 'noSignIn' | 'rejected' | 'unreachable';

export interface DialogText {
  message: string;
  detail: string;
}

/** The outcome a message reports, or null when it isn't a Conductor status. */
export function reconnectOutcome(message: unknown): ReconnectOutcome | null {
  if (message === null || typeof message !== 'object') return null;
  const status = message as Record<string, unknown>;
  if (status.type !== 'conductorStatus') return null;
  switch (status.state) {
    case 'connected':
      return 'signedIn';
    case 'authRequired':
      return 'noSignIn';
    case 'unauthorized':
      return 'rejected';
    case 'unreachable':
    case 'rateLimited':
      return 'unreachable';
    default:
      return 'pending';
  }
}

/** The dialog after a reconnect that still can't sign in; null otherwise. */
export function reconnectFeedback(outcome: ReconnectOutcome): DialogText | null {
  switch (outcome) {
    case 'noSignIn':
      return {
        message: 'Still no Conductor sign-in',
        detail:
          'Run conductor auth login in Terminal, then reconnect. If macOS asks to use the Keychain, choose Allow.',
      };
    case 'rejected':
      return {
        message: 'Conductor rejected the sign-in',
        detail: 'Run conductor auth login in Terminal again, then reconnect.',
      };
    default:
      return null;
  }
}

/** Reconnect while the app shows an office that `npm start` serves: only
 *  that process can re-read the sign-in. */
export const ATTACHED_RECONNECT: DialogText = {
  message: 'This office runs in Terminal',
  detail:
    'Poke Agents is showing the office that npm start runs. To reconnect to Conductor, stop it in Terminal with Control-C and start it again. Poke Agents then runs the office itself.',
};
