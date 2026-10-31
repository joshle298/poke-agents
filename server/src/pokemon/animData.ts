/**
 * PMDCollab AnimData.xml parsing and sheet validation. Pure: no I/O.
 *
 * AnimData.xml is machine-written by SpriteBot, so a small tag reader is
 * enough (no XML dependency). It is still downloaded content, so every value
 * is range-checked and anything malformed is dropped rather than trusted.
 *
 * Schema (SpriteBot SpriteUtils.getStatsFromTree): an <Anim> either carries
 * FrameWidth, FrameHeight and Durations, or only <CopyOf> naming another anim
 * whose sheet it reuses (it has no PNG of its own). Sheet width is
 * FrameWidth x frame count; height is FrameHeight x 8 directions, or x 1.
 */

import {
  PMD_ANIM_NAME,
  PMD_COPYOF_MAX_HOPS,
  PMD_DIRECTIONS_FULL,
  PMD_MAX_DURATION,
  PMD_MAX_FRAME_PX,
  PMD_MAX_FRAMES,
} from './constants.js';

export interface RawAnim {
  index?: number;
  frameWidth?: number;
  frameHeight?: number;
  /** Per-frame hold in 60 fps game frames. Empty for a CopyOf alias. */
  durations: number[];
  copyOf?: string;
  rushFrame?: number;
  hitFrame?: number;
  returnFrame?: number;
}

export interface AnimData {
  shadowSize: 0 | 1 | 2;
  anims: Record<string, RawAnim>;
}

export interface ResolvedAnim {
  /** The requested name (e.g. Shoot). */
  name: string;
  /** The anim whose sheet is drawn (e.g. Charge when Shoot is CopyOf Charge). */
  source: string;
  /** Sheet file name: `<source>-Anim.png`. */
  file: string;
  frameWidth: number;
  frameHeight: number;
  durations: number[];
  rushFrame?: number;
  hitFrame?: number;
  returnFrame?: number;
}

export type SheetCheck =
  { ok: true; frames: number; directions: 1 | 8 } | { ok: false; reason: string };

const ANIM_BLOCK = /<Anim>([\s\S]*?)<\/Anim>/g;
const DURATION = /<Duration>\s*(\d+)\s*<\/Duration>/g;

function tagText(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(block);
  return match ? match[1] : undefined;
}

function intTag(block: string, tag: string, min: number, max: number): number | undefined {
  const text = tagText(block, tag);
  if (text === undefined || !/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return value >= min && value <= max ? value : undefined;
}

/**
 * Parse AnimData.xml. Anims with an invalid name, an invalid CopyOf target or
 * incomplete frame data are skipped; returns null when nothing usable remains.
 */
export function parseAnimData(xml: string): AnimData | null {
  const shadowText = tagText(xml, 'ShadowSize');
  const shadowSize = shadowText === '1' ? 1 : shadowText === '2' ? 2 : 0;
  const anims: Record<string, RawAnim> = {};

  for (const [, block] of xml.matchAll(ANIM_BLOCK)) {
    const name = tagText(block, 'Name');
    if (!name || !PMD_ANIM_NAME.test(name) || Object.hasOwn(anims, name)) continue;
    const index = intTag(block, 'Index', 0, 999);
    const copyOf = tagText(block, 'CopyOf');
    if (copyOf !== undefined) {
      if (!PMD_ANIM_NAME.test(copyOf) || copyOf === name) continue;
      anims[name] = { index, durations: [], copyOf };
      continue;
    }

    const frameWidth = intTag(block, 'FrameWidth', 1, PMD_MAX_FRAME_PX);
    const frameHeight = intTag(block, 'FrameHeight', 1, PMD_MAX_FRAME_PX);
    const durationsBlock = /<Durations>([\s\S]*?)<\/Durations>/.exec(block)?.[1] ?? '';
    const durations = [...durationsBlock.matchAll(DURATION)].map((m) => Number(m[1]));
    if (
      frameWidth === undefined ||
      frameHeight === undefined ||
      durations.length === 0 ||
      durations.length > PMD_MAX_FRAMES ||
      durations.some((d) => d < 1 || d > PMD_MAX_DURATION)
    ) {
      continue;
    }
    // Marker frames index into the frame list; drop any that point past it.
    const frameIndex = (tag: string) => intTag(block, tag, 0, durations.length - 1);
    anims[name] = {
      index,
      frameWidth,
      frameHeight,
      durations,
      rushFrame: frameIndex('RushFrame'),
      hitFrame: frameIndex('HitFrame'),
      returnFrame: frameIndex('ReturnFrame'),
    };
  }

  return Object.keys(anims).length > 0 ? { shadowSize, anims } : null;
}

/**
 * Follow CopyOf aliases to the anim that owns a sheet. Null when the name is
 * absent, the chain is broken, cycles or exceeds `maxHops`.
 */
export function resolveAnim(
  data: AnimData,
  name: string,
  maxHops = PMD_COPYOF_MAX_HOPS,
): ResolvedAnim | null {
  let source = name;
  for (let hop = 0; hop <= maxHops; hop++) {
    const anim = Object.hasOwn(data.anims, source) ? data.anims[source] : undefined;
    if (!anim) return null;
    if (anim.copyOf === undefined) {
      if (anim.frameWidth === undefined || anim.frameHeight === undefined) return null;
      return {
        name,
        source,
        file: `${source}-Anim.png`,
        frameWidth: anim.frameWidth,
        frameHeight: anim.frameHeight,
        durations: anim.durations,
        rushFrame: anim.rushFrame,
        hitFrame: anim.hitFrame,
        returnFrame: anim.returnFrame,
      };
    }
    source = anim.copyOf;
  }
  return null;
}

/** Names of anims that have a sheet of their own (not CopyOf aliases). */
export function sheetAnimNames(data: AnimData): Set<string> {
  return new Set(Object.keys(data.anims).filter((name) => data.anims[name].copyOf === undefined));
}

/**
 * Check a sheet's pixel size against its AnimData entry: width must be
 * frameWidth x frames and height frameHeight x 8 or x 1.
 */
export function validateSheet(
  anim: Pick<ResolvedAnim, 'frameWidth' | 'frameHeight' | 'durations'>,
  pngWidth: number,
  pngHeight: number,
): SheetCheck {
  const frames = anim.durations.length;
  if (frames === 0) return { ok: false, reason: 'no frames' };
  if (pngWidth !== anim.frameWidth * frames) {
    return {
      ok: false,
      reason: `width ${pngWidth} is not ${anim.frameWidth} x ${frames} frames`,
    };
  }
  if (pngHeight === anim.frameHeight * PMD_DIRECTIONS_FULL) {
    return { ok: true, frames, directions: PMD_DIRECTIONS_FULL };
  }
  if (pngHeight === anim.frameHeight) return { ok: true, frames, directions: 1 };
  return {
    ok: false,
    reason: `height ${pngHeight} is not ${anim.frameHeight} x 8 or x 1 directions`,
  };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.equals(bytes.subarray(0, 8));
}

/**
 * Width and height from a PNG's IHDR chunk, or null when the bytes are not a
 * PNG. Reads the 24-byte header only: validating a sheet needs its size, and a
 * full decode of a large Attack sheet costs tens of milliseconds of event loop.
 */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || !hasPngSignature(bytes)) return null;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.readUInt32BE(8) !== 13 || view.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = view.readUInt32BE(16);
  const height = view.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
