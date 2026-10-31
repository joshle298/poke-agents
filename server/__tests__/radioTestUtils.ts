/**
 * Synthetic Poke Agents Radio tracks for tests: made-up bytes (never audio)
 * pinned by their real size and SHA-256, and a fake fetch that serves them.
 * No test reaches the network.
 */

import * as crypto from 'crypto';
import { vi } from 'vitest';

import { CC0_LICENSE } from '../../core/src/radioCredits.js';
import type { RadioFetch } from '../src/music/radioCache.js';
import type { RadioTrack } from '../src/music/radioCatalog.js';

export const RADIO_TEST_HOST = 'https://music.example';

/** Bytes standing in for a track: an Ogg-looking header and a pattern. */
export function syntheticTrackBytes(seed: number, length = 2048): Buffer {
  const bytes = Buffer.alloc(length);
  bytes.write('OggS', 0, 'latin1');
  for (let i = 4; i < length; i++) bytes[i] = (i * 31 + seed * 7) % 251;
  return bytes;
}

export function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** A catalog track pinned to `bytes`. */
export function radioTrack(
  slug: string,
  bytes: Buffer,
  extra: Partial<RadioTrack> = {},
): RadioTrack {
  return {
    id: `radio-${slug}`,
    title: `Title ${slug}`,
    author: `Author ${slug}`,
    license: CC0_LICENSE,
    sourceUrl: `${RADIO_TEST_HOST}/content/${slug}`,
    url: `${RADIO_TEST_HOST}/files/${slug}.ogg`,
    bytes: bytes.length,
    sha256: sha256(bytes),
    mimeType: 'audio/ogg',
    lufs: -18,
    fileName: `radio-${slug}.ogg`,
    gain: 1,
    ...extra,
  };
}

/** A fetch that answers each URL from `files` (200) and anything else with
 *  404. `override` can replace one URL's answer. */
export function fakeRadioFetch(
  files: Record<string, Buffer>,
  override: (url: string) => Response | Promise<Response> | undefined = () => undefined,
) {
  return vi.fn<RadioFetch>(async (url) => {
    const custom = await override(url);
    if (custom) return custom;
    const body = files[url];
    if (!body) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { 'content-length': String(body.length) },
    });
  });
}

/** A fetch that fails the test if anything calls it. */
export function forbiddenFetch() {
  return vi.fn<RadioFetch>(async (url) => {
    throw new Error(`unexpected radio download: ${url}`);
  });
}
