/**
 * Sound delivery constants (server/src/audio/). Kept beside the module, like
 * pokemon/constants.ts, because nothing outside it reads them.
 */

// ── Cries (PokéAPI cries project) ───────────────────────────────
/** Base of the PokéAPI cries repository; `/<variant>/<dex>.ogg` is appended. */
export const CRY_UPSTREAM_BASE =
  'https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon';
/** Cry variants, tried in order: `latest` covers every species; `legacy`
 *  (the older games' cries) only backs up a species `latest` lacks. */
export const CRY_VARIANTS = ['latest', 'legacy'] as const;
/** Under ~/.pixel-agents/. */
export const CRY_CACHE_SUBDIR = ['cache', 'cries'] as const;
/** A cached cry older than this is revalidated with If-None-Match. */
export const CRY_REVALIDATE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long "no variant has this cry" is remembered before asking again. */
export const CRY_MISSING_TTL_MS = 60 * 60 * 1000;
/** After a cry failed to download (offline, upstream down), serve what is
 *  cached (or nothing) without asking again for this long, doubling per
 *  consecutive failure up to CRY_FAILURE_BACKOFF_MAX_MS. */
export const CRY_FAILURE_BACKOFF_MS = 60 * 1000;
export const CRY_FAILURE_BACKOFF_MAX_MS = 30 * 60 * 1000;
export const CRY_FETCH_TIMEOUT_MS = 10_000;
/** Cries are 5-30 KB; anything near this is not a cry. */
export const CRY_MAX_BYTES = 1024 * 1024;
export const CRY_FETCH_CONCURRENCY = 2;

// ── Routes ──────────────────────────────────────────────────────
export const CRY_ROUTE_PREFIX = '/api/pokemon/cry';
export const SOUND_PACK_ROUTE_PREFIX = '/api/sounds';
export const CRY_ROUTE_CACHE_CONTROL = 'private, max-age=86400';
/** Sound-pack files are the user's and may be replaced at any time. */
export const SOUND_PACK_CACHE_CONTROL = 'private, no-cache';

// ── Sound pack (~/.pixel-agents/sounds/<event>.<ext>) ───────────
export const SOUND_PACK_DIR_NAME = 'sounds';
export const SOUND_PACK_MAX_BYTES = 2 * 1024 * 1024;
/** The only file names the sound pack route will ever open (case-sensitive). */
export const SOUND_PACK_EVENTS = [
  'alert',
  'done',
  'faint',
  'heal',
  'levelUp',
  'evolution',
  'ballThrow',
  'ballPop',
  'recall',
  'message',
  'blip',
] as const;
/** Formats in preference order when one event has several files. */
export const SOUND_PACK_FORMATS = ['ogg', 'mp3', 'wav'] as const;
