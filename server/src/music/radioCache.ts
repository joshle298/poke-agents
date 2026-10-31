/**
 * Poke Agents Radio's download cache, ~/.pixel-agents/cache/music/radio/:
 *
 *   radio-my-street.ogg   one file per track, exactly as its author published it
 *
 * A track is downloaded the first time the office asks the track route for it
 * (as it starts or buffers that track), from the URL in the checksum manifest
 * (radioCatalog.ts), and kept only when its size and SHA-256 match the
 * manifest. Nothing else is ever fetched or served: ids outside the manifest
 * are unknown, paths are built from manifest file names only, and a cached
 * file is hashed again (once per process, and whenever it changes) before it
 * is served, so a corrupted or replaced file is downloaded afresh instead.
 *
 * Fetches are single-flight per track, at most RADIO_FETCH_CONCURRENCY at
 * once, time-limited and capped at the manifest's size. Writes are atomic. A
 * failed download (offline, a changed upstream file) backs off, doubling per
 * consecutive failure. While the radio is off (radioSwitch.ts) nothing is
 * downloaded or served.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from '../constants.js';
import { discardBody, readCapped, statFile, writeAtomic } from '../pokemon/pmdCache.js';
import {
  RADIO_CACHE_SUBDIR,
  RADIO_FAILURE_BACKOFF_MAX_MS,
  RADIO_FAILURE_BACKOFF_MS,
  RADIO_FETCH_CONCURRENCY,
  RADIO_FETCH_TIMEOUT_MS,
  RADIO_ID_MAX_LENGTH,
  RADIO_ID_PATTERN,
} from './constants.js';
import type { OpenedTrack } from './folderLibrary.js';
import { buildRadioCatalog, type RadioTrack } from './radioCatalog.js';
import { radioOffReason } from './radioSwitch.js';

/** The subset of `fetch` the cache uses, so tests can inject a fake. */
export type RadioFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

export interface RadioCacheOptions {
  /** Cache directory. Default ~/.pixel-agents/cache/music/radio. */
  root?: string;
  fetch?: RadioFetch;
  /** The station's tracks. Default: the committed catalog. */
  tracks?: readonly RadioTrack[];
  /** Why the radio is off, or null while it may play. Default: the radio switch. */
  offReason?: () => string | null;
  now?: () => number;
  timeoutMs?: number;
  concurrency?: number;
  failureBackoffMs?: number;
  failureBackoffMaxMs?: number;
  log?: (message: string) => void;
}

/** A radio track id as the route sees it (a shape check, not catalog membership). */
export function isRadioTrackId(id: string): boolean {
  return id.length <= RADIO_ID_MAX_LENGTH && RADIO_ID_PATTERN.test(id);
}

export function defaultRadioCacheRoot(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, ...RADIO_CACHE_SUBDIR);
}

/** Lower-case hex SHA-256 of a file, streamed. */
async function hashFile(abs: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(abs)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export class RadioCache {
  readonly root: string;
  readonly tracks: readonly RadioTrack[];
  private readonly byId: ReadonlyMap<string, RadioTrack>;
  private readonly fetchFn: RadioFetch;
  private readonly offReasonFn: () => string | null;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly failureBackoffMs: number;
  private readonly failureBackoffMaxMs: number;
  private readonly log: (message: string) => void;
  private readonly userAgent = `poke-agents/${process.env.PIXEL_AGENTS_VERSION || 'dev'}`;

  private readonly inflight = new Map<string, Promise<string | null>>();
  /** id -> the `size:mtime:ino` of the cached file whose hash matched. */
  private readonly verified = new Map<string, string>();
  /** id -> consecutive failures and the epoch ms before which none is retried. */
  private readonly failures = new Map<string, { count: number; until: number }>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: RadioCacheOptions = {}) {
    this.root = path.resolve(options.root ?? defaultRadioCacheRoot());
    this.tracks = options.tracks ?? buildRadioCatalog();
    this.byId = new Map(this.tracks.map((t) => [t.id, t]));
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.offReasonFn = options.offReason ?? radioOffReason;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? RADIO_FETCH_TIMEOUT_MS;
    this.concurrency = Math.max(1, options.concurrency ?? RADIO_FETCH_CONCURRENCY);
    this.failureBackoffMs = options.failureBackoffMs ?? RADIO_FAILURE_BACKOFF_MS;
    this.failureBackoffMaxMs = options.failureBackoffMaxMs ?? RADIO_FAILURE_BACKOFF_MAX_MS;
    this.log = options.log ?? ((message) => console.warn(`[Pixel Agents] Radio: ${message}`));
  }

  /** Why the radio is off, or null while it may play. */
  offReason(): string | null {
    return this.offReasonFn();
  }

  /** Where a catalog track is cached; null for anything else. The root check
   *  backs up the id pattern, which already rules out separators. */
  pathFor(id: string): string | null {
    const track = isRadioTrackId(id) ? this.byId.get(id) : undefined;
    if (!track) return null;
    const abs = path.resolve(this.root, track.fileName);
    return abs.startsWith(this.root + path.sep) ? abs : null;
  }

  /**
   * Make sure a catalog track is cached and matches its checksum, downloading
   * it if needed. Resolves to its path, or null (radio off, unknown id, or no
   * verified copy). Never rejects.
   */
  ensureTrack(id: string): Promise<string | null> {
    if (this.offReason() !== null) return Promise.resolve(null);
    const track = isRadioTrackId(id) ? this.byId.get(id) : undefined;
    if (!track) return Promise.resolve(null);
    const existing = this.inflight.get(id);
    if (existing) return existing;
    const pending = this.resolveTrack(track)
      .catch((err: unknown) => {
        this.log(`${id} failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      })
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, pending);
    return pending;
  }

  /** Open a catalog track for streaming (downloading it first if needed), or
   *  null. The caller closes `handle`. */
  async openTrack(id: string): Promise<OpenedTrack | null> {
    const abs = await this.ensureTrack(id);
    const track = this.byId.get(id);
    if (!abs || !track) return null;
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch {
      return null;
    }
    try {
      const stat = await handle.stat();
      if (stat.isFile() && stat.size === track.bytes) {
        return { handle, size: stat.size, mimeType: track.mimeType };
      }
    } catch {
      // Fall through: not servable.
    }
    await handle.close();
    return null;
  }

  private async resolveTrack(track: RadioTrack): Promise<string | null> {
    const abs = this.pathFor(track.id);
    if (!abs) return null;
    if (await this.cachedCopyMatches(track, abs)) return abs;
    if ((this.failures.get(track.id)?.until ?? 0) > this.now()) return null;

    const bytes = await this.withSlot(() => this.download(track));
    if (!bytes) {
      this.recordFailure(track.id);
      return null;
    }
    await writeAtomic(abs, bytes);
    this.failures.delete(track.id);
    const stat = await statFile(abs);
    if (stat) this.verified.set(track.id, fileKey(stat));
    return abs;
  }

  /** The cached copy is the manifest's file. A copy of the wrong size or hash
   *  is deleted, so it is downloaded again. */
  private async cachedCopyMatches(track: RadioTrack, abs: string): Promise<boolean> {
    const stat = await statFile(abs);
    if (!stat) return false;
    const key = fileKey(stat);
    if (this.verified.get(track.id) === key) return true;
    this.verified.delete(track.id);
    if (stat.size === track.bytes && (await hashFile(abs)) === track.sha256) {
      this.verified.set(track.id, key);
      return true;
    }
    this.log(`the cached ${track.fileName} doesn't match its checksum; downloading it again.`);
    await fs.promises.rm(abs, { force: true });
    return false;
  }

  /** The track's bytes when they are exactly the manifest's file, else null. */
  private async download(track: RadioTrack): Promise<Buffer | null> {
    let res: Response;
    try {
      res = await this.fetchFn(track.url, {
        headers: { 'user-agent': this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return null;
    }
    if (res.status !== 200) {
      await discardBody(res);
      this.log(`${track.id}: ${track.url} answered ${res.status}.`);
      return null;
    }
    const bytes = await readCapped(res, track.bytes);
    if (!bytes) {
      this.log(`${track.id}: the download was larger than ${track.bytes} bytes or broke off.`);
      return null;
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== track.bytes || sha256 !== track.sha256) {
      this.log(`${track.id}: the download doesn't match its checksum; not kept.`);
      return null;
    }
    return bytes;
  }

  private recordFailure(id: string): void {
    const count = (this.failures.get(id)?.count ?? 0) + 1;
    const backoff = Math.min(this.failureBackoffMs * 2 ** (count - 1), this.failureBackoffMaxMs);
    this.failures.set(id, { count, until: this.now() + backoff });
  }

  /** Run `task` holding one of `concurrency` slots, FIFO. */
  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.concurrency) {
      this.active++;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}

function fileKey(stat: fs.Stats): string {
  return `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}
