/**
 * What the Mac app hands the office from the clipboard: a Conductor API key,
 * or nothing. Main reads the clipboard only when the office window asks while
 * it is focused (the Connect card's Paste click, or the window regaining focus
 * after "Get an API key"), and answers with key-shaped text only, so no other
 * clipboard content ever reaches the page. Pure, so it is tested without
 * Electron.
 */

import { API_KEY_PATTERN } from '../../server/src/providers/stream/conductor/constants.js';

/** The clipboard text when, trimmed, it has a Conductor API key's shape.
 *  Typed `string` on purpose: Electron's `clipboard.readText()` is async, and
 *  a Promise passed here must fail to compile, not quietly answer null. */
export function clipboardKey(text: string): string | null {
  const key = text.trim();
  return API_KEY_PATTERN.test(key) ? key : null;
}
