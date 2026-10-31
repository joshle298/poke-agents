/**
 * The Jukebox's client messages: `requestMusicLibrary` and `musicCommand`.
 * Dispatched from handleClientMessage after its read-only gate, so both are
 * privileged; a read-only office is answered by refuseMusicMessage instead.
 * Replies go to the sender only: what this machine plays is nobody else's view.
 */

import type {
  MusicActionResult,
  MusicCommandAction,
  MusicLibrary,
  MusicSourceId,
} from '../../../core/src/messages.js';
import { MUSIC_LINK_MAX_LENGTH } from './constants.js';
import type { MusicCommandInput, MusicService } from './musicService.js';

type WsSend = (message: Record<string, unknown>) => void;

export const MUSIC_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'requestMusicLibrary',
  'musicCommand',
]);

const ACTIONS: ReadonlySet<string> = new Set<MusicCommandAction>([
  'play',
  'pause',
  'resume',
  'next',
  'previous',
  'setShuffle',
  'setVolume',
  'refresh',
  'scanLibrary',
  'addStation',
  'removeStation',
  'openFolder',
]);
const SOURCES: ReadonlySet<string> = new Set<MusicSourceId>([
  'radio',
  'folder',
  'apple',
  'spotify',
]);
/** Album and station ids as the server mints them. */
const STATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

const NOT_AVAILABLE_MESSAGE = 'The Jukebox is not available here.';
const INVALID_MESSAGE = 'Invalid Jukebox request.';
const READ_ONLY_MESSAGE = 'Read-only office: open the tokened URL to use the Jukebox.';

/** Where the service is missing (VS Code's embedded server): nothing works. */
function unavailableLibrary(): MusicLibrary {
  return {
    type: 'musicLibrary',
    sources: (['radio', 'folder', 'apple', 'spotify'] as const).map((id) => ({
      id,
      available: false,
      reason: NOT_AVAILABLE_MESSAGE,
    })),
    radioTracks: [],
    folderPath: '',
    albums: [],
    appleAlbums: [],
    appleLibraryScanned: false,
    stations: [],
  };
}

/** Validate a musicCommand's fields, or null. */
export function parseMusicCommand(msg: Record<string, unknown>): MusicCommandInput | null {
  const { action, source, stationId, uri, volume, shuffle } = msg;
  if (typeof action !== 'string' || !ACTIONS.has(action)) return null;
  if (typeof source !== 'string' || !SOURCES.has(source)) return null;
  const input: MusicCommandInput = {
    action: action as MusicCommandAction,
    source: source as MusicSourceId,
  };
  if (stationId !== undefined) {
    if (typeof stationId !== 'string' || !STATION_ID_PATTERN.test(stationId)) return null;
    input.stationId = stationId;
  }
  if (uri !== undefined) {
    if (typeof uri !== 'string' || uri.length > MUSIC_LINK_MAX_LENGTH) return null;
    input.uri = uri;
  }
  if (volume !== undefined) {
    if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 100) {
      return null;
    }
    input.volume = volume;
  }
  if (shuffle !== undefined) {
    if (typeof shuffle !== 'boolean') return null;
    input.shuffle = shuffle;
  }
  // What each action needs.
  if (action === 'setVolume' && input.volume === undefined) return null;
  if (action === 'setShuffle' && input.shuffle === undefined) return null;
  if (action === 'addStation' && input.uri === undefined) return null;
  if (action === 'removeStation' && input.stationId === undefined) return null;
  return input;
}

function result(
  action: MusicCommandAction,
  source: MusicSourceId,
  ok: boolean,
  message?: string,
): MusicActionResult {
  return { type: 'musicActionResult', action, source, ok, ...(message ? { message } : {}) };
}

function knownAction(msg: Record<string, unknown>): {
  action: MusicCommandAction;
  source: MusicSourceId;
} | null {
  const { action, source } = msg;
  if (typeof action !== 'string' || !ACTIONS.has(action)) return null;
  if (typeof source !== 'string' || !SOURCES.has(source)) return null;
  return { action: action as MusicCommandAction, source: source as MusicSourceId };
}

export function handleMusicMessage(
  msg: Record<string, unknown>,
  send: WsSend,
  music: MusicService | undefined,
): void {
  if (msg.type === 'requestMusicLibrary') {
    if (!music) {
      send({ ...unavailableLibrary() });
      return;
    }
    void music.library().then(
      (library) => send({ ...library }),
      (err: unknown) =>
        console.error(
          `[Pixel Agents] Jukebox library failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
    );
    return;
  }

  if (msg.type !== 'musicCommand') return;
  const input = parseMusicCommand(msg);
  if (!input) {
    const known = knownAction(msg);
    if (known) send({ ...result(known.action, known.source, false, INVALID_MESSAGE) });
    return;
  }
  if (!music) {
    send({ ...result(input.action, input.source, false, NOT_AVAILABLE_MESSAGE) });
    return;
  }
  void music.command(input).then((outcome) => {
    send({ ...outcome.result });
    if (outcome.state) send({ ...outcome.state });
    if (outcome.library) send({ ...outcome.library });
  });
}

/** The read-only gate's answer: a command gets a refusal (so a pending control
 *  settles); a library request gets nothing (a read-only office has no Jukebox). */
export function refuseMusicMessage(msg: Record<string, unknown>, send: WsSend): void {
  if (msg.type !== 'musicCommand') return;
  const known = knownAction(msg);
  if (known) send({ ...result(known.action, known.source, false, READ_ONLY_MESSAGE) });
}
