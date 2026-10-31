/**
 * Download-on-demand cache of Pokémon cries under ~/.pixel-agents/cache/cries/:
 *
 *   0025.ogg        the cry, as served by the PokéAPI cries project
 *   0025.ogg.etag   { variant, etag } for revalidation
 *
 * Nothing is bundled: cries are fetched on the user's machine from
 * raw.githubusercontent.com/PokeAPI/cries (the `latest` cry, else the
 * `legacy` one) and served same-origin to their own office (routes.ts).
 *
 * The same rules as the sprite cache (pokemon/pmdCache.ts): paths are built
 * only from a validated dex, fetches are single-flight per dex, at most
 * CRY_FETCH_CONCURRENCY at once, time-limited, size-capped and checked (an
 * Ogg or MP3 signature: a few cries, like Pikachu's, are MP3 under the same
 * name; an error page never is). Writes are atomic. A cry older than CRY_REVALIDATE_MS is
 * revalidated with its ETag; a failure serves the stale copy and backs off
 * (doubling per consecutive failure); a 404 from every variant deletes the
 * cached copy (honours takedowns).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from '../constants.js';
import {
  dex4,
  discardBody,
  isValidDex,
  readCapped,
  statFile,
  touch,
  writeAtomic,
} from '../pokemon/pmdCache.js';
import { type AudioFormat, sniffAudioFormat } from './audioSignature.js';
import {
  CRY_CACHE_SUBDIR,
  CRY_FAILURE_BACKOFF_MAX_MS,
  CRY_FAILURE_BACKOFF_MS,
  CRY_FETCH_CONCURRENCY,
  CRY_FETCH_TIMEOUT_MS,
  CRY_MAX_BYTES,
  CRY_MISSING_TTL_MS,
  CRY_REVALIDATE_MS,
  CRY_UPSTREAM_BASE,
  CRY_VARIANTS,
} from './constants.js';

const ETAG_SUFFIX = '.etag';
const MAX_ETAG_CHARS = 256;

/** The subset of `fetch` the cache uses, so tests can inject a fake. */
export type CryFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

export interface CryCacheOptions {
  /** Cache directory. Default ~/.pixel-agents/cache/cries. */
  root?: string;
  fetch?: CryFetch;
  /** Upstream base; `/<variant>/<dex>.ogg` is appended. Default CRY_UPSTREAM_BASE. */
  base?: string;
  /** Variants in preference order. Default CRY_VARIANTS. */
  variants?: readonly string[];
  /** Clock for freshness decisions (epoch ms). */
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  concurrency?: number;
  revalidateMs?: number;
  missingTtlMs?: number;
  failureBackoffMs?: number;
  failureBackoffMaxMs?: number;
}

interface StoredEtag {
  variant: string;
  etag: string;
}

type Download =
  | { kind: 'fresh'; bytes: Buffer; etag: StoredEtag | null }
  | { kind: 'unchanged' }
  | { kind: 'missing' }
  | { kind: 'failed' };

/** The cry formats the cache keeps; anything else (an HTML error page, a
 *  truncated body) is refused. */
export function cryFormat(bytes: Buffer): Extract<AudioFormat, 'ogg' | 'mp3'> | null {
  const format = sniffAudioFormat(bytes);
  return format === 'ogg' || format === 'mp3' ? format : null;
}

export function defaultCryCacheRoot(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, ...CRY_CACHE_SUBDIR);
}

export class CryCache {
  readonly root: string;
  private readonly fetchFn: CryFetch;
  private readonly base: string;
  private readonly variants: readonly string[];
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly concurrency: number;
  private readonly revalidateMs: number;
  private readonly missingTtlMs: number;
  private readonly failureBackoffMs: number;
  private readonly failureBackoffMaxMs: number;
  private readonly userAgent = `poke-agents/${process.env.PIXEL_AGENTS_VERSION || 'dev'}`;

  private readonly inflight = new Map<number, Promise<string | null>>();
  /** dex -> epoch ms until which "no variant has it" is trusted. */
  private readonly missing = new Map<number, number>();
  /** dex -> consecutive failures and the epoch ms before which none is retried. */
  private readonly failures = new Map<number, { count: number; until: number }>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: CryCacheOptions = {}) {
    this.root = path.resolve(options.root ?? defaultCryCacheRoot());
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.base = options.base ?? CRY_UPSTREAM_BASE;
    this.variants = options.variants ?? CRY_VARIANTS;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? CRY_FETCH_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? CRY_MAX_BYTES;
    this.concurrency = Math.max(1, options.concurrency ?? CRY_FETCH_CONCURRENCY);
    this.revalidateMs = options.revalidateMs ?? CRY_REVALIDATE_MS;
    this.missingTtlMs = options.missingTtlMs ?? CRY_MISSING_TTL_MS;
    this.failureBackoffMs = options.failureBackoffMs ?? CRY_FAILURE_BACKOFF_MS;
    this.failureBackoffMaxMs = options.failureBackoffMaxMs ?? CRY_FAILURE_BACKOFF_MAX_MS;
  }

  /** Absolute path of a dex's cached cry; null for an invalid dex. The
   *  root check is the second line of defence behind isValidDex. */
  pathFor(dex: number): string | null {
    if (!isValidDex(dex)) return null;
    const abs = path.resolve(this.root, `${dex4(dex)}.ogg`);
    return abs.startsWith(this.root + path.sep) ? abs : null;
  }

  /**
   * Make sure the cry is cached and reasonably fresh. Resolves to its
   * absolute path, or null when no variant has it (or it can't be fetched
   * and nothing is cached). Never rejects.
   */
  ensureCry(dex: number): Promise<string | null> {
    if (!isValidDex(dex)) return Promise.resolve(null);
    const existing = this.inflight.get(dex);
    if (existing) return existing;
    const pending = this.resolveCry(dex)
      .catch((err: unknown) => {
        console.warn(`[Pixel Agents] Cry cache: ${dex4(dex)} failed:`, errorText(err));
        return null;
      })
      .finally(() => this.inflight.delete(dex));
    this.inflight.set(dex, pending);
    return pending;
  }

  private async resolveCry(dex: number): Promise<string | null> {
    const abs = this.pathFor(dex);
    if (!abs) return null;
    const now = this.now();
    const stat = await statFile(abs);
    if (stat && now - stat.mtimeMs < this.revalidateMs) return abs;
    if (!stat && (this.missing.get(dex) ?? 0) > now) return null;
    if ((this.failures.get(dex)?.until ?? 0) > now) return stat ? abs : null;

    const download = await this.download(dex, stat ? await readEtag(abs) : null);
    switch (download.kind) {
      case 'fresh':
        try {
          await writeAtomic(abs, download.bytes);
        } catch (err) {
          console.warn(`[Pixel Agents] Cry cache: could not write ${dex4(dex)}:`, errorText(err));
          return stat ? abs : null;
        }
        this.missing.delete(dex);
        this.failures.delete(dex);
        try {
          if (download.etag) {
            await writeAtomic(abs + ETAG_SUFFIX, JSON.stringify(download.etag));
          } else {
            await fs.promises.rm(abs + ETAG_SUFFIX, { force: true });
          }
          await touch(abs, this.now());
        } catch {
          // The cry itself is in place; without its ETag it is re-fetched in full next time.
        }
        return abs;
      case 'unchanged':
        this.failures.delete(dex);
        await touch(abs, this.now());
        return abs;
      case 'missing':
        this.missing.set(dex, this.now() + this.missingTtlMs);
        if (stat) {
          await fs.promises.rm(abs, { force: true });
          await fs.promises.rm(abs + ETAG_SUFFIX, { force: true });
        }
        return null;
      case 'failed': {
        const count = (this.failures.get(dex)?.count ?? 0) + 1;
        const backoff = Math.min(
          this.failureBackoffMs * 2 ** (count - 1),
          this.failureBackoffMaxMs,
        );
        this.failures.set(dex, { count, until: this.now() + backoff });
        return stat ? abs : null;
      }
    }
  }

  /**
   * Try each variant in order. A 404 moves on to the next variant; any other
   * failure stops (asking the next variant would swap one cry for another
   * just because the network blinked).
   */
  private async download(dex: number, etag: StoredEtag | null): Promise<Download> {
    for (const variant of this.variants) {
      const headers: Record<string, string> = { 'user-agent': this.userAgent };
      const revalidating = etag !== null && etag.variant === variant;
      if (revalidating) headers['if-none-match'] = etag.etag;

      const outcome = await this.withSlot(async (): Promise<Download | 'next'> => {
        let res: Response;
        try {
          res = await this.fetchFn(`${this.base}/${variant}/${dex}.ogg`, {
            headers,
            signal: AbortSignal.timeout(this.timeoutMs),
          });
        } catch {
          return { kind: 'failed' };
        }
        if (res.status === 404) {
          await discardBody(res);
          return 'next';
        }
        if (res.status === 304 && revalidating) {
          await discardBody(res);
          return { kind: 'unchanged' };
        }
        if (res.status !== 200) {
          await discardBody(res);
          return { kind: 'failed' };
        }
        const bytes = await readCapped(res, this.maxBytes);
        if (!bytes || cryFormat(bytes) === null) return { kind: 'failed' };
        const tag = res.headers.get('etag');
        return {
          kind: 'fresh',
          bytes,
          etag: tag && tag.length <= MAX_ETAG_CHARS ? { variant, etag: tag } : null,
        };
      });
      if (outcome !== 'next') return outcome;
    }
    return { kind: 'missing' };
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

// ── Default instance ───────────────────────────────────────────

let defaultCache: CryCache | null = null;

/** The process-wide cache (~/.pixel-agents/cache/cries, global fetch). */
export function getCryCache(): CryCache {
  defaultCache ??= new CryCache();
  return defaultCache;
}

// ── Helpers ────────────────────────────────────────────────────

async function readEtag(abs: string): Promise<StoredEtag | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(abs + ETAG_SUFFIX, 'utf8')) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as StoredEtag).variant === 'string' &&
      typeof (parsed as StoredEtag).etag === 'string' &&
      (parsed as StoredEtag).etag.length <= MAX_ETAG_CHARS
    ) {
      return { variant: (parsed as StoredEtag).variant, etag: (parsed as StoredEtag).etag };
    }
  } catch {
    /* no or unreadable sidecar: fetch unconditionally */
  }
  return null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
