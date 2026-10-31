/**
 * In-house pixel art for the Pokémon office (no Pokémon art: these are drawn
 * here, as JSON palettes + pixels like the speech bubbles): the Poké Ball the
 * spawn effect and message projectiles use, the envelope flown when the theme
 * is off, and the needs-you "!" and sleeping "z" bubbles.
 */

import type { SpriteData } from '../types.js';
import bubbleAlertData from './bubble-alert.json';
import bubbleSleepData from './bubble-sleep.json';
import envelopeData from './envelope.json';
import pokeballData from './pokeball.json';

type Palette = Record<string, string>;

function resolve(palette: Palette, pixels: string[][]): SpriteData {
  return pixels.map((row) => row.map((key) => palette[key] ?? key));
}

/** Closed Poké Ball (10x10): thrown, recalled, and flown as a message. */
export const POKEBALL_CLOSED_SPRITE: SpriteData = resolve(
  pokeballData.palette,
  pokeballData.frames.closed,
);

/** Open Poké Ball (10x10): the moment it pops. */
export const POKEBALL_OPEN_SPRITE: SpriteData = resolve(
  pokeballData.palette,
  pokeballData.frames.open,
);

/** Envelope (7x5): a message in flight while the theme is off. */
export const ENVELOPE_SPRITE: SpriteData = resolve(envelopeData.palette, envelopeData.pixels);

/** Needs-you bubble (11x13): white square with a red "!". */
export const BUBBLE_ALERT_SPRITE: SpriteData = resolve(
  bubbleAlertData.palette,
  bubbleAlertData.pixels,
);

/** Sleeping (11x13): a small and a large "z". */
export const BUBBLE_SLEEP_SPRITE: SpriteData = resolve(
  bubbleSleepData.palette,
  bubbleSleepData.pixels,
);
