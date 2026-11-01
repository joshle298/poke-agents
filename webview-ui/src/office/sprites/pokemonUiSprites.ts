/**
 * In-house pixel art for the Pokémon office (no Pokémon art: these are drawn
 * here, as JSON palettes + pixels like the speech bubbles): the catch orb the
 * spawn effect and message projectiles use and that stands in for a Pokémon
 * whose sprites are still loading, Promptling (our mascot, the greeter), the
 * envelope flown when the theme is off, and the needs-you "!" and sleeping
 * "z" bubbles. The orb and Promptling are original designs, not renditions
 * of any official ball or Pokémon.
 */

import type { SpriteData } from '../types.js';
import bubbleAlertData from './bubble-alert.json';
import bubbleSleepData from './bubble-sleep.json';
import envelopeData from './envelope.json';
import orbData from './orb.json';
import promptlingData from './promptling.json';

type Palette = Record<string, string>;

function resolve(palette: Palette, pixels: string[][]): SpriteData {
  return pixels.map((row) => row.map((key) => palette[key] ?? key));
}

/** A frame written as one string per row, one palette key per pixel. */
const rows = (frame: string[]): string[][] => frame.map((row) => [...row]);

/** Closed orb (16x16), the C round it open on the right: resting while a
 *  Pokémon's sprites load, thrown, recalled and flown as a message. */
export const ORB_CLOSED_SPRITE: SpriteData = resolve(orbData.palette, rows(orbData.frames.closed));

/** The C spinning clockwise round the sphere (16x16 each): its opening on
 *  the right (closed), then below, on the left and above. Played in a loop
 *  while the orb flies. */
export const ORB_SPIN_SPRITES: readonly SpriteData[] = [
  ORB_CLOSED_SPRITE,
  resolve(orbData.palette, rows(orbData.frames.spinDown)),
  resolve(orbData.palette, rows(orbData.frames.spinLeft)),
  resolve(orbData.palette, rows(orbData.frames.spinUp)),
];

/** Open orb (16x16): the closed orb with a slit of light rising through its
 *  centre to the latch side and spilling out of the C's opening. */
export const ORB_OPEN_SPRITE: SpriteData = resolve(orbData.palette, rows(orbData.frames.open));

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
