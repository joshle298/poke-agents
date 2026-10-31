/**
 * The browser's Pokémon sheet loader: `fetch(url) → blob → createImageBitmap`,
 * and pixel reads through a scratch canvas for measuring a body.
 *
 * Kept apart from the DOM-free store (pokemonSprites.ts) so OfficeState's
 * module graph — which the Node test runner imports and type-checks — never
 * sees a DOM type. The message handler installs it before the first species
 * arrives.
 */

import type { PokemonSheetLoader } from './pokemonSprites.js';
import { hasPokemonSheetLoader, setPokemonSheetLoader } from './pokemonSprites.js';

type ScratchContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function scratchContext(w: number, h: number): ScratchContext | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h).getContext('2d');
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas.getContext('2d');
}

const browserSheetLoader: PokemonSheetLoader = {
  async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const image = await createImageBitmap(await res.blob());
    return { image, width: image.width, height: image.height };
  },
  readPixels(sheet, sx, sy, sw, sh) {
    const ctx = scratchContext(sw, sh);
    if (!ctx) return null;
    ctx.drawImage(sheet.image as CanvasImageSource, sx, sy, sw, sh, 0, 0, sw, sh);
    return ctx.getImageData(0, 0, sw, sh).data;
  },
};

/** Install the browser loader unless one (a test's) is already in place. */
export function installBrowserSheetLoader(): void {
  if (!hasPokemonSheetLoader()) setPokemonSheetLoader(browserSheetLoader);
}
