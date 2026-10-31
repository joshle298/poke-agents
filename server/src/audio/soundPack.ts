/**
 * The user's sound pack: `~/.pixel-agents/sounds/<event>.(ogg|mp3|wav)`
 * replaces the office's synthesized effect for that event.
 *
 * Only the allowlisted event names and formats are ever opened, from that
 * one directory, as regular files (never through a symlink), up to
 * SOUND_PACK_MAX_BYTES, and only when the first bytes match the format.
 * The files are the user's own; nothing here downloads or writes anything.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from '../constants.js';
import {
  AUDIO_CONTENT_TYPES,
  AUDIO_SIGNATURE_BYTES,
  type AudioFormat,
  sniffAudioFormat,
} from './audioSignature.js';
import {
  SOUND_PACK_DIR_NAME,
  SOUND_PACK_EVENTS,
  SOUND_PACK_FORMATS,
  SOUND_PACK_MAX_BYTES,
} from './constants.js';

export type SoundPackEvent = (typeof SOUND_PACK_EVENTS)[number];
export type SoundPackFormat = (typeof SOUND_PACK_FORMATS)[number];

/** One override, as listed to the office. */
export interface SoundPackOverride {
  event: SoundPackEvent;
  format: SoundPackFormat;
  size: number;
  /** Changes when the file is replaced; the office re-fetches on a new one. */
  version: string;
}

/** An override opened for streaming. The caller owns `handle`. */
export interface OpenSoundPackFile extends SoundPackOverride {
  contentType: string;
  handle: fs.promises.FileHandle;
}

const EVENT_SET: ReadonlySet<string> = new Set(SOUND_PACK_EVENTS);
/** O_NOFOLLOW where the platform has it (not Windows), so a file swapped
 *  for a symlink after the directory check still isn't followed. */
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

export function defaultSoundPackDir(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, SOUND_PACK_DIR_NAME);
}

export function isSoundPackEvent(name: string): name is SoundPackEvent {
  return EVENT_SET.has(name);
}

/** True when `head` (the file's first bytes) starts like `format`. */
export function hasAudioSignature(format: AudioFormat, head: Buffer): boolean {
  return sniffAudioFormat(head) === format;
}

/**
 * Open the override for `event` (first format that exists and passes the
 * checks), or null. The returned handle must be closed by the caller
 * (streaming it with autoClose does that).
 */
export async function openSoundPackFile(
  dir: string,
  event: string,
): Promise<OpenSoundPackFile | null> {
  if (!isSoundPackEvent(event)) return null;
  const root = path.resolve(dir);
  for (const ext of SOUND_PACK_FORMATS) {
    const abs = path.resolve(root, `${event}.${ext}`);
    if (path.dirname(abs) !== root) continue;
    let handle: fs.promises.FileHandle;
    try {
      // lstat first: refuse links outright (O_NOFOLLOW is the race guard).
      if (!(await fs.promises.lstat(abs)).isFile()) continue;
      handle = await fs.promises.open(abs, OPEN_FLAGS);
    } catch {
      continue;
    }
    try {
      const stat = await handle.stat();
      if (stat.isFile() && stat.size > 0 && stat.size <= SOUND_PACK_MAX_BYTES) {
        const head = Buffer.alloc(AUDIO_SIGNATURE_BYTES);
        const { bytesRead } = await handle.read(head, 0, AUDIO_SIGNATURE_BYTES, 0);
        if (hasAudioSignature(ext, head.subarray(0, bytesRead))) {
          return {
            event,
            format: ext,
            contentType: AUDIO_CONTENT_TYPES[ext],
            size: stat.size,
            version: `${stat.size}-${Math.floor(stat.mtimeMs)}`,
            handle,
          };
        }
      }
    } catch {
      /* unreadable: try the next format */
    }
    await handle.close().catch(() => undefined);
  }
  return null;
}

/** Every override that would be served, in SOUND_PACK_EVENTS order. */
export async function listSoundPack(dir: string): Promise<SoundPackOverride[]> {
  const found: SoundPackOverride[] = [];
  for (const event of SOUND_PACK_EVENTS) {
    const file = await openSoundPackFile(dir, event);
    if (!file) continue;
    await file.handle.close().catch(() => undefined);
    found.push({ event: file.event, format: file.format, size: file.size, version: file.version });
  }
  return found;
}
