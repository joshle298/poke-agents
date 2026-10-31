/**
 * Runs the Jukebox's fixed AppleScripts (appleScripts.ts) against the Music and
 * Spotify apps: `execFile('/usr/bin/osascript', ['-e', script, ...args])`, no
 * shell, macOS only, and only when the app is installed. Errors become short
 * user-facing messages; the raw osascript output is only logged.
 *
 * The first command macOS sees from this process asks the user to allow
 * Automation of the app (System Settings › Privacy & Security › Automation);
 * a refusal is error -1743, reported as "not authorized".
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { MusicAppId, OsaCommand } from './appleScripts.js';
import {
  JUKEBOX_PLAYLIST_NAME,
  SCRIPT_ERROR_ALBUM_GONE,
  SCRIPT_ERROR_PLAYLIST_TAKEN,
} from './appleScripts.js';
import {
  MUSIC_APP_PATHS,
  OSASCRIPT_MAX_BUFFER_BYTES,
  OSASCRIPT_PATH,
  SPOTIFY_APP_PATHS,
} from './constants.js';
import { JukeboxError } from './errors.js';

export interface OsaExecResult {
  stdout: string;
  stderr: string;
}

/** `execFile` as the Jukebox uses it; injected in tests so nothing ever runs. */
export type OsaExec = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<OsaExecResult>;

export const defaultOsaExec: OsaExec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });

export async function defaultPathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export type MusicAppErrorKind =
  | 'unsupported'
  | 'notInstalled'
  | 'notAuthorized'
  | 'notRunning'
  | 'timeout'
  | 'albumGone'
  | 'playlistTaken'
  | 'failed';

export class MusicAppError extends JukeboxError {
  constructor(
    readonly kind: MusicAppErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export const MUSIC_APP_NAMES: Readonly<Record<MusicAppId, string>> = {
  apple: 'Music',
  spotify: 'Spotify',
};

const OSA_ERROR_CODE = /\((-?\d+)\)\s*$/;

/** The AppleScript error number in osascript's stderr ("... (-1743)"). */
export function osaErrorNumber(stderr: string): number | undefined {
  const match = OSA_ERROR_CODE.exec(stderr.trim());
  return match ? Number(match[1]) : undefined;
}

/** A failed osascript run as a user-facing error. */
export function mapOsaError(app: MusicAppId, err: unknown): MusicAppError {
  const name = MUSIC_APP_NAMES[app];
  const e = (err ?? {}) as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown };
  if (e.code === 'ENOENT') {
    return new MusicAppError('unsupported', 'AppleScript (osascript) is not available here.');
  }
  if (e.killed || e.signal === 'SIGTERM') {
    return new MusicAppError('timeout', `${name} didn't answer in time.`);
  }
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  switch (osaErrorNumber(stderr)) {
    case -1743:
      return new MusicAppError(
        'notAuthorized',
        `Allow control of ${name}: System Settings › Privacy & Security › Automation (for your terminal or Poke Agents).`,
      );
    case -600:
    case -609:
      return new MusicAppError('notRunning', `${name} isn't running.`);
    case -10814:
    case -2700:
      return new MusicAppError('notInstalled', `${name} isn't installed.`);
    case -128:
      return new MusicAppError('failed', 'Cancelled.');
    case SCRIPT_ERROR_ALBUM_GONE:
      return new MusicAppError('albumGone', 'No matching tracks in your Music library.');
    case SCRIPT_ERROR_PLAYLIST_TAKEN:
      return new MusicAppError(
        'playlistTaken',
        `A playlist named "${JUKEBOX_PLAYLIST_NAME}" already exists in Music. Rename it so the Jukebox can queue albums.`,
      );
    default:
      return new MusicAppError('failed', `${name} couldn't do that.`);
  }
}

export interface MacMusicAppDeps {
  platform: NodeJS.Platform;
  exec: OsaExec;
  pathExists: (p: string) => Promise<boolean>;
  home: string;
  log: (message: string) => void;
}

export interface Availability {
  available: boolean;
  reason?: string;
}

/** One app (Music or Spotify) the Jukebox may drive. */
export class MacMusicApp {
  constructor(
    readonly id: MusicAppId,
    private readonly deps: MacMusicAppDeps,
  ) {}

  get displayName(): string {
    return MUSIC_APP_NAMES[this.id];
  }

  async availability(): Promise<Availability> {
    if (this.deps.platform !== 'darwin') {
      return { available: false, reason: `${this.displayName} control needs macOS.` };
    }
    const candidates = this.id === 'apple' ? MUSIC_APP_PATHS : SPOTIFY_APP_PATHS;
    for (const candidate of candidates) {
      const abs = candidate.startsWith('~/')
        ? path.join(this.deps.home, candidate.slice(2))
        : candidate;
      if (await this.deps.pathExists(abs)) return { available: true };
    }
    return { available: false, reason: `${this.displayName} isn't installed.` };
  }

  /** Run one built command and return what the script printed. */
  async run(command: OsaCommand): Promise<string> {
    const availability = await this.availability();
    if (!availability.available) {
      throw new MusicAppError(
        this.deps.platform === 'darwin' ? 'notInstalled' : 'unsupported',
        availability.reason ?? `${this.displayName} isn't available.`,
      );
    }
    try {
      const { stdout } = await this.deps.exec(
        OSASCRIPT_PATH,
        ['-e', command.script, ...command.args],
        { timeout: command.timeoutMs, maxBuffer: OSASCRIPT_MAX_BUFFER_BYTES },
      );
      return stdout;
    } catch (err) {
      const mapped = mapOsaError(this.id, err);
      const stderr = (err as { stderr?: unknown } | null)?.stderr;
      this.deps.log(
        `${this.displayName} script failed (${mapped.kind})${typeof stderr === 'string' && stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      );
      throw mapped;
    }
  }
}
