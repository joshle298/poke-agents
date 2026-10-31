/**
 * The Jukebox's server half: lists the music folder, drives the Music and
 * Spotify apps on macOS, keeps saved links, and opens the music folder.
 *
 * A local nicety for the person at this machine. It never touches Conductor,
 * downloads no audio and runs nothing but the fixed commands in appleScripts.ts
 * and `open`/`xdg-open` on the music folder. Every entry point is reached only
 * through privileged client messages (musicMessages.ts) and the tokened route.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as os from 'os';

import type {
  MusicActionResult,
  MusicCommandAction,
  MusicLibrary,
  MusicSourceId,
  MusicState,
} from '../../../core/src/messages.js';
import { OPEN_COMMAND_TIMEOUT_MS } from '../constants.js';
import type { AppStatus, LibraryAlbum } from './appleScripts.js';
import {
  appleMusicCommand,
  parsePokemonAlbums,
  parseStatus,
  spotifyCommand,
} from './appleScripts.js';
import { LINUX_OPEN_COMMAND, MAC_OPEN_PATH, MUSIC_ID_HEX_LENGTH } from './constants.js';
import { JukeboxError } from './errors.js';
import { displayMusicPath, MusicFolderLibrary } from './folderLibrary.js';
import { parseAppleMusicLink, parseSpotifyLink } from './links.js';
import type { OsaExec } from './macApps.js';
import { defaultOsaExec, defaultPathExists, MacMusicApp } from './macApps.js';
import type { Station } from './stations.js';
import { appleStation, fetchSpotifyTitle, spotifyStation, StationStore } from './stations.js';

/** A musicCommand that passed wire validation (musicMessages.ts). */
export interface MusicCommandInput {
  action: MusicCommandAction;
  source: MusicSourceId;
  stationId?: string;
  uri?: string;
  volume?: number;
  shuffle?: boolean;
}

/** What answers a command: always a result, plus the app state or the library
 *  when the command read or changed them. */
export interface MusicCommandOutcome {
  result: MusicActionResult;
  state?: MusicState;
  library?: MusicLibrary;
}

export interface MusicServiceOptions {
  /** Default ~/.pixel-agents/music. */
  musicDir?: string;
  /** Default ~/.pixel-agents/music.json. */
  stateFile?: string;
  platform?: NodeJS.Platform;
  home?: string;
  /** Runs osascript (tests inject a fake: nothing is ever executed there). */
  exec?: OsaExec;
  pathExists?: (p: string) => Promise<boolean>;
  /** Opens the music folder in the file manager. */
  openFolder?: (dir: string) => Promise<void>;
  /** For Spotify titles (oEmbed). */
  fetch?: typeof fetch;
  /** Pause after a control so the status read sees its effect. */
  settleMs?: number;
  log?: (message: string) => void;
}

/** How long after play/skip the app is given before its state is read. */
const DEFAULT_SETTLE_MS = 400;

interface AppleAlbumEntry extends LibraryAlbum {
  id: string;
}

export class MusicService {
  readonly folder: MusicFolderLibrary;
  private readonly apps: Readonly<Record<'apple' | 'spotify', MacMusicApp>>;
  private readonly stations: StationStore;
  private readonly platform: NodeJS.Platform;
  private readonly openFolderImpl: (dir: string) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly settleMs: number;
  private readonly home: string;
  /** Pokémon albums from the last Music library scan; null until one ran. */
  private appleAlbums: AppleAlbumEntry[] | null = null;

  constructor(options: MusicServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    const home = options.home ?? os.homedir();
    this.home = home;
    const log =
      options.log ?? ((message: string) => console.log(`[Pixel Agents] Jukebox: ${message}`));
    this.folder = new MusicFolderLibrary(options.musicDir);
    this.stations = new StationStore(options.stateFile);
    const deps = {
      platform: this.platform,
      exec: options.exec ?? defaultOsaExec,
      pathExists: options.pathExists ?? defaultPathExists,
      home,
      log,
    };
    this.apps = {
      apple: new MacMusicApp('apple', deps),
      spotify: new MacMusicApp('spotify', deps),
    };
    this.openFolderImpl = options.openFolder ?? ((dir) => openFolderWithSystem(dir, this.platform));
    this.fetchImpl = options.fetch ?? fetch;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  }

  /** The musicLibrary message: folder albums, scanned Music albums, stations,
   *  and which sources work here. */
  async library(): Promise<MusicLibrary> {
    const [scan, apple, spotify] = await Promise.all([
      this.folder.scan(),
      this.apps.apple.availability(),
      this.apps.spotify.availability(),
    ]);
    return {
      type: 'musicLibrary',
      sources: [
        { id: 'folder', available: true },
        { id: 'apple', ...apple },
        { id: 'spotify', ...spotify },
      ],
      folderPath: displayMusicPath(this.folder.root, this.home),
      ...(scan.truncated ? { folderTruncated: true } : {}),
      albums: scan.albums.map((album) => ({
        id: album.id,
        name: album.name,
        tracks: album.tracks.map(({ absPath: _absPath, ...track }) => track),
      })),
      appleAlbums: (this.appleAlbums ?? []).map(({ id, name, artist, trackCount }) => ({
        id,
        name,
        trackCount,
        ...(artist ? { artist } : {}),
      })),
      appleLibraryScanned: this.appleAlbums !== null,
      stations: this.stations
        .list()
        .map(({ id, source, kind, name, url }) => ({ id, source, kind, name, url })),
    };
  }

  /** Carry out one command. Never rejects: failures are a not-ok result. */
  async command(input: MusicCommandInput): Promise<MusicCommandOutcome> {
    try {
      return await this.dispatch(input);
    } catch (err) {
      return { result: this.result(input, false, userMessage(err)) };
    }
  }

  private async dispatch(input: MusicCommandInput): Promise<MusicCommandOutcome> {
    const { action, source } = input;
    if (source === 'folder') {
      if (action !== 'openFolder') {
        throw new UserError('Music folder tracks play in the page.');
      }
      await this.folder.ensureFolder();
      await this.openFolderImpl(this.folder.root);
      return { result: this.result(input, true) };
    }

    const app = this.apps[source];
    switch (action) {
      case 'addStation':
        return this.addStation(input, source);
      case 'removeStation': {
        const station = input.stationId ? this.stations.get(input.stationId) : undefined;
        if (!station || station.source !== source) throw new UserError('That link is not saved.');
        this.stations.remove(station.id);
        return { result: this.result(input, true), library: await this.library() };
      }
      case 'scanLibrary': {
        if (source !== 'apple') throw new UserError('Only the Music app has a library to scan.');
        const output = await app.run(appleMusicCommand('listPokemonAlbums'));
        this.appleAlbums = parsePokemonAlbums(output).map((album) => ({
          ...album,
          id: albumId(album.name),
        }));
        return { result: this.result(input, true), library: await this.library() };
      }
      case 'refresh':
        return { result: this.result(input, true), state: await this.state(source) };
      case 'openFolder':
        throw new UserError('Only the music folder opens.');
      default:
        await app.run(this.controlCommand(input, source));
        if (this.settleMs > 0) await delay(this.settleMs);
        return { result: this.result(input, true), state: await this.state(source) };
    }
  }

  /** The script for play / pause / resume / next / previous / shuffle / volume. */
  private controlCommand(input: MusicCommandInput, source: 'apple' | 'spotify') {
    const { action, shuffle, volume } = input;
    if (action === 'setShuffle' && typeof shuffle !== 'boolean') {
      throw new UserError('Say whether to shuffle.');
    }
    if (action === 'play') return this.playCommand(input, source);
    if (source === 'apple') return appleMusicCommand(action, { shuffle, volume });
    return spotifyCommand(action, { shuffle, volume });
  }

  private playCommand(input: MusicCommandInput, source: 'apple' | 'spotify') {
    const { stationId, shuffle } = input;
    if (source === 'apple') {
      if (stationId === undefined) {
        return appleMusicCommand('playAllPokemon', { shuffle: shuffle ?? true });
      }
      const album = this.appleAlbums?.find((a) => a.id === stationId);
      if (album) return appleMusicCommand('playAlbum', { albumName: album.name, shuffle });
      const station = this.stations.get(stationId);
      if (station?.source === 'apple') {
        return appleMusicCommand('openLocation', { url: station.target });
      }
      throw new UserError('That album is gone. Scan your Music library again.');
    }
    const station = stationId ? this.stations.get(stationId) : undefined;
    if (station?.source !== 'spotify') throw new UserError('Pick a saved Spotify link.');
    return spotifyCommand('playUri', { uri: station.target, shuffle });
  }

  private async addStation(
    input: MusicCommandInput,
    source: 'apple' | 'spotify',
  ): Promise<MusicCommandOutcome> {
    let station: Station;
    if (source === 'spotify') {
      const link = parseSpotifyLink(input.uri);
      if (!link) {
        throw new UserError('Paste an open.spotify.com album, playlist or track link.');
      }
      station = spotifyStation(link, await fetchSpotifyTitle(link, this.fetchImpl));
    } else {
      const link = parseAppleMusicLink(input.uri);
      if (!link) throw new UserError('Paste a music.apple.com album or playlist link.');
      station = appleStation(link);
    }
    this.stations.add(station);
    return { result: this.result(input, true), library: await this.library() };
  }

  /** What the app is playing. Failures are reported in the state, not thrown. */
  private async state(source: 'apple' | 'spotify'): Promise<MusicState> {
    const app = this.apps[source];
    let status: AppStatus;
    try {
      const command = source === 'apple' ? appleMusicCommand('status') : spotifyCommand('status');
      status = parseStatus(await app.run(command));
    } catch (err) {
      return {
        type: 'musicState',
        source,
        running: false,
        playing: false,
        error: userMessage(err),
      };
    }
    return { type: 'musicState', source, ...status };
  }

  private result(input: MusicCommandInput, ok: boolean, message?: string): MusicActionResult {
    return {
      type: 'musicActionResult',
      action: input.action,
      source: input.source,
      ok,
      ...(message ? { message } : {}),
    };
  }
}

/** A failure whose message is meant for the user as is. */
class UserError extends JukeboxError {}

function userMessage(err: unknown): string {
  return err instanceof JukeboxError ? err.message : 'Something went wrong.';
}

function albumId(name: string): string {
  return crypto
    .createHash('sha256')
    .update(`apple-album\0${name}`)
    .digest('hex')
    .slice(0, MUSIC_ID_HEX_LENGTH);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs a program with arguments (execFile, no shell); injected in tests. */
export type RunFile = (file: string, args: string[]) => Promise<void>;

const runFile: RunFile = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: OPEN_COMMAND_TIMEOUT_MS }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

/** Open a folder in the file manager: `/usr/bin/open <dir>` on macOS,
 *  `xdg-open <dir>` on Linux, through execFile (no shell). */
export async function openFolderWithSystem(
  dir: string,
  platform: NodeJS.Platform,
  run: RunFile = runFile,
): Promise<void> {
  const file =
    platform === 'darwin' ? MAC_OPEN_PATH : platform === 'linux' ? LINUX_OPEN_COMMAND : null;
  if (!file) {
    throw new UserError(`Open ${displayMusicPath(dir)} in your file manager to add music.`);
  }
  try {
    await run(file, [dir]);
  } catch {
    throw new UserError(`Couldn't open ${displayMusicPath(dir)}.`);
  }
}
