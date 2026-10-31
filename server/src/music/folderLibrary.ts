/**
 * The Jukebox's music folder: `~/.pixel-agents/music/`, one subfolder per game
 * or album ("Pokémon X & Y/03 - Title.m4a"), holding audio files the user owns.
 *
 * A scan lists albums and tracks with titles read from file names. Nothing
 * outside the folder is ever listed or served: symlinks are followed only when
 * their target resolves inside the folder, and the route serves a track only by
 * an id from the latest scan, re-checking the resolved path when it opens it.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from '../constants.js';
import {
  MUSIC_AUDIO_TYPES,
  MUSIC_DIR_NAME,
  MUSIC_DISC_FOLDER_PATTERN,
  MUSIC_ID_HEX_LENGTH,
  MUSIC_LOOSE_TRACKS_ALBUM,
  MUSIC_SCAN_MAX_DEPTH,
  MUSIC_SCAN_MAX_ENTRIES,
  MUSIC_SCAN_MAX_TRACKS,
  MUSIC_SCAN_REUSE_MS,
} from './constants.js';

export interface FolderTrackEntry {
  id: string;
  title: string;
  trackNumber?: number;
  discNumber?: number;
  mimeType: string;
  /** Resolved path inside the music folder. Never sent to a client. */
  absPath: string;
}

export interface FolderAlbumEntry {
  id: string;
  name: string;
  tracks: FolderTrackEntry[];
}

export interface FolderScan {
  /** The folder exists (and is a folder). */
  exists: boolean;
  albums: FolderAlbumEntry[];
  /** More files or folders than one scan lists. */
  truncated: boolean;
}

export interface ScanLimits {
  maxDepth: number;
  maxTracks: number;
  maxEntries: number;
}

const DEFAULT_LIMITS: ScanLimits = {
  maxDepth: MUSIC_SCAN_MAX_DEPTH,
  maxTracks: MUSIC_SCAN_MAX_TRACKS,
  maxEntries: MUSIC_SCAN_MAX_ENTRIES,
};

/** `~/.pixel-agents/music`. */
export function defaultMusicDir(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, MUSIC_DIR_NAME);
}

/** The folder as shown to the user, with `~` for the home directory. */
export function displayMusicPath(dir: string, home: string = os.homedir()): string {
  if (home && (dir === home || dir.startsWith(home + path.sep))) {
    return `~${dir.slice(home.length)}`;
  }
  return dir;
}

/** The Content-Type a file is served as, or undefined when the folder source
 *  does not list that kind of file. */
export function audioMimeType(fileName: string): string | undefined {
  const ext = path.extname(fileName).toLowerCase();
  return Object.prototype.hasOwnProperty.call(MUSIC_AUDIO_TYPES, ext)
    ? MUSIC_AUDIO_TYPES[ext]
    : undefined;
}

// Track-number prefixes as rippers and stores write them:
// "1-03 Title" (iTunes, disc 1 track 3), "03 - Title", "03. Title", "03 Title".
const DISC_TRACK_PREFIX = /^(\d{1,2})-(\d{1,3})[\s._-]+(.+)$/;
const TRACK_PREFIX = /^(\d{1,3})(?:\s*[-._)]\s*|\s+)(.+)$/;

/** Title, track and disc numbers from a file name without its extension. */
export function parseTrackFileName(baseName: string): {
  title: string;
  trackNumber?: number;
  discNumber?: number;
} {
  const name = baseName.normalize('NFC').trim();
  let title = name;
  let trackNumber: number | undefined;
  let discNumber: number | undefined;
  const discTrack = DISC_TRACK_PREFIX.exec(name);
  const track = discTrack ? null : TRACK_PREFIX.exec(name);
  if (discTrack) {
    discNumber = Number(discTrack[1]);
    trackNumber = Number(discTrack[2]);
    title = discTrack[3];
  } else if (track) {
    trackNumber = Number(track[1]);
    title = track[2];
  }
  // snake_case file names read better with spaces.
  if (!title.includes(' ')) title = title.replace(/_+/g, ' ');
  title = title.trim() || name;
  return {
    title,
    ...(trackNumber !== undefined ? { trackNumber } : {}),
    ...(discNumber !== undefined ? { discNumber } : {}),
  };
}

function hashId(kind: string, relPath: string): string {
  return crypto
    .createHash('sha256')
    .update(`${kind}\0${relPath}`)
    .digest('hex')
    .slice(0, MUSIC_ID_HEX_LENGTH);
}

/** Strictly inside `root` (both resolved). */
export function isInsideDir(root: string, candidate: string): boolean {
  return candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

interface FoundFile {
  absPath: string;
  fileName: string;
  mimeType: string;
  /** Folder names from the music folder down to the file's folder. */
  segments: string[];
}

const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * List the albums and tracks under `root`. Never throws: a missing or
 * unreadable folder is an empty library.
 */
export async function scanMusicFolder(
  root: string,
  limits: ScanLimits = DEFAULT_LIMITS,
): Promise<FolderScan> {
  let rootReal: string;
  try {
    rootReal = await fs.promises.realpath(root);
    if (!(await fs.promises.stat(rootReal)).isDirectory()) {
      return { exists: false, albums: [], truncated: false };
    }
  } catch {
    return { exists: false, albums: [], truncated: false };
  }

  const found: FoundFile[] = [];
  const visitedDirs = new Set<string>([rootReal]);
  let entries = 0;
  let truncated = false;

  const walk = async (dirReal: string, segments: string[]): Promise<void> => {
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dirReal, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => NAME_COLLATOR.compare(a.name, b.name));
    for (const dirent of dirents) {
      if (truncated) return;
      if (++entries > limits.maxEntries) {
        truncated = true;
        return;
      }
      if (dirent.name.startsWith('.')) continue;
      let real = path.join(dirReal, dirent.name);
      let isDir = dirent.isDirectory();
      let isFile = dirent.isFile();
      if (dirent.isSymbolicLink()) {
        // Followed only when the target stays inside the music folder.
        try {
          real = await fs.promises.realpath(real);
          if (!isInsideDir(rootReal, real)) continue;
          const stat = await fs.promises.stat(real);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (segments.length >= limits.maxDepth || visitedDirs.has(real)) continue;
        visitedDirs.add(real);
        await walk(real, [...segments, dirent.name]);
      } else if (isFile) {
        // By the resolved name: a link called song.mp3 to notes.txt is no track.
        const mimeType = audioMimeType(real);
        if (!mimeType) continue;
        if (found.length >= limits.maxTracks) {
          truncated = true;
          return;
        }
        found.push({ absPath: real, fileName: dirent.name, mimeType, segments });
      }
    }
  };
  await walk(rootReal, []);

  return { exists: true, albums: groupAlbums(found), truncated };
}

function groupAlbums(files: FoundFile[]): FolderAlbumEntry[] {
  const groups = new Map<string, { segments: string[]; tracks: FolderTrackEntry[] }>();
  for (const file of files) {
    // "Album/Disc 2/..." belongs to "Album", as disc 2.
    const last = file.segments[file.segments.length - 1];
    const discMatch =
      file.segments.length >= 2 && last !== undefined ? MUSIC_DISC_FOLDER_PATTERN.exec(last) : null;
    const albumSegments = discMatch ? file.segments.slice(0, -1) : file.segments;
    const key = albumSegments.join('/');
    const parsed = parseTrackFileName(path.basename(file.fileName, path.extname(file.fileName)));
    const discNumber = discMatch ? Number(discMatch[1]) : parsed.discNumber;
    const track: FolderTrackEntry = {
      id: hashId('track', [...file.segments, file.fileName].join('/')),
      title: parsed.title,
      ...(parsed.trackNumber !== undefined ? { trackNumber: parsed.trackNumber } : {}),
      ...(discNumber !== undefined ? { discNumber } : {}),
      mimeType: file.mimeType,
      absPath: file.absPath,
    };
    const group = groups.get(key) ?? { segments: albumSegments, tracks: [] };
    group.tracks.push(track);
    groups.set(key, group);
  }

  const leafName = (segments: string[]) =>
    segments.length === 0
      ? MUSIC_LOOSE_TRACKS_ALBUM
      : segments[segments.length - 1].normalize('NFC');
  const leafCounts = new Map<string, number>();
  for (const { segments } of groups.values()) {
    const name = leafName(segments);
    leafCounts.set(name, (leafCounts.get(name) ?? 0) + 1);
  }

  const albums: FolderAlbumEntry[] = [];
  for (const [key, { segments, tracks }] of groups) {
    const leaf = leafName(segments);
    // Two "OST" folders under different games keep their parents in the name.
    const name =
      (leafCounts.get(leaf) ?? 0) > 1 && segments.length > 1
        ? segments.map((s) => s.normalize('NFC')).join(' / ')
        : leaf;
    tracks.sort(
      (a, b) =>
        (a.discNumber ?? 1) - (b.discNumber ?? 1) ||
        (a.trackNumber ?? Number.MAX_SAFE_INTEGER) - (b.trackNumber ?? Number.MAX_SAFE_INTEGER) ||
        NAME_COLLATOR.compare(a.title, b.title),
    );
    albums.push({ id: hashId('album', key), name, tracks });
  }
  albums.sort((a, b) => NAME_COLLATOR.compare(a.name, b.name));
  return albums;
}

/** An opened track, ready to stream. The caller closes `handle`. */
export interface OpenedTrack {
  handle: fs.promises.FileHandle;
  size: number;
  mimeType: string;
}

/**
 * The music folder with its latest scan cached, so the route can resolve ids
 * without walking the tree on every request.
 */
export class MusicFolderLibrary {
  private last: { at: number; scan: FolderScan; byId: Map<string, FolderTrackEntry> } | null = null;
  private inflight: Promise<FolderScan> | null = null;
  /** Absolute, so it can be handed to `open` as an argument. */
  readonly root: string;

  constructor(
    root: string = defaultMusicDir(),
    private readonly limits: ScanLimits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    this.root = path.resolve(root);
  }

  /** The latest scan when it is younger than `maxAgeMs`, else a fresh one. */
  async scan(maxAgeMs: number = MUSIC_SCAN_REUSE_MS): Promise<FolderScan> {
    if (this.last && this.now() - this.last.at < maxAgeMs) return this.last.scan;
    if (!this.inflight) {
      this.inflight = scanMusicFolder(this.root, this.limits)
        .then((scan) => {
          const byId = new Map<string, FolderTrackEntry>();
          for (const album of scan.albums) for (const t of album.tracks) byId.set(t.id, t);
          this.last = { at: this.now(), scan, byId };
          return scan;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  /** Create the folder (so "Open folder" has something to open). */
  async ensureFolder(): Promise<void> {
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o755 });
  }

  /**
   * Open a track by id for streaming, or null. The id must come from a scan,
   * and the file must still resolve inside the music folder to an audio file.
   */
  async openTrack(id: string): Promise<OpenedTrack | null> {
    let entry = (await this.lookup(id)) ?? null;
    if (!entry && this.last && this.now() - this.last.at >= MUSIC_SCAN_REUSE_MS) {
      // The client may know a newer folder than our last scan.
      await this.scan(0);
      entry = this.last?.byId.get(id) ?? null;
    }
    if (!entry) return null;
    try {
      const rootReal = await fs.promises.realpath(this.root);
      const real = await fs.promises.realpath(entry.absPath);
      const mimeType = audioMimeType(real);
      if (!isInsideDir(rootReal, real) || !mimeType) return null;
      // `real` has no symlink left in it, so a link at its end can only be a
      // file swapped for one since the realpath: refuse it (O_NOFOLLOW).
      const handle = await fs.promises.open(
        real,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          await handle.close();
          return null;
        }
        return { handle, size: stat.size, mimeType };
      } catch {
        await handle.close();
        return null;
      }
    } catch {
      return null;
    }
  }

  private async lookup(id: string): Promise<FolderTrackEntry | undefined> {
    if (!this.last) await this.scan();
    return this.last?.byId.get(id);
  }
}
