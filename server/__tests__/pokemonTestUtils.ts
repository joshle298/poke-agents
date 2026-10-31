/**
 * Synthetic PMDCollab upstream for the Pokémon tests: solid-colour PNGs made
 * with pngjs, hand-written AnimData.xml and invented credits. No real art,
 * no network.
 */

import { PNG } from 'pngjs';

import type { PmdFetch } from '../src/pokemon/pmdCache.js';

export const PRIMARY = 'https://primary.test/pmd';
export const FALLBACK = 'https://fallback.test/pmd';

/** A width x height PNG filled with one opaque colour. */
export function solidPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0x40;
    png.data[i + 1] = 0x80;
    png.data[i + 2] = 0xc0;
    png.data[i + 3] = 0xff;
  }
  return PNG.sync.write(png);
}

export interface XmlAnim {
  name: string;
  index?: number;
  w?: number;
  h?: number;
  durations?: number[];
  copyOf?: string;
  rushFrame?: number;
  hitFrame?: number;
  returnFrame?: number;
}

export function animDataXml(anims: XmlAnim[], shadowSize = 1): string {
  const body = anims
    .map((a) => {
      const lines = [`\t\t\t<Name>${a.name}</Name>`];
      if (a.index !== undefined) lines.push(`\t\t\t<Index>${a.index}</Index>`);
      if (a.copyOf !== undefined) {
        lines.push(`\t\t\t<CopyOf>${a.copyOf}</CopyOf>`);
      } else {
        lines.push(
          `\t\t\t<FrameWidth>${a.w}</FrameWidth>`,
          `\t\t\t<FrameHeight>${a.h}</FrameHeight>`,
        );
        if (a.rushFrame !== undefined) lines.push(`\t\t\t<RushFrame>${a.rushFrame}</RushFrame>`);
        if (a.hitFrame !== undefined) lines.push(`\t\t\t<HitFrame>${a.hitFrame}</HitFrame>`);
        if (a.returnFrame !== undefined) {
          lines.push(`\t\t\t<ReturnFrame>${a.returnFrame}</ReturnFrame>`);
        }
        lines.push(
          '\t\t\t<Durations>',
          ...(a.durations ?? []).map((d) => `\t\t\t\t<Duration>${d}</Duration>`),
          '\t\t\t</Durations>',
        );
      }
      return `\t\t<Anim>\n${lines.join('\n')}\n\t\t</Anim>`;
    })
    .join('\n');
  return `<?xml version="1.0" ?>\n<AnimData>\n\t<ShadowSize>${shadowSize}</ShadowSize>\n\t<Anims>\n${body}\n\t</Anims>\n</AnimData>\n`;
}

export interface UpstreamFile {
  body: Buffer | string;
  etag?: string;
  status?: number;
}

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

/**
 * An in-memory upstream. Files are keyed by cache-relative path and served
 * from every host unless `failHosts` lists it. Supports ETag revalidation
 * (304 on a matching If-None-Match), delays and injected failures.
 */
export class FakeUpstream {
  readonly files = new Map<string, UpstreamFile>();
  readonly calls: FetchCall[] = [];
  /** Hosts that throw (network failure) instead of answering. */
  readonly failHosts = new Set<string>();
  /** Per-path artificial latency in ms. */
  delayMs = 0;
  /** Requests in flight right now, and the most seen at once. */
  inFlight = 0;
  maxInFlight = 0;
  /** When set, a request blocks until released (resolve with releaseAll). */
  hold = false;
  private held: Array<() => void> = [];

  set(relPath: string, body: Buffer | string, etag?: string): void {
    this.files.set(relPath, { body, etag });
  }

  releaseAll(): void {
    const held = this.held;
    this.held = [];
    for (const release of held) release();
  }

  callsFor(relPath: string): FetchCall[] {
    return this.calls.filter((c) => c.url.endsWith(`/${relPath}`));
  }

  readonly fetch: PmdFetch = async (url, init) => {
    this.calls.push({ url, headers: { ...init.headers } });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve));
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      const host = [PRIMARY, FALLBACK].find((h) => url.startsWith(`${h}/`));
      if (!host) throw new Error(`unexpected host: ${url}`);
      if (this.failHosts.has(host)) throw new TypeError('fetch failed');
      const relPath = url.slice(host.length + 1);
      const file = this.files.get(relPath);
      if (!file) return new Response('Not Found', { status: 404 });
      if (file.status !== undefined && file.status !== 200) {
        return new Response('error', { status: file.status });
      }
      const ifNoneMatch = init.headers['if-none-match'];
      if (file.etag && ifNoneMatch === file.etag) return new Response(null, { status: 304 });
      const headers = new Headers();
      if (file.etag) headers.set('etag', file.etag);
      const body = typeof file.body === 'string' ? Buffer.from(file.body) : file.body;
      return new Response(new Uint8Array(body), { status: 200, headers });
    } finally {
      this.inFlight--;
    }
  };
}

/** Invented credit rows; the ids map to invented names in CREDIT_NAMES. */
export const SPRITE_CREDITS = [
  '2020-01-01 00:00:00.000001\tCHUNSOFT\tCUR\tUnspecified\tWalk,Idle,Sleep',
  '2021-06-01 12:00:00.000001\t<@!1001>\tCUR\tCC_BY-NC_4\tCharge,Hop',
  '2019-01-01 00:00:00.000001\t<@!1002>\tOLD\tPMDCollab_1\tWalk',
].join('\n');

export const PORTRAIT_CREDITS =
  '2020-01-01 00:00:00.000001\t<@!1003>\tCUR\tCC_BY-NC_4\tNormal,Happy,Worried,Angry';

export const CREDIT_NAMES = [
  'Name\tDiscord\tContact',
  'CHUNSOFT\tCHUNSOFT\thttps://example.test/chunsoft',
  'Alice Example\t<@!1001>\thttps://example.test/alice',
  'Bob Example\t<@!1002>\t',
  '\t<@!1003>\t',
].join('\n');

/**
 * Register a complete synthetic species: Walk 32x40 (4 frames), Idle 40x56
 * (2 frames), Sleep 32x24 one-row, Charge, Hop, Shoot as CopyOf Charge, and
 * portraits Normal, Happy and Worried.
 */
export function addSyntheticSpecies(upstream: FakeUpstream, dex: number, shiny = false): void {
  const base = `sprite/${String(dex).padStart(4, '0')}${shiny ? '/0000/0001' : ''}`;
  const portrait = `portrait/${String(dex).padStart(4, '0')}${shiny ? '/0000/0001' : ''}`;
  upstream.set(
    `${base}/AnimData.xml`,
    animDataXml([
      { name: 'Walk', index: 0, w: 32, h: 40, durations: [8, 10, 8, 10] },
      { name: 'Idle', index: 7, w: 40, h: 56, durations: [40, 2] },
      { name: 'Sleep', index: 5, w: 32, h: 24, durations: [30, 35] },
      { name: 'Charge', index: 11, w: 40, h: 40, durations: [2, 2, 2] },
      { name: 'Hop', index: 13, w: 32, h: 48, durations: [2, 4] },
      { name: 'Shoot', index: 3, copyOf: 'Charge' },
      { name: 'Attack', index: 1, w: 80, h: 80, durations: [2, 4, 1], hitFrame: 1 },
    ]),
    'W/"xml-1"',
  );
  upstream.set(`${base}/Walk-Anim.png`, solidPng(32 * 4, 40 * 8), '"walk-1"');
  upstream.set(`${base}/Idle-Anim.png`, solidPng(40 * 2, 56 * 8));
  upstream.set(`${base}/Sleep-Anim.png`, solidPng(32 * 2, 24));
  upstream.set(`${base}/Charge-Anim.png`, solidPng(40 * 3, 40 * 8));
  upstream.set(`${base}/Hop-Anim.png`, solidPng(32 * 2, 48 * 8));
  // Attack's sheet is the wrong width (2 frames for 3 durations): it must be skipped.
  upstream.set(`${base}/Attack-Anim.png`, solidPng(80 * 2, 80 * 8));
  upstream.set(`${base}/credits.txt`, SPRITE_CREDITS);
  upstream.set(`${portrait}/Normal.png`, solidPng(40, 40));
  upstream.set(`${portrait}/Happy.png`, solidPng(40, 40));
  upstream.set(`${portrait}/Worried.png`, solidPng(40, 40));
  upstream.set(`${portrait}/credits.txt`, PORTRAIT_CREDITS);
  upstream.set('credit_names.txt', CREDIT_NAMES);
}
