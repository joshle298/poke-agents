/** Names that come from outside (the Music and Spotify apps, Spotify's oEmbed,
 *  link slugs), made safe to keep and show: one line, printable, bounded. */

import { MUSIC_NAME_MAX_LENGTH } from './constants.js';

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

export function cleanName(raw: unknown, max: number = MUSIC_NAME_MAX_LENGTH): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let text = '';
  for (const char of raw.normalize('NFC')) {
    text += isControl(char.charCodeAt(0)) ? ' ' : char;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
