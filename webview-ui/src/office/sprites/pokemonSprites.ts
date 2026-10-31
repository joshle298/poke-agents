/**
 * Pokémon species store, fed by `pokemonSpeciesLoaded`.
 *
 * Holds each species' metadata (anims, portraits, credits), decodes its
 * sheets (`fetch(url) → blob → createImageBitmap`), and measures its body
 * once from the opaque box of the Idle (else Walk) Down frame 0. Shiny is a
 * separate species entry.
 *
 * DOM-free, types included: OfficeState reads geometry for hit-testing, and
 * the Node test runner imports (and type-checks) OfficeState. Decoding goes
 * through a loader — the browser one (`pokemonSheetLoader.ts`, fetch →
 * blob → createImageBitmap) is installed by the message handler; tests
 * install a synthetic one.
 *
 * No art ships with the app: sheets arrive at runtime as same-origin URLs
 * (standalone) or data URLs (VS Code), and nothing else is fetched.
 *
 * Decoded sheets are big (a few MB per species) and session churn keeps
 * bringing new species, so OfficeState sweeps the store: a species no
 * character has used for POKEMON_SHEET_RELEASE_AFTER_MS has its bitmaps
 * closed. Its metadata stays (credits, portraits, a later return), and it
 * decodes again when a character uses it.
 */

import type {
  PokemonAnim,
  PokemonCredits,
  PokemonSpeciesLoaded,
} from '../../../../core/src/messages.js';
import {
  PMD_GROUND_Y_OFFSET_PX,
  POKEMON_ALPHA_THRESHOLD,
  POKEMON_ANIM_FALLBACKS,
  POKEMON_DECODE_ORDER,
  POKEMON_FEET_BELOW_GROUND_PX,
  POKEMON_GEOMETRY_ANIMS,
  POKEMON_SHEET_RELEASE_AFTER_MS,
} from '../../constants.js';
import type { PokemonAnimSource } from '../engine/pokemonAnim.js';

/** A decoded sheet: an opaque drawable handle (an ImageBitmap in the
 *  browser; the renderer passes it to drawImage) plus its size. */
export interface DecodedSheet {
  image: object;
  width: number;
  height: number;
}

/** How sheets become drawable (see pokemonSheetLoader.ts for the browser's). */
export interface PokemonSheetLoader {
  load(url: string): Promise<DecodedSheet>;
  /** RGBA bytes of a sub-rectangle of a decoded sheet, or null if unreadable. */
  readPixels(
    sheet: DecodedSheet,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
  ): ArrayLike<number> | null;
}

/** A species' body, measured on one frame, in that frame's pixels. */
export interface PokemonGeometry {
  frameWidth: number;
  frameHeight: number;
  /** The ground point: (floor(w/2), floor(h/2) + 4). */
  anchorX: number;
  anchorY: number;
  /** Topmost opaque row. */
  bodyTop: number;
  /** Widest reach of the body from the anchor column. */
  bodyHalfW: number;
  /** Height of the body above the ground point (anchorY - bodyTop). */
  headRise: number;
}

/** What the UI (portraits, credits, names) needs about a species. */
export interface PokemonSpeciesInfo {
  dex: number;
  shiny: boolean;
  name: string;
  anims: Record<string, PokemonAnim>;
  portraits: Record<string, string>;
  credits: PokemonCredits;
}

interface SpeciesEntry {
  info: PokemonSpeciesInfo;
  sheets: Map<string, DecodedSheet>;
  failed: Set<string>;
  geometry: PokemonGeometry | null;
  source: PokemonAnimSource;
  /** Sheets closed by a sweep; the next use decodes them again. */
  released: boolean;
  /** Bumped on release, so a decode that lands afterwards is dropped. */
  epoch: number;
  /** When a sweep first found no character using it (sweep clock, ms). */
  unusedSince?: number;
  /** Poses measured on single frames, keyed `anim:row:frame`. */
  poses?: Map<string, PokemonRestPose>;
}

const entries = new Map<string, SpeciesEntry>();
const listeners = new Set<() => void>();
let version = 0;
let loader: PokemonSheetLoader | null = null;

export function pokemonSpeciesKey(dex: number, shiny: boolean): string {
  return `${dex}:${shiny ? 1 : 0}`;
}

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

/** Bumped whenever a species is added or a sheet finishes decoding. */
export function getPokemonSpeciesVersion(): number {
  return version;
}

/** For useSyncExternalStore (portraits, credits). Returns the unsubscribe. */
export function subscribePokemonSpecies(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Sprite URLs the client will load: a PNG data URL, or an http(s) URL on the
 * page's own origin. Anything else is refused — the server builds these, and
 * a URL pointing elsewhere is not one it built.
 */
export function isAllowedSpriteUrl(url: string, origin: string | undefined): boolean {
  if (url.startsWith('data:image/png;base64,')) return true;
  if (!origin) return false;
  try {
    const parsed = new URL(url, origin);
    return (
      parsed.origin === origin && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    );
  } catch {
    return false;
  }
}

function pageOrigin(): string | undefined {
  return (globalThis as { location?: { origin?: string } }).location?.origin;
}

/** Opaque bounding box of an RGBA frame → the species geometry. */
export function computePokemonGeometry(
  rgba: ArrayLike<number>,
  frameWidth: number,
  frameHeight: number,
): PokemonGeometry {
  let minX = frameWidth;
  let minY = frameHeight;
  let maxX = -1;
  for (let y = 0; y < frameHeight; y++) {
    for (let x = 0; x < frameWidth; x++) {
      if ((rgba[(y * frameWidth + x) * 4 + 3] ?? 0) < POKEMON_ALPHA_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
    }
  }
  const anchorX = Math.floor(frameWidth / 2);
  const anchorY = Math.floor(frameHeight / 2) + PMD_GROUND_Y_OFFSET_PX;
  if (maxX < 0) {
    // Fully transparent frame: fall back to the whole frame.
    return {
      frameWidth,
      frameHeight,
      anchorX,
      anchorY,
      bodyTop: 0,
      bodyHalfW: anchorX,
      headRise: anchorY,
    };
  }
  return {
    frameWidth,
    frameHeight,
    anchorX,
    anchorY,
    bodyTop: minY,
    bodyHalfW: Math.max(anchorX - minX, maxX + 1 - anchorX, 1),
    headRise: Math.max(anchorY - minY, 1),
  };
}

function activeLoader(): PokemonSheetLoader {
  if (!loader) throw new Error('no sheet loader installed');
  return loader;
}

/** Install the sheet loader (the browser's, or a synthetic one in tests). */
export function setPokemonSheetLoader(next: PokemonSheetLoader | null): void {
  loader = next;
}

export function hasPokemonSheetLoader(): boolean {
  return loader !== null;
}

/** Free a decoded sheet's memory now (ImageBitmap.close) rather than at GC. */
function closeSheet(sheet: DecodedSheet): void {
  (sheet.image as { close?: () => void }).close?.();
}

/** Forget every species (tests). */
export function clearPokemonSpecies(): void {
  for (const entry of entries.values()) entry.sheets.forEach(closeSheet);
  entries.clear();
  notify();
}

function isValidAnim(anim: PokemonAnim | undefined): anim is PokemonAnim {
  return (
    !!anim &&
    typeof anim.url === 'string' &&
    Number.isInteger(anim.frameWidth) &&
    anim.frameWidth > 0 &&
    Number.isInteger(anim.frameHeight) &&
    anim.frameHeight > 0 &&
    Number.isInteger(anim.frames) &&
    anim.frames > 0 &&
    Number.isInteger(anim.directions) &&
    anim.directions > 0 &&
    Array.isArray(anim.durations) &&
    anim.durations.length > 0
  );
}

/** The anim the body is measured on: Idle unless it is missing or failed. */
function geometryAnim(entry: SpeciesEntry): string | null {
  for (const name of POKEMON_GEOMETRY_ANIMS) {
    if (entry.info.anims[name] && !entry.failed.has(name)) return name;
  }
  return null;
}

function measure(entry: SpeciesEntry): void {
  if (entry.geometry) return;
  const name = geometryAnim(entry);
  if (!name) return;
  const sheet = entry.sheets.get(name);
  const anim = entry.info.anims[name];
  if (!sheet || !anim || !loader) return;
  // Down row, frame 0.
  const rgba = loader.readPixels(sheet, 0, 0, anim.frameWidth, anim.frameHeight);
  if (!rgba) return;
  entry.geometry = computePokemonGeometry(rgba, anim.frameWidth, anim.frameHeight);
}

function decodeOrder(anims: Record<string, PokemonAnim>): string[] {
  const names = Object.keys(anims);
  const ordered: string[] = POKEMON_DECODE_ORDER.filter((n) => names.includes(n));
  for (const n of names) if (!ordered.includes(n)) ordered.push(n);
  return ordered;
}

async function decode(key: string, entry: SpeciesEntry, name: string): Promise<void> {
  const anim = entry.info.anims[name];
  const epoch = entry.epoch;
  const stale = () => entries.get(key) !== entry || entry.epoch !== epoch;
  try {
    if (!anim || !isAllowedSpriteUrl(anim.url, pageOrigin())) {
      throw new Error('sheet URL not allowed');
    }
    const sheet = await activeLoader().load(anim.url);
    if (stale()) {
      // Replaced or released while decoding: nobody will draw this one.
      closeSheet(sheet);
      return;
    }
    if (
      sheet.width < anim.frameWidth * anim.frames ||
      sheet.height < anim.frameHeight * anim.directions
    ) {
      throw new Error('sheet is smaller than its metadata');
    }
    entry.sheets.set(name, sheet);
    measure(entry);
    notify();
  } catch (err) {
    if (stale()) return;
    entry.failed.add(name);
    // Idle failing hands the measurement to Walk, if Walk is already in.
    measure(entry);
    notify();
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[Webview] Pokémon #${entry.info.dex} ${name} sheet unavailable: ${reason}`);
  }
}

/** Store a species and start decoding its sheets. A resend keeps the sheets
 *  whose URL and frame layout are unchanged. */
export function setPokemonSpecies(msg: PokemonSpeciesLoaded): void {
  if (!Number.isInteger(msg.dex) || typeof msg.anims !== 'object' || msg.anims === null) return;
  const anims: Record<string, PokemonAnim> = {};
  for (const [name, anim] of Object.entries(msg.anims)) {
    if (isValidAnim(anim)) anims[name] = anim;
  }
  const shiny = msg.shiny === true;
  const key = pokemonSpeciesKey(msg.dex, shiny);
  const prev = entries.get(key);
  const info: PokemonSpeciesInfo = {
    dex: msg.dex,
    shiny,
    name: typeof msg.name === 'string' ? msg.name : `#${msg.dex}`,
    anims,
    portraits: msg.portraits ?? {},
    credits: msg.credits ?? { sprite: [], portrait: [], pageUrl: '' },
  };
  const entry: SpeciesEntry = {
    info,
    sheets: new Map(),
    failed: new Set(),
    geometry: null,
    source: {
      has: (anim) => entry.sheets.has(anim),
      durations: (anim) => entry.info.anims[anim]?.durations,
    },
    released: false,
    epoch: 0,
  };
  if (prev) {
    for (const [name, sheet] of prev.sheets) {
      const a = prev.info.anims[name];
      const b = anims[name];
      if (
        a &&
        b &&
        a.url === b.url &&
        a.frameWidth === b.frameWidth &&
        a.frameHeight === b.frameHeight
      ) {
        entry.sheets.set(name, sheet);
      } else {
        closeSheet(sheet);
      }
    }
    if (prev.geometry && geometryAnim(entry) === geometryAnim(prev)) {
      const name = geometryAnim(entry);
      if (name && entry.sheets.has(name)) entry.geometry = prev.geometry;
    }
  }
  entries.set(key, entry);
  notify();
  for (const name of decodeOrder(anims)) {
    if (!entry.sheets.has(name)) void decode(key, entry, name);
  }
}

function release(entry: SpeciesEntry): void {
  entry.sheets.forEach(closeSheet);
  entry.sheets.clear();
  entry.failed.clear();
  entry.geometry = null;
  entry.released = true;
  entry.epoch += 1;
}

function revive(key: string, entry: SpeciesEntry): void {
  entry.released = false;
  entry.unusedSince = undefined;
  for (const name of decodeOrder(entry.info.anims)) void decode(key, entry, name);
}

/** A character is about to use this species: decode it again if a sweep
 *  released it. */
export function retainPokemonSpecies(dex: number, shiny: boolean): void {
  const key = pokemonSpeciesKey(dex, shiny);
  const entry = entries.get(key);
  if (!entry) return;
  entry.unusedSince = undefined;
  if (entry.released) {
    revive(key, entry);
    notify();
  }
}

/**
 * Close the sheets of every species no character has used for
 * `releaseAfterMs`, and decode again the released ones in use. `inUse` holds
 * pokemonSpeciesKey values; `nowMs` is any monotonic-enough clock the caller
 * keeps using.
 */
export function sweepPokemonSheets(
  inUse: ReadonlySet<string>,
  nowMs: number,
  releaseAfterMs = POKEMON_SHEET_RELEASE_AFTER_MS,
): void {
  let changed = false;
  for (const [key, entry] of entries) {
    if (inUse.has(key)) {
      entry.unusedSince = undefined;
      if (entry.released) {
        revive(key, entry);
        changed = true;
      }
      continue;
    }
    entry.unusedSince ??= nowMs;
    if (!entry.released && nowMs - entry.unusedSince >= releaseAfterMs) {
      release(entry);
      changed = true;
    }
  }
  if (changed) notify();
}

export function getPokemonSpeciesInfo(dex: number, shiny: boolean): PokemonSpeciesInfo | undefined {
  return entries.get(pokemonSpeciesKey(dex, shiny))?.info;
}

/** Display name; a shiny falls back to its plain entry's name and back. */
export function getPokemonSpeciesName(dex: number, shiny = false): string | undefined {
  return (
    entries.get(pokemonSpeciesKey(dex, shiny))?.info.name ??
    entries.get(pokemonSpeciesKey(dex, !shiny))?.info.name
  );
}

/** Every species received, for the credits list. */
export function listPokemonSpecies(): PokemonSpeciesInfo[] {
  return Array.from(entries.values(), (e) => e.info);
}

export function getPokemonGeometry(dex: number, shiny: boolean): PokemonGeometry | null {
  return entries.get(pokemonSpeciesKey(dex, shiny))?.geometry ?? null;
}

/** Ready to replace the upstream character: measured, so Idle or Walk is in. */
export function isPokemonReady(dex: number, shiny: boolean): boolean {
  return getPokemonGeometry(dex, shiny) !== null;
}

/** How far a pose reaches from its ground point, in its own pixels: its
 *  widest side (`halfW`), each side, up (`rise`) and down (`drop`). */
export interface PokemonRestPose {
  halfW: number;
  rise: number;
  left: number;
  right: number;
  drop: number;
}

/** A frame's opaque box from its ground point (see computePokemonGeometry). */
function measurePose(
  rgba: ArrayLike<number>,
  frameWidth: number,
  frameHeight: number,
): PokemonRestPose {
  const g = computePokemonGeometry(rgba, frameWidth, frameHeight);
  let minX = frameWidth;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < frameHeight; y++) {
    for (let x = 0; x < frameWidth; x++) {
      if ((rgba[(y * frameWidth + x) * 4 + 3] ?? 0) < POKEMON_ALPHA_THRESHOLD) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) {
    return { halfW: g.bodyHalfW, rise: g.headRise, left: g.anchorX, right: g.anchorX, drop: 0 };
  }
  return {
    halfW: g.bodyHalfW,
    rise: g.headRise,
    left: Math.max(g.anchorX - minX, 0),
    right: Math.max(maxX + 1 - g.anchorX, 0),
    drop: maxY + 1 - g.anchorY,
  };
}

/** Sheet rows a lying Pokémon is drawn in: down, and the two sides a bed's
 *  pillow can be at (PMD rows 0, 2 and 6). */
const REST_ROWS = [0, 2, 6] as const;

/**
 * The reach of one decoded frame of `anim` (sheet `row`, `frame`; clamped to
 * the sheet) from its ground point, measured once. Null when the species
 * isn't measured or that anim isn't decoded.
 */
export function getPokemonPose(
  dex: number,
  shiny: boolean,
  anim: string,
  row: number,
  frame: number,
): PokemonRestPose | null {
  const entry = entries.get(pokemonSpeciesKey(dex, shiny));
  const meta = entry?.info.anims[anim];
  if (!entry?.geometry || !meta) return null;
  const r = Math.min(row, meta.directions - 1);
  const f = Math.min(frame, meta.frames - 1);
  const key = `${anim}:${r}:${f}`;
  entry.poses ??= new Map();
  const held = entry.poses.get(key);
  if (held) return held;
  const sheet = entry.sheets.get(anim);
  if (!sheet || !loader) return null;
  const rgba = loader.readPixels(
    sheet,
    f * meta.frameWidth,
    r * meta.frameHeight,
    meta.frameWidth,
    meta.frameHeight,
  );
  if (!rgba) return null;
  const pose = measurePose(rgba, meta.frameWidth, meta.frameHeight);
  entry.poses.set(key, pose);
  return pose;
}

/**
 * A fainted Pokémon's held pose: the last frame of the first faint anim it
 * has decoded (lying down is wider and lower than standing), measured on
 * sheet `row`. Without a row, the largest reach over the rows a lying
 * Pokémon is drawn in. Falls back to the standing body; null until the
 * species is measured.
 */
export function getPokemonRestPose(
  dex: number,
  shiny: boolean,
  row?: number,
): PokemonRestPose | null {
  const entry = entries.get(pokemonSpeciesKey(dex, shiny));
  if (!entry?.geometry) return null;
  const g = entry.geometry;
  const standing = {
    halfW: g.bodyHalfW,
    rise: g.headRise,
    left: g.bodyHalfW,
    right: g.bodyHalfW,
    drop: POKEMON_FEET_BELOW_GROUND_PX,
  };
  const name = POKEMON_ANIM_FALLBACKS.faint.find((n) => entry.sheets.has(n));
  const meta = name ? entry.info.anims[name] : undefined;
  if (!name || !meta) return standing;
  const held = (r: number) => getPokemonPose(dex, shiny, name, r, meta.frames - 1) ?? standing;
  if (row !== undefined) return held(row);
  const poses = REST_ROWS.map(held);
  const most = (k: keyof PokemonRestPose) => Math.max(...poses.map((p) => p[k]));
  return {
    halfW: most('halfW'),
    rise: most('rise'),
    left: most('left'),
    right: most('right'),
    drop: most('drop'),
  };
}

export function getPokemonAnimMeta(
  dex: number,
  shiny: boolean,
  anim: string,
): PokemonAnim | undefined {
  return entries.get(pokemonSpeciesKey(dex, shiny))?.info.anims[anim];
}

export function getPokemonSheet(
  dex: number,
  shiny: boolean,
  anim: string,
): DecodedSheet | undefined {
  return entries.get(pokemonSpeciesKey(dex, shiny))?.sheets.get(anim);
}

/** What the species can play (decoded sheets), for pokemonAnim. */
export function getPokemonAnimSource(dex: number, shiny: boolean): PokemonAnimSource | null {
  return entries.get(pokemonSpeciesKey(dex, shiny))?.source ?? null;
}
