/**
 * Synthetic sound fixtures for the audio tests: Ogg/MP3/WAV byte strings that
 * carry only the format's signature plus filler, and an in-memory PokéAPI
 * cries upstream. No real audio, no network.
 */

import type { CryFetch } from '../src/audio/cryCache.js';

export const CRY_BASE = 'https://cries.test/cries/pokemon';

/** A tiny fake Ogg page: the `OggS` capture pattern, version 0, a BOS flag,
 *  then `tag` so two files can be told apart. */
export function syntheticOgg(tag = 'cry'): Buffer {
  return Buffer.concat([
    Buffer.from('OggS', 'latin1'),
    Buffer.from([0x00, 0x02]),
    Buffer.alloc(20, 0x11),
    Buffer.from(tag, 'utf8'),
  ]);
}

export function syntheticMp3(): Buffer {
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([0x04, 0, 0]), Buffer.alloc(32)]);
}

export function syntheticWav(): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  return header;
}

export interface CryUpstreamFile {
  body: Buffer;
  etag?: string;
  status?: number;
}

/** An in-memory cries upstream keyed by `<variant>/<dex>.ogg`. */
export class FakeCryUpstream {
  readonly files = new Map<string, CryUpstreamFile>();
  readonly calls: Array<{ url: string; headers: Record<string, string> }> = [];
  /** Throw (network failure) instead of answering. */
  offline = false;
  /** When set, a request blocks until releaseAll. */
  hold = false;
  private held: Array<() => void> = [];

  set(variant: string, dex: number, body: Buffer, etag?: string, status?: number): void {
    this.files.set(`${variant}/${dex}.ogg`, { body, etag, status });
  }

  releaseAll(): void {
    const held = this.held;
    this.held = [];
    for (const release of held) release();
  }

  callsFor(variant: string, dex: number): number {
    return this.calls.filter((c) => c.url === `${CRY_BASE}/${variant}/${dex}.ogg`).length;
  }

  readonly fetch: CryFetch = async (url, init) => {
    this.calls.push({ url, headers: { ...init.headers } });
    if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve));
    if (this.offline) throw new TypeError('fetch failed');
    if (!url.startsWith(`${CRY_BASE}/`)) throw new Error(`unexpected host: ${url}`);
    const file = this.files.get(url.slice(CRY_BASE.length + 1));
    if (!file) return new Response('Not Found', { status: 404 });
    if (file.status !== undefined && file.status !== 200) {
      return new Response('error', { status: file.status });
    }
    if (file.etag && init.headers['if-none-match'] === file.etag) {
      return new Response(null, { status: 304 });
    }
    const headers = new Headers({ 'content-type': 'audio/ogg' });
    if (file.etag) headers.set('etag', file.etag);
    return new Response(new Uint8Array(file.body), { status: 200, headers });
  };
}
