/**
 * Download-on-demand cache of PMDCollab SpriteCollab files under
 * ~/.pixel-agents/cache/pmd/, mirroring the upstream layout:
 *
 *   sprite/0025/AnimData.xml, sprite/0025/Walk-Anim.png, sprite/0025/credits.txt
 *   sprite/0025/0000/0001/...        (shiny)
 *   portrait/0025/Normal.png, portrait/0025/credits.txt
 *   portrait/0025/0000/0001/...      (shiny)
 *   credit_names.txt
 *
 * Nothing Pokémon is bundled: these files are fetched on the user's machine
 * and served same-origin to their own office (see routes.ts).
 *
 * Every path is built by the functions below from a validated dex (1..1025)
 * and an allowlisted name, so the cache can't be turned into a general proxy
 * or write outside its root. Fetches are single-flight per path, at most
 * PMD_FETCH_CONCURRENCY at once, time-limited, size-capped and checked (PNG
 * signature for images). Writes are atomic (temp file + rename). A cached file
 * older than PMD_REVALIDATE_MS is revalidated with its ETag; a network failure
 * serves the stale copy (and backs off before asking again), and an upstream
 * 404 deletes it (honours takedowns).
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from '../constants.js';
import { hasPngSignature } from './animData.js';
import {
  PMD_ANIM_NAME,
  PMD_CACHE_SUBDIR,
  PMD_FAILURE_BACKOFF_MS,
  PMD_FETCH_CONCURRENCY,
  PMD_FETCH_TIMEOUT_MS,
  PMD_HOSTS,
  PMD_MAX_DEX,
  PMD_MAX_FILE_BYTES,
  PMD_MIN_DEX,
  PMD_MISSING_TTL_MS,
  PMD_REVALIDATE_MS,
  PORTRAIT_EMOTIONS,
} from './constants.js';

// ── Paths ──────────────────────────────────────────────────────

declare const pmdRelPathBrand: unique symbol;
/** A cache-relative path (`/`-separated) that only the builders below create. */
export type PmdRelPath = string & { readonly [pmdRelPathBrand]: true };

const SHINY_SEGMENT = '0000/0001';
const ETAG_SUFFIX = '.etag';
const MAX_ETAG_CHARS = 256;

export function isValidDex(dex: unknown): dex is number {
  return Number.isInteger(dex) && (dex as number) >= PMD_MIN_DEX && (dex as number) <= PMD_MAX_DEX;
}

/** `25` -> `0025`. */
export function dex4(dex: number): string {
  return String(dex).padStart(4, '0');
}

/** `0025` -> 25; null unless exactly four digits naming a valid dex. */
export function parseDex4(text: string): number | null {
  if (!/^\d{4}$/.test(text)) return null;
  const dex = Number(text);
  return isValidDex(dex) ? dex : null;
}

function variantDir(kind: 'sprite' | 'portrait', dex: number, shiny: boolean): string | null {
  if (!isValidDex(dex)) return null;
  return shiny ? `${kind}/${dex4(dex)}/${SHINY_SEGMENT}` : `${kind}/${dex4(dex)}`;
}

function rel(dir: string | null, file: string): PmdRelPath | null {
  return dir === null ? null : (`${dir}/${file}` as PmdRelPath);
}

export function animDataPath(dex: number, shiny: boolean): PmdRelPath | null {
  return rel(variantDir('sprite', dex, shiny), 'AnimData.xml');
}

export function spriteCreditsPath(dex: number, shiny: boolean): PmdRelPath | null {
  return rel(variantDir('sprite', dex, shiny), 'credits.txt');
}

/**
 * `<anim>-Anim.png` for an anim that this species' AnimData.xml declares with
 * a sheet of its own (`declared`, from animData.sheetAnimNames).
 */
export function sheetPath(
  dex: number,
  shiny: boolean,
  anim: string,
  declared: ReadonlySet<string>,
): PmdRelPath | null {
  if (!PMD_ANIM_NAME.test(anim) || !declared.has(anim)) return null;
  return rel(variantDir('sprite', dex, shiny), `${anim}-Anim.png`);
}

export function portraitPath(dex: number, shiny: boolean, emotion: string): PmdRelPath | null {
  if (!PORTRAIT_EMOTIONS.has(emotion)) return null;
  return rel(variantDir('portrait', dex, shiny), `${emotion}.png`);
}

export function portraitCreditsPath(dex: number, shiny: boolean): PmdRelPath | null {
  return rel(variantDir('portrait', dex, shiny), 'credits.txt');
}

export const CREDIT_NAMES_PATH = 'credit_names.txt' as PmdRelPath;

export function defaultPmdCacheRoot(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, ...PMD_CACHE_SUBDIR);
}

// ── Cache ──────────────────────────────────────────────────────

/** The subset of `fetch` the cache uses, so tests can inject a fake. */
export type PmdFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

export interface PmdCacheOptions {
  /** Cache directory. Default ~/.pixel-agents/cache/pmd. */
  root?: string;
  fetch?: PmdFetch;
  /** Upstream bases, tried in order. Default PMD_HOSTS. */
  hosts?: readonly string[];
  /** Clock for freshness decisions (epoch ms). */
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  concurrency?: number;
  revalidateMs?: number;
  missingTtlMs?: number;
  failureBackoffMs?: number;
}

interface StoredEtag {
  host: string;
  etag: string;
}

type Download =
  | { kind: 'fresh'; bytes: Buffer; etag: StoredEtag | null }
  | { kind: 'unchanged' }
  | { kind: 'missing' }
  | { kind: 'failed' };

export class PmdCache {
  readonly root: string;
  private readonly fetchFn: PmdFetch;
  private readonly hosts: readonly string[];
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly concurrency: number;
  private readonly revalidateMs: number;
  private readonly missingTtlMs: number;
  private readonly failureBackoffMs: number;
  private readonly userAgent = `poke-agents/${process.env.PIXEL_AGENTS_VERSION || 'dev'}`;

  private readonly inflight = new Map<string, Promise<string | null>>();
  /** rel -> epoch ms until which an upstream 404 is trusted. */
  private readonly missing = new Map<string, number>();
  /** rel -> epoch ms before which a failed download is not retried. */
  private readonly failedUntil = new Map<string, number>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: PmdCacheOptions = {}) {
    this.root = path.resolve(options.root ?? defaultPmdCacheRoot());
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.hosts = options.hosts ?? PMD_HOSTS;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? PMD_FETCH_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? PMD_MAX_FILE_BYTES;
    this.concurrency = Math.max(1, options.concurrency ?? PMD_FETCH_CONCURRENCY);
    this.revalidateMs = options.revalidateMs ?? PMD_REVALIDATE_MS;
    this.missingTtlMs = options.missingTtlMs ?? PMD_MISSING_TTL_MS;
    this.failureBackoffMs = options.failureBackoffMs ?? PMD_FAILURE_BACKOFF_MS;
  }

  /** Absolute path of a cache entry. Throws if it would leave the root, which
   *  the path builders make impossible; this is the second line of defence. */
  pathFor(relPath: PmdRelPath): string {
    const abs = path.resolve(this.root, ...relPath.split('/'));
    if (!abs.startsWith(this.root + path.sep)) {
      throw new Error(`PMD cache path escapes the cache root: ${relPath}`);
    }
    return abs;
  }

  /**
   * Make sure the file is cached and reasonably fresh. Resolves to its
   * absolute path, or null when upstream doesn't have it (or it can't be
   * fetched and nothing is cached). Never rejects.
   */
  ensureFile(relPath: PmdRelPath): Promise<string | null> {
    const existing = this.inflight.get(relPath);
    if (existing) return existing;
    const pending = this.resolveFile(relPath)
      .catch((err: unknown) => {
        console.warn(`[Pixel Agents] Sprite cache: ${relPath} failed:`, errorText(err));
        return null;
      })
      .finally(() => this.inflight.delete(relPath));
    this.inflight.set(relPath, pending);
    return pending;
  }

  /** The file's bytes, fetching it first when needed. */
  async readFile(relPath: PmdRelPath): Promise<Buffer | null> {
    const abs = await this.ensureFile(relPath);
    if (!abs) return null;
    try {
      return await fs.promises.readFile(abs);
    } catch {
      return null;
    }
  }

  async readText(relPath: PmdRelPath): Promise<string | null> {
    const bytes = await this.readFile(relPath);
    return bytes ? bytes.toString('utf8') : null;
  }

  private async resolveFile(relPath: PmdRelPath): Promise<string | null> {
    const abs = this.pathFor(relPath);
    const now = this.now();
    const stat = await statFile(abs);
    if (stat && now - stat.mtimeMs < this.revalidateMs) return abs;
    if (!stat && (this.missing.get(relPath) ?? 0) > now) return null;
    // Offline or upstream down: don't make every request wait on the network again.
    if ((this.failedUntil.get(relPath) ?? 0) > now) return stat ? abs : null;

    const download = await this.download(relPath, stat ? await readEtag(abs) : null);
    switch (download.kind) {
      case 'fresh':
        try {
          await writeAtomic(abs, download.bytes);
        } catch (err) {
          console.warn(`[Pixel Agents] Sprite cache: could not write ${relPath}:`, errorText(err));
          return stat ? abs : null;
        }
        this.missing.delete(relPath);
        this.failedUntil.delete(relPath);
        try {
          if (download.etag) {
            await writeAtomic(abs + ETAG_SUFFIX, JSON.stringify(download.etag));
          } else {
            await fs.promises.rm(abs + ETAG_SUFFIX, { force: true });
          }
          await touch(abs, this.now());
        } catch {
          // The file itself is in place; without its ETag it is just re-fetched in full next time.
        }
        return abs;
      case 'unchanged':
        this.failedUntil.delete(relPath);
        await touch(abs, this.now());
        return abs;
      case 'missing':
        // Gone upstream: drop any cached copy so removed art leaves the cache too.
        this.missing.set(relPath, this.now() + this.missingTtlMs);
        if (stat) {
          await fs.promises.rm(abs, { force: true });
          await fs.promises.rm(abs + ETAG_SUFFIX, { force: true });
        }
        return null;
      case 'failed':
        this.failedUntil.set(relPath, this.now() + this.failureBackoffMs);
        return stat ? abs : null;
    }
  }

  /** Try each host in order. A 404 is an answer; anything else moves on. */
  private async download(relPath: PmdRelPath, etag: StoredEtag | null): Promise<Download> {
    const isPng = relPath.endsWith('.png');
    for (const host of this.hosts) {
      const headers: Record<string, string> = { 'user-agent': this.userAgent };
      const revalidating = etag !== null && etag.host === host;
      if (revalidating) headers['if-none-match'] = etag.etag;

      const outcome = await this.withSlot(async (): Promise<Download | null> => {
        let res: Response;
        try {
          res = await this.fetchFn(`${host}/${relPath}`, {
            headers,
            signal: AbortSignal.timeout(this.timeoutMs),
          });
        } catch {
          return null;
        }
        if (res.status === 404) {
          await discardBody(res);
          return { kind: 'missing' };
        }
        if (res.status === 304 && revalidating) {
          await discardBody(res);
          return { kind: 'unchanged' };
        }
        if (res.status !== 200) {
          await discardBody(res);
          return null;
        }
        const bytes = await readCapped(res, this.maxBytes);
        if (!bytes || !(isPng ? hasPngSignature(bytes) : looksLikeText(bytes))) return null;
        const tag = res.headers.get('etag');
        return {
          kind: 'fresh',
          bytes,
          etag: tag && tag.length <= MAX_ETAG_CHARS ? { host, etag: tag } : null,
        };
      });
      if (outcome) return outcome;
    }
    return { kind: 'failed' };
  }

  /** Run `task` holding one of `concurrency` slots. A finished task hands its
   *  slot straight to the next waiter, so a newcomer can't jump the queue. */
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

// ── Default instance ───────────────────────────────────────────

let defaultCache: PmdCache | null = null;

/** The process-wide cache (~/.pixel-agents/cache/pmd, global fetch). */
export function getPmdCache(): PmdCache {
  defaultCache ??= new PmdCache();
  return defaultCache;
}

/** Replace the process-wide cache (tests; a custom root). Null restores the default. */
export function setPmdCache(cache: PmdCache | null): void {
  defaultCache = cache;
}

// ── File helpers (shared with audio/cryCache.ts) ───────────────

export async function statFile(abs: string): Promise<fs.Stats | null> {
  try {
    const stat = await fs.promises.stat(abs);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

async function readEtag(abs: string): Promise<StoredEtag | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(abs + ETAG_SUFFIX, 'utf8')) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as StoredEtag).host === 'string' &&
      typeof (parsed as StoredEtag).etag === 'string' &&
      (parsed as StoredEtag).etag.length <= MAX_ETAG_CHARS
    ) {
      return { host: (parsed as StoredEtag).host, etag: (parsed as StoredEtag).etag };
    }
  } catch {
    /* no or unreadable sidecar: fetch unconditionally */
  }
  return null;
}

export async function writeAtomic(abs: string, data: Buffer | string): Promise<void> {
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, abs);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

export async function touch(abs: string, nowMs: number): Promise<void> {
  const seconds = nowMs / 1000;
  await fs.promises.utimes(abs, seconds, seconds);
}

export async function readCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(res);
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

export async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed or aborted */
  }
}

/** XML and credits files are plain text; a NUL byte means we got something else. */
function looksLikeText(bytes: Buffer): boolean {
  return !bytes.includes(0);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
