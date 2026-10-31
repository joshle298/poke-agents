/**
 * The Conductor chrome's outgoing messages. Every one is privileged: a
 * read-only office never shows the controls that send them, and the server
 * refuses them anyway (re-sending the real state where the UI was
 * optimistic).
 */

import type { ConductorScope } from '../../../core/src/messages.js';
import { CONDUCTOR_REVIVE_MESSAGE } from '../constants.js';
import { transport } from '../transport/index.js';
import { conductorStore } from './conductorStore.js';
import { isConductorDeepLink } from './format.js';

/** Open a session in the Conductor app. Returns false (and sends nothing)
 *  for anything but a conductor://workspace deep link. */
export function openInConductor(url: string | undefined): boolean {
  if (!isConductorDeepLink(url)) return false;
  transport.send({ type: 'openExternal', url });
  return true;
}

export function requestSessionDetail(id: number): void {
  transport.send({ type: 'requestSessionDetail', id });
}

/** Ask for the next older page of an agent's conversation, or the newest
 *  page when the chat view has none yet. */
export function requestSessionHistory(id: number): void {
  const cursor = conductorStore.getState().chatHistories[id]?.cursor;
  conductorStore.noteHistoryRequest(id);
  transport.send(
    cursor
      ? { type: 'requestSessionHistory', id, before: cursor }
      : { type: 'requestSessionHistory', id },
  );
}

export function requestConductorSessions(): void {
  transport.send({ type: 'requestConductorSessions' });
}

export function sendSessionMessage(id: number, text: string): void {
  transport.send({ type: 'sendSessionMessage', id, text });
}

/** Revive a fainted (errored) session: nudge it to carry on. */
export function reviveSession(id: number): void {
  sendSessionMessage(id, CONDUCTOR_REVIVE_MESSAGE);
}

export function stopSession(id: number): void {
  transport.send({ type: 'stopSession', id });
}

export function archiveSession(sessionId: string): void {
  transport.send({ type: 'archiveSession', sessionId });
}

export function restoreSession(sessionId: string): void {
  transport.send({ type: 'restoreSession', sessionId });
}

export function setSessionHidden(sessionId: string, hidden: boolean): void {
  conductorStore.patchSession(sessionId, { hidden });
  transport.send({ type: 'setSessionHidden', sessionId, hidden });
}

export function setSessionPinned(sessionId: string, pinned: boolean): void {
  conductorStore.patchSession(sessionId, { pinned });
  transport.send({ type: 'setSessionPinned', sessionId, pinned });
}

export function setConductorScope(scope: ConductorScope): void {
  transport.send({ type: 'setConductorScope', scope });
}

export function setPokemonTheme(enabled: boolean): void {
  conductorStore.setPokemonTheme(enabled);
  transport.send({ type: 'setPokemonTheme', enabled });
}

/** Connect this office to Conductor with a pasted API key. The answer is a
 *  conductorActionResult (action `connect`) that never carries the key. */
export function connectConductor(apiKey: string): void {
  transport.send({ type: 'connectConductor', apiKey });
}

/** Forget the key Poke Agents saved (never the Conductor CLI's sign-in). */
export function disconnectConductor(): void {
  transport.send({ type: 'disconnectConductor' });
}
