/**
 * The Jukebox's outgoing messages. Both are privileged: a read-only office
 * never mounts the Jukebox, and the server refuses them anyway.
 */

import type { MusicCommand } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import { musicStore } from './musicStore.js';

export function requestMusicLibrary(): void {
  transport.send({ type: 'requestMusicLibrary' });
}

/** Send a command; everything but a status refresh shows as pending until its
 *  result arrives. */
export function sendMusicCommand(command: Omit<MusicCommand, 'type'>): void {
  if (command.action !== 'refresh') musicStore.markPending(command.source, command.action);
  transport.send({ type: 'musicCommand', ...command });
}
