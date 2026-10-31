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
  POKEMON_GEOMETRY_ANIMS,
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
  /** Half-width of the held faint pose, and the anim it was measured on. */
  rest?: { anim: string; halfW: number };
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

/** Forget every species (tests). */
export function clearPokemonSpecies(): void {
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
  try {
    if (!anim || !isAllowedSpriteUrl(anim.url, pageOrigin())) {
      throw new Error('sheet URL not allowed');
    }
    const sheet = await activeLoader().load(anim.url);
    if (entries.get(key) !== entry) return; // replaced while decoding
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
    if (entries.get(key) !== entry) return;
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

/**
 * How far a fainted Pokémon's held pose reaches sideways from its ground
 * point, in its own pixels: measured once on the last frame (Down row) of the
 * first faint anim it has decoded (lying down is wider than standing), else
 * the standing body's half-width. Null until the species is measured.
 */
export function getPokemonRestHalfWidth(dex: number, shiny: boolean): number | null {
  const entry = entries.get(pokemonSpeciesKey(dex, shiny));
  if (!entry?.geometry) return null;
  const name = POKEMON_ANIM_FALLBACKS.faint.find((n) => entry.sheets.has(n));
  if (!name) return entry.geometry.bodyHalfW;
  if (entry.rest?.anim === name) return entry.rest.halfW;
  const anim = entry.info.anims[name];
  const sheet = entry.sheets.get(name);
  const rgba =
    anim && sheet && loader
      ? loader.readPixels(
          sheet,
          (anim.frames - 1) * anim.frameWidth,
          0,
          anim.frameWidth,
          anim.frameHeight,
        )
      : null;
  if (!anim || !rgba) return entry.geometry.bodyHalfW;
  const halfW = computePokemonGeometry(rgba, anim.frameWidth, anim.frameHeight).bodyHalfW;
  entry.rest = { anim: name, halfW };
  return halfW;
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
