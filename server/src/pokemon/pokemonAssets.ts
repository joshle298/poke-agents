/**
 * Pokémon sprite assets: runtime download, cache and metadata for the office.
 *
 * Contract used by server/src/cli.ts and the runtime (keep the export names):
 * - setPokemonSpritesEnabled / arePokemonSpritesEnabled: the global kill
 *   switch (`--no-sprites`, POKE_AGENTS_SPRITES=off). Off means nothing is
 *   ever fetched.
 * - loadSpecies: build one species' `pokemonSpeciesLoaded` payload from the
 *   PMD cache (fetching on a miss).
 * - ensureSpeciesLoaded / getLoadedSpecies: the process-wide memo the socket
 *   layer (speciesDelivery.ts) and the evolution path share.
 */

import type { PokemonAnim, PokemonSpeciesLoaded } from '../../../core/src/messages.js';
import type { AgentStateStore } from '../agentStateStore.js';
import type { AnimData } from './animData.js';
import {
  parseAnimData,
  readPngSize,
  resolveAnim,
  sheetAnimNames,
  validateSheet,
} from './animData.js';
import {
  OPTIONAL_ANIMS,
  OPTIONAL_PORTRAITS,
  PMD_PAGE_URL_PREFIX,
  PMD_SPECIES_RETRY_MAX_MS,
  PMD_SPECIES_RETRY_MS,
  POKEMON_ROUTE_PREFIX,
  REQUIRED_ANIMS,
  REQUIRED_PORTRAIT,
} from './constants.js';
import type { PmdCache, PmdRelPath } from './pmdCache.js';
import {
  animDataPath,
  CREDIT_NAMES_PATH,
  dex4,
  getPmdCache,
  isValidDex,
  portraitCreditsPath,
  portraitPath,
  sheetPath,
  spriteCreditsPath,
} from './pmdCache.js';
import type { CreditRow } from './pmdCredits.js';
import { creditedItems, creditsFor, parseCreditNames, parseCredits } from './pmdCredits.js';
import { POKEMON_CATALOG } from './speciesCatalog.js';

let spritesEnabled = process.env.POKE_AGENTS_SPRITES !== 'off';

/** Turn all sprite fetching on or off (`--no-sprites`, POKE_AGENTS_SPRITES=off). */
export function setPokemonSpritesEnabled(enabled: boolean): void {
  spritesEnabled = enabled;
}

export function arePokemonSpritesEnabled(): boolean {
  return spritesEnabled;
}

/** Adapter setting behind the Settings toggle (`setPokemonTheme`). Default on. */
const KEY_POKEMON_THEME = 'pixel-agents.pokemonTheme';

/** The Pokémon theme setting for this office. Absent or unknown reads as on. */
export function isPokemonThemeOn(store: AgentStateStore): boolean {
  return store.getAdapter()?.getSetting<boolean | undefined>(KEY_POKEMON_THEME, true) !== false;
}

/** Sprites may be fetched and announced: the kill switch is off and the theme on. */
export function pokemonDeliveryEnabled(store: AgentStateStore): boolean {
  return spritesEnabled && isPokemonThemeOn(store);
}

// ── Payload ────────────────────────────────────────────────────

export type PokemonSpeciesPayload = Omit<PokemonSpeciesLoaded, 'type'>;

export interface LoadSpeciesOptions {
  /** URL prefix for sheets and portraits. Default `/api/pokemon` (same origin). */
  urlBase?: string;
  cache?: PmdCache;
}

function speciesName(dex: number): string {
  for (const line of POKEMON_CATALOG.lines) {
    const member = line.members.find((m) => m.dex === dex);
    if (member) return member.name;
  }
  return POKEMON_CATALOG.legendaries.find((l) => l.dex === dex)?.name ?? `No. ${dex4(dex)}`;
}

/** Every dex the assigner can hand out (line members and legendaries). */
const CATALOG_DEX: ReadonlySet<number> = new Set([
  ...POKEMON_CATALOG.lines.flatMap((line) => line.members.map((m) => m.dex)),
  ...POKEMON_CATALOG.legendaries.map((l) => l.dex),
]);

/**
 * Whether the sprite route may serve (and so download) this species: one an
 * agent shows now, or any the catalog can assign (PC Box portraits name
 * species no agent in the office holds). Anything else is refused before the
 * cache is touched, so a page cannot make the server mirror SpriteCollab.
 */
export function isServableSpecies(dex: number, store: AgentStateStore): boolean {
  if (CATALOG_DEX.has(dex)) return true;
  for (const agent of store.values()) if (agent.species === dex) return true;
  return false;
}

/** URL of a cached file, matching the routes in routes.ts. */
function assetUrl(urlBase: string, dex: number, shiny: boolean, file: string, portrait = false) {
  const parts = [urlBase, dex4(dex)];
  if (shiny) parts.push('shiny');
  if (portrait) parts.push('portrait');
  parts.push(file);
  return parts.join('/');
}

/** Parsed AnimData.xml for a species form, fetched on a miss. */
export async function loadAnimData(
  cache: PmdCache,
  dex: number,
  shiny: boolean,
): Promise<AnimData | null> {
  const relPath = animDataPath(dex, shiny);
  const xml = relPath ? await cache.readText(relPath) : null;
  return xml ? parseAnimData(xml) : null;
}

async function readCreditRows(cache: PmdCache, relPath: PmdRelPath | null): Promise<CreditRow[]> {
  const text = relPath ? await cache.readText(relPath) : null;
  return text ? parseCredits(text) : [];
}

interface LoadedAnim {
  name: string;
  source: string;
  anim: PokemonAnim;
}

async function loadAnim(
  cache: PmdCache,
  data: AnimData,
  dex: number,
  shiny: boolean,
  name: string,
  urlBase: string,
): Promise<LoadedAnim | null> {
  const resolved = resolveAnim(data, name);
  if (!resolved) return null;
  const relPath = sheetPath(dex, shiny, resolved.source, sheetAnimNames(data));
  const bytes = relPath ? await cache.readFile(relPath) : null;
  const size = bytes ? readPngSize(bytes) : null;
  if (!size) return null;
  const check = validateSheet(resolved, size.width, size.height);
  if (!check.ok) {
    console.warn(`[Pixel Agents] Sprite ${dex4(dex)} ${resolved.file} skipped: ${check.reason}`);
    return null;
  }
  const anim: PokemonAnim = {
    url: assetUrl(urlBase, dex, shiny, resolved.file),
    frameWidth: resolved.frameWidth,
    frameHeight: resolved.frameHeight,
    frames: check.frames,
    directions: check.directions,
    durations: resolved.durations,
  };
  if (resolved.rushFrame !== undefined) anim.rushFrame = resolved.rushFrame;
  if (resolved.hitFrame !== undefined) anim.hitFrame = resolved.hitFrame;
  if (resolved.returnFrame !== undefined) anim.returnFrame = resolved.returnFrame;
  return { name, source: resolved.source, anim };
}

interface LoadedPortraits {
  urls: Record<string, string>;
  rows: CreditRow[];
}

/** Portraits for one form: Normal (required) plus the listed emotions. */
async function loadPortraitSet(
  cache: PmdCache,
  dex: number,
  shiny: boolean,
  urlBase: string,
): Promise<LoadedPortraits | null> {
  const creditsPath = portraitCreditsPath(dex, shiny);
  const creditsText = creditsPath ? await cache.readText(creditsPath) : null;
  const rows = creditsText ? parseCredits(creditsText) : [];
  const normalPath = portraitPath(dex, shiny, REQUIRED_PORTRAIT);
  if (!normalPath || !(await cache.ensureFile(normalPath))) return null;

  // credits.txt names every emotion the form has; without it, ask for each.
  const listed = creditsText ? creditedItems(rows) : null;
  const wanted = OPTIONAL_PORTRAITS.filter((emotion) => !listed || listed.has(emotion));
  const found = await Promise.all(
    wanted.map(async (emotion) => {
      const relPath = portraitPath(dex, shiny, emotion);
      return relPath && (await cache.ensureFile(relPath)) ? emotion : null;
    }),
  );
  const urls: Record<string, string> = {};
  for (const emotion of [REQUIRED_PORTRAIT, ...found]) {
    if (emotion) urls[emotion] = assetUrl(urlBase, dex, shiny, `${emotion}.png`, true);
  }
  return { urls, rows };
}

/**
 * One species' animation metadata, sheet URLs, portraits and credits. Walk and
 * Idle sheets and the Normal portrait are required; without them this returns
 * null and the office keeps the upstream character. Never rejects.
 */
export async function loadSpecies(
  dex: number,
  shiny: boolean,
  opts: LoadSpeciesOptions = {},
): Promise<PokemonSpeciesPayload | null> {
  if (!spritesEnabled || !isValidDex(dex)) return null;
  const cache = opts.cache ?? getPmdCache();
  const urlBase = opts.urlBase ?? POKEMON_ROUTE_PREFIX;
  try {
    const data = await loadAnimData(cache, dex, shiny);
    if (!data) return null;

    const required = await Promise.all(
      REQUIRED_ANIMS.map((name) => loadAnim(cache, data, dex, shiny, name, urlBase)),
    );
    if (required.some((anim) => anim === null)) return null;
    // Queued in preference order; the cache's fetch slots serve them FIFO.
    const optional = await Promise.all(
      OPTIONAL_ANIMS.filter((name) => Object.hasOwn(data.anims, name)).map((name) =>
        loadAnim(cache, data, dex, shiny, name, urlBase),
      ),
    );
    const loaded = [...required, ...optional].filter((a): a is LoadedAnim => a !== null);

    // A shiny form without portraits of its own shows the base form's.
    const portraits =
      (shiny ? await loadPortraitSet(cache, dex, true, urlBase) : null) ??
      (await loadPortraitSet(cache, dex, false, urlBase));
    if (!portraits) return null;

    let spriteRows = await readCreditRows(cache, spriteCreditsPath(dex, shiny));
    if (spriteRows.length === 0 && shiny) {
      spriteRows = await readCreditRows(cache, spriteCreditsPath(dex, false));
    }
    const namesText = await cache.readText(CREDIT_NAMES_PATH);
    const names = namesText ? parseCreditNames(namesText) : new Map();

    return {
      dex,
      shiny,
      name: speciesName(dex),
      shadowSize: data.shadowSize,
      anims: Object.fromEntries(loaded.map((a) => [a.name, a.anim])),
      portraits: portraits.urls,
      credits: {
        sprite: creditsFor(
          spriteRows,
          names,
          loaded.flatMap((a) => [a.name, a.source]),
        ),
        portrait: creditsFor(portraits.rows, names, Object.keys(portraits.urls)),
        pageUrl: `${PMD_PAGE_URL_PREFIX}${dex4(dex)}`,
      },
    };
  } catch (err) {
    console.warn(
      `[Pixel Agents] Pokémon ${dex4(dex)} failed to load:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ── Process-wide memo ──────────────────────────────────────────

const loadedSpecies = new Map<string, PokemonSpeciesPayload>();
const pendingSpecies = new Map<string, Promise<boolean>>();
/** When each failing species last failed, and how many times in a row. */
const failedSpecies = new Map<string, { at: number; count: number }>();

/** `dex:shiny` key used for the memo and per-socket delivery tracking. */
export function speciesKey(dex: number, shiny: boolean): string {
  return `${dex}:${shiny ? 1 : 0}`;
}

/** The payload if this species already loaded in this process. */
export function getLoadedSpecies(dex: number, shiny: boolean): PokemonSpeciesPayload | undefined {
  return loadedSpecies.get(speciesKey(dex, shiny));
}

/**
 * Epoch ms from which a species that failed to load may be tried again, or
 * undefined when it has not failed. The wait starts at PMD_SPECIES_RETRY_MS
 * and doubles with each consecutive failure, up to PMD_SPECIES_RETRY_MAX_MS.
 */
export function speciesRetryAt(dex: number, shiny: boolean): number | undefined {
  const failed = failedSpecies.get(speciesKey(dex, shiny));
  if (!failed) return undefined;
  const wait = Math.min(PMD_SPECIES_RETRY_MAX_MS, PMD_SPECIES_RETRY_MS * 2 ** (failed.count - 1));
  return failed.at + wait;
}

/**
 * Load a species once per process (same-origin URLs) and remember it.
 * Resolves true when its payload is ready (getLoadedSpecies returns it), false
 * when sprites are off, the theme is off, or the load failed; a failure is
 * retried no sooner than speciesRetryAt. Never rejects.
 *
 * The evolution path awaits this before broadcasting the new species, so the
 * socket layer can send `pokemonSpeciesLoaded` ahead of `agentDetails`.
 */
export function ensureSpeciesLoaded(
  dex: number,
  shiny: boolean,
  store: AgentStateStore,
): Promise<boolean> {
  const key = speciesKey(dex, shiny);
  if (loadedSpecies.has(key)) return Promise.resolve(true);
  if (!isValidDex(dex) || !pokemonDeliveryEnabled(store)) return Promise.resolve(false);
  const pending = pendingSpecies.get(key);
  if (pending) return pending;
  const retryAt = speciesRetryAt(dex, shiny);
  if (retryAt !== undefined && Date.now() < retryAt) return Promise.resolve(false);
  const load = loadSpecies(dex, shiny)
    .then((payload) => {
      if (payload) {
        loadedSpecies.set(key, payload);
        failedSpecies.delete(key);
        return true;
      }
      failedSpecies.set(key, { at: Date.now(), count: (failedSpecies.get(key)?.count ?? 0) + 1 });
      return false;
    })
    .finally(() => pendingSpecies.delete(key));
  pendingSpecies.set(key, load);
  return load;
}

/** Forget every loaded species (tests, or after the cache root changes). */
export function resetLoadedSpecies(): void {
  loadedSpecies.clear();
  pendingSpecies.clear();
  failedSpecies.clear();
}
