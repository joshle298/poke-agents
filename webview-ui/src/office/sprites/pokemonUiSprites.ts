/**
 * In-house pixel art for the Pokémon office (no Pokémon art: these are drawn
 * here, as JSON palettes + pixels like the speech bubbles): the capsule the
 * spawn effect and message projectiles use and that stands in for a Pokémon
 * whose sprites are still loading, Promptling (our mascot, the greeter), the
 * envelope flown when the theme is off, and the needs-you "!" and sleeping
 * "z" bubbles. The capsule and Promptling are original designs, not
 * renditions of any official ball or Pokémon.
 */

import type { SpriteData } from '../types.js';
import bubbleAlertData from './bubble-alert.json';
import bubbleSleepData from './bubble-sleep.json';
import capsuleData from './capsule.json';
import envelopeData from './envelope.json';
import promptlingData from './promptling.json';

type Palette = Record<string, string>;

function resolve(palette: Palette, pixels: string[][]): SpriteData {
  return pixels.map((row) => row.map((key) => palette[key] ?? key));
}

/** A frame written as one string per row, one palette key per pixel. */
const rows = (frame: string[]): string[][] => frame.map((row) => [...row]);

/** Closed capsule (16x8): thrown, recalled, and flown as a message. */
export const CAPSULE_CLOSED_SPRITE: SpriteData = resolve(
  capsuleData.palette,
  rows(capsuleData.frames.closed),
);

/** Open capsule (23x8): its halves pulled apart, light on the centre line. */
export const CAPSULE_OPEN_SPRITE: SpriteData = resolve(
  capsuleData.palette,
  rows(capsuleData.frames.open),
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

/** Promptling (22x23), Poke Agents' mascot: the Intro's greeter while the
 *  Pokémon theme is on, in place of an upstream character. */
export const PROMPTLING_SPRITE: SpriteData = resolve(
  promptlingData.palette,
  rows(promptlingData.pixels),
);
