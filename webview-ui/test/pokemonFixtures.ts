/**
 * Synthetic Pokémon species for the office tests: hand-built metadata and a
 * fake sheet loader that "decodes" data URLs into blank images with a known
 * opaque box. No Pokémon art anywhere.
 */

import type { PokemonAnim, PokemonSpeciesLoaded } from '../../core/src/messages.js';
import type { DecodedSheet, PokemonSheetLoader } from '../src/office/sprites/pokemonSprites.js';
import {
  clearPokemonSpecies,
  setPokemonSheetLoader,
} from '../src/office/sprites/pokemonSprites.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

/** Opaque box drawn into frame 0 of a fake sheet, in frame pixels (inclusive). */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface FakeSheet extends DecodedSheet {
  frameWidth: number;
  frameHeight: number;
  box?: Box;
}

export interface FakeAnim {
  frameWidth: number;
  frameHeight: number;
  durations: number[];
  directions?: number;
  /** Opaque box in frame 0 (only Idle / Walk are measured). */
  box?: Box;
}

/** Idle body of the default species: 12 wide, 16 tall, feet near the ground. */
export const IDLE_BOX: Box = { x0: 14, y0: 20, x1: 25, y1: 35 };

/** A full species: frames 40×56 Idle (ground point (20, 32)), 32×40 Walk. */
export const DEFAULT_ANIMS: Record<string, FakeAnim> = {
  Idle: { frameWidth: 40, frameHeight: 56, durations: [40, 2, 3, 3, 3, 2], box: IDLE_BOX },
  Walk: {
    frameWidth: 32,
    frameHeight: 40,
    durations: [8, 10, 8, 10],
    box: { x0: 10, y0: 10, x1: 21, y1: 27 },
  },
  Sleep: { frameWidth: 32, frameHeight: 40, durations: [30, 35], directions: 1 },
  Charge: { frameWidth: 40, frameHeight: 40, durations: [2, 2, 2, 2] },
  Hurt: { frameWidth: 48, frameHeight: 64, durations: [2, 8] },
  Faint: { frameWidth: 48, frameHeight: 64, durations: [4, 4, 4] },
  Hop: { frameWidth: 32, frameHeight: 48, durations: [3, 3, 3] },
  Attack: { frameWidth: 80, frameHeight: 80, durations: [2, 4, 1, 1] },
  Wake: { frameWidth: 32, frameHeight: 40, durations: [5, 5] },
};

const sheetUrl = (dex: number, shiny: boolean, anim: string) =>
  `data:image/png;base64,${dex}-${shiny ? 's' : 'n'}-${anim}`;

export function speciesMessage(
  dex: number,
  opts: { shiny?: boolean; name?: string; anims?: Record<string, FakeAnim> } = {},
): PokemonSpeciesLoaded {
  const shiny = opts.shiny === true;
  const anims: Record<string, PokemonAnim> = {};
  for (const [name, a] of Object.entries(opts.anims ?? DEFAULT_ANIMS)) {
    anims[name] = {
      url: sheetUrl(dex, shiny, name),
      frameWidth: a.frameWidth,
      frameHeight: a.frameHeight,
      frames: a.durations.length,
      directions: a.directions ?? 8,
      durations: a.durations,
    };
  }
  return {
    type: 'pokemonSpeciesLoaded',
    dex,
    shiny,
    name: opts.name ?? `Mon${dex}`,
    shadowSize: 1,
    anims,
    portraits: { Normal: `data:image/png;base64,portrait-${dex}` },
    credits: { sprite: ['Synthetic'], portrait: [], pageUrl: '' },
  };
}

/**
 * A loader for `speciesMessage` URLs. `fail` names anims whose decode
 * rejects; `shrink` names anims whose decoded sheet is too small. Every load
 * returns a fresh image whose close() (ImageBitmap.close) is recorded in
 * `closed` by URL.
 */
export function installFakeLoader(
  msgs: PokemonSpeciesLoaded[],
  opts: { fail?: string[]; shrink?: string[]; boxes?: Record<string, Box> } = {},
): { loads: string[]; closed: string[] } {
  const byUrl = new Map<string, FakeSheet>();
  for (const msg of msgs) {
    for (const [name, a] of Object.entries(msg.anims)) {
      const small = opts.shrink?.includes(name);
      byUrl.set(a.url, {
        image: { url: a.url },
        width: small ? a.frameWidth : a.frameWidth * a.frames,
        height: small ? a.frameHeight : a.frameHeight * a.directions,
        frameWidth: a.frameWidth,
        frameHeight: a.frameHeight,
        box: opts.boxes?.[name] ?? DEFAULT_ANIMS[name]?.box,
      });
    }
  }
  const loads: string[] = [];
  const closed: string[] = [];
  const loader: PokemonSheetLoader = {
    async load(url) {
      loads.push(url);
      const sheet = byUrl.get(url);
      const anim = url.split('-').pop() ?? '';
      if (!sheet || opts.fail?.includes(anim)) throw new Error(`no sheet for ${url}`);
      return { ...sheet, image: { url, close: () => closed.push(url) } };
    },
    readPixels(sheet, sx, sy, sw, sh) {
      const fake = sheet as FakeSheet;
      const rgba = new Uint8ClampedArray(sw * sh * 4);
      const box = fake.box;
      if (!box) return rgba;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const fx = sx + x;
          const fy = sy + y;
          if (fx >= box.x0 && fx <= box.x1 && fy >= box.y0 && fy <= box.y1) {
            rgba[(y * sw + x) * 4 + 3] = 255;
          }
        }
      }
      return rgba;
    },
  };
  setPokemonSheetLoader(loader);
  return { loads, closed };
}

/** Let pending sheet decodes settle. */
export async function flushDecodes(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function resetPokemonStore(): void {
  clearPokemonSpecies();
  setPokemonSheetLoader(null);
}

/** All-floor layout, no furniture: every tile walkable, no seats. */
export function floorLayout(cols = 12, rows = 10): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}
