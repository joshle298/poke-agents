import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PMD_REVALIDATE_MS } from '../src/pokemon/constants.js';
import type { PmdFetch, PmdRelPath } from '../src/pokemon/pmdCache.js';
import {
  animDataPath,
  CREDIT_NAMES_PATH,
  parseDex4,
  PmdCache,
  portraitCreditsPath,
  portraitPath,
  sheetPath,
  spriteCreditsPath,
} from '../src/pokemon/pmdCache.js';
import { FakeUpstream, FALLBACK, PRIMARY, solidPng } from './pokemonTestUtils.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WALK = 'sprite/0025/Walk-Anim.png' as PmdRelPath;

let root: string;
let upstream: FakeUpstream;
let now: number;

function makeCache(overrides: Partial<ConstructorParameters<typeof PmdCache>[0]> = {}) {
  return new PmdCache({
    root,
    fetch: upstream.fetch,
    hosts: [PRIMARY, FALLBACK],
    now: () => now,
    ...overrides,
  });
}

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmd-cache-test-'));
  upstream = new FakeUpstream();
  now = Date.now();
});

afterEach(() => {
  upstream.releaseAll();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('PMD cache paths', () => {
  it('builds base and shiny paths from a validated dex', () => {
    expect(animDataPath(25, false)).toBe('sprite/0025/AnimData.xml');
    expect(animDataPath(25, true)).toBe('sprite/0025/0000/0001/AnimData.xml');
    expect(spriteCreditsPath(150, false)).toBe('sprite/0150/credits.txt');
    expect(portraitPath(4, true, 'Normal')).toBe('portrait/0004/0000/0001/Normal.png');
    expect(portraitCreditsPath(1025, false)).toBe('portrait/1025/credits.txt');
    expect(CREDIT_NAMES_PATH).toBe('credit_names.txt');
  });

  it('refuses invalid dex numbers', () => {
    for (const dex of [0, -1, 1026, 2.5, Number.NaN]) {
      expect(animDataPath(dex, false)).toBeNull();
    }
    expect(parseDex4('0025')).toBe(25);
    for (const text of ['25', '0000', '1026', '00025', '..%2F', '../0025']) {
      expect(parseDex4(text)).toBeNull();
    }
  });

  it('builds sheet paths only for anims the species declares with a sheet', () => {
    const declared = new Set(['Walk', 'Idle']);
    expect(sheetPath(25, false, 'Walk', declared)).toBe('sprite/0025/Walk-Anim.png');
    expect(sheetPath(25, false, 'Charge', declared)).toBeNull();
    for (const anim of ['../Walk', 'walk', 'Walk/../../config', 'W', `W${'a'.repeat(30)}`]) {
      expect(sheetPath(25, false, anim, new Set([anim]))).toBeNull();
    }
  });

  it('builds portrait paths only for allowlisted emotions', () => {
    for (const emotion of ['Angry', '../Normal', 'Normal.png', 'Teary-Eyed', '']) {
      expect(portraitPath(25, false, emotion)).toBeNull();
    }
  });

  it('never resolves outside its root', () => {
    const cache = makeCache();
    expect(cache.pathFor(WALK)).toBe(path.join(root, 'sprite', '0025', 'Walk-Anim.png'));
    expect(() => cache.pathFor('../outside.png' as PmdRelPath)).toThrow(/escapes/);
  });
});

describe('PmdCache.ensureFile', () => {
  it('downloads once, then serves from disk while fresh', async () => {
    const png = solidPng(4, 4);
    upstream.set(WALK, png, '"v1"');
    const cache = makeCache();

    const abs = await cache.ensureFile(WALK);
    expect(abs).toBe(path.join(root, 'sprite', '0025', 'Walk-Anim.png'));
    expect(fs.readFileSync(abs!)).toEqual(png);
    expect(upstream.calls[0].url).toBe(`${PRIMARY}/${WALK}`);
    expect(upstream.calls[0].headers['user-agent']).toMatch(/^poke-agents\//);
    expect(upstream.calls[0].headers['if-none-match']).toBeUndefined();

    now += PMD_REVALIDATE_MS - 1000;
    expect(await cache.ensureFile(WALK)).toBe(abs);
    expect(upstream.calls).toHaveLength(1);
    // Atomic writes leave no temp files behind.
    expect(listFiles(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('shares one download between concurrent requests for a path', async () => {
    upstream.set(WALK, solidPng(4, 4));
    upstream.hold = true;
    const cache = makeCache();
    const requests = [cache.ensureFile(WALK), cache.ensureFile(WALK), cache.ensureFile(WALK)];
    await new Promise((resolve) => setTimeout(resolve, 10));
    upstream.releaseAll();
    const results = await Promise.all(requests);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).not.toBeNull();
    expect(upstream.calls).toHaveLength(1);
  });

  it('keeps at most four downloads in flight', async () => {
    const paths = Array.from(
      { length: 10 },
      (_, i) => `portrait/${String(i + 1).padStart(4, '0')}/Normal.png`,
    );
    for (const relPath of paths) upstream.set(relPath, solidPng(2, 2));
    upstream.hold = true;
    const cache = makeCache();
    const all = Promise.all(paths.map((relPath) => cache.ensureFile(relPath as PmdRelPath)));
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(upstream.inFlight).toBeLessThanOrEqual(4);
      upstream.releaseAll();
    }
    upstream.hold = false;
    upstream.releaseAll();
    const results = await all;
    expect(results.every((r) => r !== null)).toBe(true);
    expect(upstream.maxInFlight).toBe(4);
  });

  it('revalidates a week-old file with its ETag and keeps it on 304', async () => {
    const png = solidPng(4, 4);
    upstream.set(WALK, png, '"v1"');
    const cache = makeCache();
    const abs = (await cache.ensureFile(WALK))!;

    now += PMD_REVALIDATE_MS + DAY_MS;
    expect(await cache.ensureFile(WALK)).toBe(abs);
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls[1].headers['if-none-match']).toBe('"v1"');
    expect(fs.readFileSync(abs)).toEqual(png);
    expect(Math.abs(fs.statSync(abs).mtimeMs - now)).toBeLessThan(1000);

    // The 304 refreshed it: no request until the next week has passed.
    now += DAY_MS;
    await cache.ensureFile(WALK);
    expect(upstream.calls).toHaveLength(2);
  });

  it('replaces a file that changed upstream', async () => {
    upstream.set(WALK, solidPng(4, 4), '"v1"');
    const cache = makeCache();
    const abs = (await cache.ensureFile(WALK))!;
    const updated = solidPng(8, 8);
    upstream.set(WALK, updated, '"v2"');

    now += PMD_REVALIDATE_MS + DAY_MS;
    await cache.ensureFile(WALK);
    expect(fs.readFileSync(abs)).toEqual(updated);
    expect(JSON.parse(fs.readFileSync(`${abs}.etag`, 'utf8'))).toEqual({
      host: PRIMARY,
      etag: '"v2"',
    });
  });

  it('serves the stale copy when every host fails', async () => {
    const png = solidPng(4, 4);
    upstream.set(WALK, png, '"v1"');
    const cache = makeCache();
    const abs = (await cache.ensureFile(WALK))!;

    upstream.failHosts.add(PRIMARY);
    upstream.failHosts.add(FALLBACK);
    now += PMD_REVALIDATE_MS + DAY_MS;
    expect(await cache.ensureFile(WALK)).toBe(abs);
    expect(fs.readFileSync(abs)).toEqual(png);
    expect(upstream.calls).toHaveLength(3);

    // It backs off instead of waiting on the network for every request.
    expect(await cache.ensureFile(WALK)).toBe(abs);
    expect(upstream.calls).toHaveLength(3);

    upstream.failHosts.clear();
    now += 61_000;
    expect(await cache.ensureFile(WALK)).toBe(abs);
    expect(upstream.calls).toHaveLength(4);
    expect(upstream.calls[3].headers['if-none-match']).toBe('"v1"');
  });

  it('backs off after a failed first download', async () => {
    upstream.set(WALK, solidPng(4, 4));
    upstream.failHosts.add(PRIMARY);
    upstream.failHosts.add(FALLBACK);
    const cache = makeCache();
    expect(await cache.ensureFile(WALK)).toBeNull();
    expect(await cache.ensureFile(WALK)).toBeNull();
    expect(upstream.calls).toHaveLength(2);

    upstream.failHosts.clear();
    now += 61_000;
    expect(await cache.ensureFile(WALK)).not.toBeNull();
  });

  it('drops a cached file that upstream removed', async () => {
    upstream.set(WALK, solidPng(4, 4), '"v1"');
    const cache = makeCache();
    const abs = (await cache.ensureFile(WALK))!;

    upstream.files.delete(WALK);
    now += PMD_REVALIDATE_MS + DAY_MS;
    expect(await cache.ensureFile(WALK)).toBeNull();
    expect(fs.existsSync(abs)).toBe(false);
    expect(fs.existsSync(`${abs}.etag`)).toBe(false);
  });

  it('falls back to the second host and revalidates against the host that tagged it', async () => {
    upstream.set(WALK, solidPng(4, 4), '"cdn"');
    upstream.failHosts.add(PRIMARY);
    const cache = makeCache();
    const abs = (await cache.ensureFile(WALK))!;
    expect(upstream.calls.map((c) => c.url)).toEqual([`${PRIMARY}/${WALK}`, `${FALLBACK}/${WALK}`]);

    upstream.failHosts.delete(PRIMARY);
    upstream.calls.length = 0;
    now += PMD_REVALIDATE_MS + DAY_MS;
    expect(await cache.ensureFile(WALK)).toBe(abs);
    // The primary never issued that ETag, so it is asked without one.
    expect(upstream.calls[0].headers['if-none-match']).toBeUndefined();
  });

  it('treats a 404 as an answer and remembers it for a while', async () => {
    const cache = makeCache({ missingTtlMs: 60_000 });
    expect(await cache.ensureFile(WALK)).toBeNull();
    // Not retried on the fallback: the file simply does not exist.
    expect(upstream.calls).toHaveLength(1);
    expect(await cache.ensureFile(WALK)).toBeNull();
    expect(upstream.calls).toHaveLength(1);

    now += 61_000;
    upstream.set(WALK, solidPng(4, 4));
    expect(await cache.ensureFile(WALK)).not.toBeNull();
  });

  it('rejects bodies over the size cap', async () => {
    upstream.set(WALK, solidPng(64, 64));
    const cache = makeCache({ maxBytes: 64 });
    expect(await cache.ensureFile(WALK)).toBeNull();
    expect(fs.existsSync(path.join(root, 'sprite'))).toBe(false);
  });

  it('rejects a declared Content-Length over the cap without reading the body', async () => {
    // An endless body: reading it to the cap would pull dozens of chunks.
    let pulls = 0;
    let cancelled = false;
    const fetchFn: PmdFetch = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(64 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } },
      );
    const cache = makeCache({ fetch: fetchFn, hosts: [PRIMARY] });
    expect(await cache.ensureFile(WALK)).toBeNull();
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(3);
  });

  it('rejects a .png that is not a PNG and tries the next host', async () => {
    const png = solidPng(4, 4);
    const fetchFn: PmdFetch = async (url) =>
      url.startsWith(PRIMARY)
        ? new Response('<html>captive portal</html>', { status: 200 })
        : new Response(new Uint8Array(png), { status: 200 });
    const cache = makeCache({ fetch: fetchFn });
    const abs = await cache.ensureFile(WALK);
    expect(fs.readFileSync(abs!)).toEqual(png);

    const htmlOnly: PmdFetch = async () => new Response('<html></html>', { status: 200 });
    const other = 'sprite/0025/Idle-Anim.png' as PmdRelPath;
    expect(await makeCache({ fetch: htmlOnly }).ensureFile(other)).toBeNull();
  });

  it('accepts text files and refuses binary ones', async () => {
    const xml = animDataPath(25, false)!;
    upstream.set(xml, '<AnimData></AnimData>');
    const cache = makeCache();
    expect(await cache.readText(xml)).toBe('<AnimData></AnimData>');

    const credits = spriteCreditsPath(25, false)!;
    upstream.set(credits, Buffer.from([0x41, 0x00, 0x42]));
    expect(await cache.ensureFile(credits)).toBeNull();
  });

  it('gives up on a host that does not answer within the timeout', async () => {
    const png = solidPng(4, 4);
    const fetchFn: PmdFetch = (url, init) =>
      url.startsWith(PRIMARY)
        ? new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
          })
        : Promise.resolve(new Response(new Uint8Array(png), { status: 200 }));
    const cache = makeCache({ fetch: fetchFn, timeoutMs: 30 });
    const abs = await cache.ensureFile(WALK);
    expect(fs.readFileSync(abs!)).toEqual(png);
  });

  it('moves on from server errors and rate limits', async () => {
    const png = solidPng(4, 4);
    const statuses: number[] = [];
    const fetchFn: PmdFetch = async (url) => {
      if (url.startsWith(PRIMARY)) {
        statuses.push(429);
        return new Response('slow down', { status: 429 });
      }
      return new Response(new Uint8Array(png), { status: 200 });
    };
    const abs = await makeCache({ fetch: fetchFn }).ensureFile(WALK);
    expect(statuses).toEqual([429]);
    expect(fs.readFileSync(abs!)).toEqual(png);
  });
});
