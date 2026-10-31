/**
 * Pokémon sprite pipeline constants (server/src/pokemon/). Kept beside the
 * module, like providers/hook/claude/constants.ts, because nothing outside it
 * reads them.
 */

// ── Upstream ───────────────────────────────────────────────────
/** PMDCollab SpriteCollab mirrors, tried in order. Both follow `master`, so a
 *  takedown upstream drops out of every cache at its next revalidation. */
export const PMD_HOSTS = [
  'https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master',
  'https://cdn.jsdelivr.net/gh/PMDCollab/SpriteCollab@master',
] as const;
/** The species' page on the PMDCollab site; `<dex4>` is appended. */
export const PMD_PAGE_URL_PREFIX = 'https://sprites.pmdcollab.org/#/';

// ── Cache ──────────────────────────────────────────────────────
/** Under ~/.pixel-agents/. */
export const PMD_CACHE_SUBDIR = ['cache', 'pmd'] as const;
/** A cached file older than this is revalidated with If-None-Match. */
export const PMD_REVALIDATE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long an upstream 404 is remembered before it is asked again. */
export const PMD_MISSING_TTL_MS = 60 * 60 * 1000;
/** After every host failed for a file (offline, upstream down), serve what is
 *  cached (or nothing) without asking again for this long. */
export const PMD_FAILURE_BACKOFF_MS = 60 * 1000;
/** After a species fails to load (offline, upstream down), retry no sooner than
 *  this; each further failure doubles the wait, up to PMD_SPECIES_RETRY_MAX_MS. */
export const PMD_SPECIES_RETRY_MS = 60 * 1000;
export const PMD_SPECIES_RETRY_MAX_MS = 30 * 60 * 1000;
export const PMD_FETCH_TIMEOUT_MS = 10_000;
export const PMD_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const PMD_FETCH_CONCURRENCY = 4;
/** Max CopyOf hops when resolving an animation alias. */
export const PMD_COPYOF_MAX_HOPS = 4;

// ── Validation ─────────────────────────────────────────────────
export const PMD_MIN_DEX = 1;
export const PMD_MAX_DEX = 1025;
/** Animation names as SpriteBot writes them (Walk, Idle, QuickStrike, ...). */
export const PMD_ANIM_NAME = /^[A-Z][A-Za-z]{1,24}$/;
/** Upper bounds that keep a malformed AnimData.xml from describing absurd sheets. */
export const PMD_MAX_FRAME_PX = 512;
export const PMD_MAX_FRAMES = 64;
export const PMD_MAX_DURATION = 6000;
/** Sheets are 8 directions (Down, DownRight, Right, UpRight, Up, UpLeft, Left,
 *  DownLeft) or 1 (Sleep). */
export const PMD_DIRECTIONS_FULL = 8;

// ── What the office uses ───────────────────────────────────────
export const REQUIRED_ANIMS = ['Walk', 'Idle'] as const;
export const OPTIONAL_ANIMS = [
  'Sleep',
  'Charge',
  'Hurt',
  'Faint',
  'Hop',
  'Shoot',
  'Attack',
  'Nod',
  'Wake',
  'Pose',
] as const;
export const REQUIRED_PORTRAIT = 'Normal';
export const OPTIONAL_PORTRAITS = [
  'Happy',
  'Determined',
  'Worried',
  'Pain',
  'Surprised',
  'Sigh',
  'Joyous',
] as const;
/** The only portrait files the cache and the route will ever touch. */
export const PORTRAIT_EMOTIONS: ReadonlySet<string> = new Set([
  REQUIRED_PORTRAIT,
  ...OPTIONAL_PORTRAITS,
]);
/** Shown for a credit row whose contributor left no display name. */
export const ANONYMOUS_CONTRIBUTOR = 'anonymous contributor';
export const CHUNSOFT_CREDIT = 'CHUNSOFT';
export const MAX_CREDIT_NAME_CHARS = 80;

// ── Route ──────────────────────────────────────────────────────
export const POKEMON_ROUTE_PREFIX = '/api/pokemon';
export const POKEMON_ROUTE_CACHE_CONTROL = 'private, max-age=86400';

// ── Level and evolution ────────────────────────────────────────
export const LEVEL_MIN = 1;
export const LEVEL_MAX = 100;
/** Messages per level step: level = 1 + floor(sqrt(messageCount / k)). Claude
 *  and Cursor sessions log many more items per turn than Codex ones, so Codex
 *  levels up on a smaller k. */
export const LEVEL_MESSAGES_PER_STEP_DEFAULT = 4;
export const LEVEL_MESSAGES_PER_STEP_CODEX = 2;
/** Evolution: stage 2 from this level, stage 3 from the next. */
export const EVOLVE_STAGE_2_LEVEL = 16;
export const EVOLVE_STAGE_3_LEVEL = 36;
