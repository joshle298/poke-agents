import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  CC_BY_4_LICENSE,
  CC0_LICENSE,
  RADIO_CREDITS,
  RADIO_STATION_NAME,
} from '../../core/src/radioCredits.js';
import { RADIO_SOURCE_HOSTS, RADIO_TARGET_LUFS } from '../src/music/constants.js';
import { isRadioTrackId } from '../src/music/radioCache.js';
import { buildRadioCatalog, RADIO_FILES, radioGain } from '../src/music/radioCatalog.js';

const README = fs.readFileSync(path.join(__dirname, '../../README.md'), 'utf-8');

/** A README credit line, as the "Radio credits" section writes each track. */
function creditLine(credit: (typeof RADIO_CREDITS)[number]): string {
  const host = new URL(credit.sourceUrl).hostname;
  return `- ${credit.title} — ${credit.author} — [${credit.license.name}](${credit.license.url}) — [${host}](${credit.sourceUrl})`;
}

describe('Poke Agents Radio catalog', () => {
  it('pins a file for every credited track and credits every pinned file', () => {
    const credited = RADIO_CREDITS.map((c) => c.id);
    expect(new Set(credited).size).toBe(credited.length);
    expect(Object.keys(RADIO_FILES).sort()).toEqual([...credited].sort());
    expect(buildRadioCatalog().map((t) => t.id)).toEqual(credited);
    expect(credited.length).toBeGreaterThanOrEqual(8);
    expect(credited.length).toBeLessThanOrEqual(15);
  });

  it('uses radio ids, https pages and files on the allowed hosts, and exact pins', () => {
    for (const track of buildRadioCatalog()) {
      expect(isRadioTrackId(track.id), track.id).toBe(true);
      for (const url of [track.url, track.sourceUrl]) {
        const parsed = new URL(url);
        expect(parsed.protocol, url).toBe('https:');
        expect(RADIO_SOURCE_HOSTS, url).toContain(parsed.hostname);
      }
      expect(track.sha256, track.id).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(track.bytes) && track.bytes > 0, track.id).toBe(true);
      expect(track.bytes, track.id).toBeLessThan(10 * 1024 * 1024);
      const ext = track.mimeType === 'audio/ogg' ? '.ogg' : '.mp3';
      expect(new URL(track.url).pathname.endsWith(ext), track.id).toBe(true);
      expect(track.fileName).toBe(`${track.id}${ext}`);
    }
  });

  it('plays only CC0 or CC BY tracks, never a cover, remix or game theme', () => {
    for (const credit of RADIO_CREDITS) {
      expect([CC0_LICENSE, CC_BY_4_LICENSE], credit.id).toContain(credit.license);
      expect(credit.title, credit.id).not.toMatch(
        /cover|remix|arrange|tribute|medley|pok[eé]mon|theme from/i,
      );
      expect(credit.author.trim(), credit.id).not.toBe('');
    }
    expect(CC0_LICENSE.url).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    expect(CC_BY_4_LICENSE.url).toBe('https://creativecommons.org/licenses/by/4.0/');
  });

  it('turns louder tracks down to the station loudness, and none up', () => {
    expect(RADIO_TARGET_LUFS).toBe(-18);
    expect(radioGain(-18)).toBe(1);
    expect(radioGain(-24)).toBe(1);
    expect(radioGain(-12)).toBeCloseTo(0.501, 3);
    expect(radioGain(-8)).toBeCloseTo(0.316, 3);
    for (const track of buildRadioCatalog()) {
      expect(track.gain, track.id).toBeGreaterThan(0);
      expect(track.gain, track.id).toBeLessThanOrEqual(1);
      // The quiet tracks sit close enough below the target not to drop out.
      expect(track.lufs, track.id).toBeGreaterThan(RADIO_TARGET_LUFS - 1.5);
    }
  });

  it('leaves out a credit with no pinned file rather than serving it unpinned', () => {
    const [first, second] = RADIO_CREDITS;
    const tracks = buildRadioCatalog([first, second], { [first.id]: RADIO_FILES[first.id] });
    expect(tracks.map((t) => t.id)).toEqual([first.id]);
  });

  it('is credited in the README, track by track, as CC BY asks', () => {
    const start = README.indexOf('\n### Radio credits\n');
    expect(start).toBeGreaterThan(0);
    const rest = README.slice(start + 1);
    const end = rest.slice(1).search(/\n#{1,3} /);
    const section = end < 0 ? rest : rest.slice(0, end + 1);
    expect(section).toContain(RADIO_STATION_NAME);
    for (const credit of RADIO_CREDITS) expect(section).toContain(creditLine(credit));
    const lines = section.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(RADIO_CREDITS.length);
    // The Music section counts them too.
    expect(README).toContain(`Poke Agents Radio, ${RADIO_CREDITS.length} original`);
  });
});
