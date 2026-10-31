import { CONDUCTOR_KEY_PATTERN, CONDUCTOR_KEY_WIRE_MAX_LENGTH } from './constants.js';

/**
 * The keys to try for pasted text, in order: the text trimmed and, when it is
 * exactly one string twice (a key pasted twice), a single copy first. Only
 * candidates with a Conductor API key's shape are kept, so an empty list means
 * the text isn't a key. The office's Connect card and the server's connect ask
 * this; only the server decides, with GET /me, which one Conductor accepts.
 *
 * Why: `conductor auth login` once saved a 98-character key that was the same
 * 49 characters twice, and Conductor rejected it.
 */
export function conductorKeyCandidates(text: string): string[] {
  if (text.length > CONDUCTOR_KEY_WIRE_MAX_LENGTH) return [];
  const value = text.trim();
  const once = singleCopy(value);
  const candidates = once === undefined ? [value] : [once, value];
  return candidates.filter((key) => CONDUCTOR_KEY_PATTERN.test(key));
}

/** The repeated string when `value` is exactly one string twice. */
function singleCopy(value: string): string | undefined {
  const half = value.length / 2;
  if (!Number.isInteger(half) || half === 0) return undefined;
  const first = value.slice(0, half);
  return first === value.slice(half) ? first : undefined;
}
