import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CRY_REVALIDATE_MS } from '../src/audio/constants.js';
import { CryCache, cryFormat } from '../src/audio/cryCache.js';
import {
  CRY_BASE,
  FakeCryUpstream,
  syntheticMp3,
  syntheticMp3Frame,
  syntheticOgg,
  syntheticWav,
} from './audioTestUtils.js';

const MINUTE_MS = 60 * 1000;

let root: string;
let upstream: FakeCryUpstream;
let now: number;

function makeCache(overrides: Partial<ConstructorParameters<typeof CryCache>[0]> = {}) {
  return new CryCache({
    root,
    fetch: upstream.fetch,
    base: CRY_BASE,
    now: () => now,
    ...overrides,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cry-cache-test-'));
  upstream = new FakeCryUpstream();
  now = Date.now();
});

afterEach(() => {
  upstream.releaseAll();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('cryFormat', () => {
  it('keeps Ogg and MP3 (some cries are MP3 under a .ogg name), nothing else', () => {
    expect(cryFormat(syntheticOgg())).toBe('ogg');
    expect(cryFormat(syntheticMp3())).toBe('mp3');
    expect(cryFormat(syntheticMp3Frame())).toBe('mp3');
    expect(cryFormat(syntheticWav())).toBeNull();
    expect(cryFormat(Buffer.from('<!DOCTYPE html>'))).toBeNull();
    expect(cryFormat(Buffer.from('Ogg'))).toBeNull();
    // Frame-sync look-alikes: a UTF-16LE byte-order mark, 0xFF filler, Layer I.
    expect(cryFormat(Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]))).toBeNull();
    expect(cryFormat(Buffer.alloc(16, 0xff))).toBeNull();
    expect(cryFormat(Buffer.from([0xff, 0xfb, 0xf4, 0x64]))).toBeNull();
    expect(cryFormat(Buffer.from([0xff, 0xfb, 0x9c, 0x64]))).toBeNull();
    expect(cryFormat(Buffer.from([0xff, 0xff, 0x94, 0x64]))).toBeNull();
    expect(cryFormat(Buffer.from([0xff, 0xf3, 0x84, 0x64]))).toBe('mp3');
    expect(cryFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe('CryCache', () => {
  it('downloads the latest cry into <dex4>.ogg and serves it from the cache after', async () => {
    upstream.set('latest', 25, syntheticOgg('pika'), '"e1"');
    const cache = makeCache();
    const abs = await cache.ensureCry(25);
    expect(abs).toBe(path.join(root, '0025.ogg'));
    expect(fs.readFileSync(abs!)).toEqual(syntheticOgg('pika'));
    expect(JSON.parse(fs.readFileSync(`${abs}.etag`, 'utf8'))).toEqual({
      variant: 'latest',
      etag: '"e1"',
    });
    expect(upstream.calls[0].url).toBe(`${CRY_BASE}/latest/25.ogg`);

    expect(await cache.ensureCry(25)).toBe(abs);
    expect(upstream.calls).toHaveLength(1);
  });

  it('keeps a cry upstream serves as MP3 under its .ogg name', async () => {
    upstream.set('latest', 25, syntheticMp3Frame());
    const abs = await makeCache().ensureCry(25);
    expect(fs.readFileSync(abs!)).toEqual(syntheticMp3Frame());
    expect(upstream.callsFor('legacy', 25)).toBe(0);
  });

  it('falls back to the legacy cry when latest has none', async () => {
    upstream.set('legacy', 4, syntheticOgg('old'));
    const abs = await makeCache().ensureCry(4);
    expect(fs.readFileSync(abs!)).toEqual(syntheticOgg('old'));
    expect(upstream.callsFor('latest', 4)).toBe(1);
    expect(upstream.callsFor('legacy', 4)).toBe(1);
  });

  it('remembers a cry no variant has, for the missing TTL', async () => {
    const cache = makeCache({ missingTtlMs: 10 * MINUTE_MS });
    expect(await cache.ensureCry(1000)).toBeNull();
    expect(upstream.calls).toHaveLength(2);
    now += MINUTE_MS;
    expect(await cache.ensureCry(1000)).toBeNull();
    expect(upstream.calls).toHaveLength(2);
    now += 10 * MINUTE_MS;
    expect(await cache.ensureCry(1000)).toBeNull();
    expect(upstream.calls).toHaveLength(4);
  });

  it('refuses a body that is not Ogg, writes nothing, and backs off (doubling)', async () => {
    upstream.set('latest', 25, Buffer.from('<html>rate limited</html>'));
    const cache = makeCache({ failureBackoffMs: MINUTE_MS, failureBackoffMaxMs: 3 * MINUTE_MS });
    expect(await cache.ensureCry(25)).toBeNull();
    expect(fs.readdirSync(root)).toEqual([]);
    // A bad latest body is a failure, not a reason to swap in the legacy cry.
    expect(upstream.callsFor('legacy', 25)).toBe(0);

    now += MINUTE_MS / 2;
    expect(await cache.ensureCry(25)).toBeNull();
    expect(upstream.calls).toHaveLength(1);
    now += MINUTE_MS;
    expect(await cache.ensureCry(25)).toBeNull();
    expect(upstream.calls).toHaveLength(2);
    // Second failure: 2 minutes before the next try.
    now += MINUTE_MS + 1;
    expect(await cache.ensureCry(25)).toBeNull();
    expect(upstream.calls).toHaveLength(2);
    now += MINUTE_MS;
    upstream.set('latest', 25, syntheticOgg());
    expect(await cache.ensureCry(25)).not.toBeNull();
    expect(upstream.calls).toHaveLength(3);
  });

  it('enforces the size cap', async () => {
    upstream.set('latest', 25, Buffer.concat([syntheticOgg(), Buffer.alloc(2048)]));
    expect(await makeCache({ maxBytes: 1024 }).ensureCry(25)).toBeNull();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('revalidates a stale cry with its ETag and keeps it on 304', async () => {
    upstream.set('latest', 25, syntheticOgg('v1'), '"e1"');
    const cache = makeCache();
    const abs = (await cache.ensureCry(25))!;
    now += CRY_REVALIDATE_MS + 1;
    expect(await cache.ensureCry(25)).toBe(abs);
    expect(upstream.calls[1].headers['if-none-match']).toBe('"e1"');
    expect(fs.readFileSync(abs)).toEqual(syntheticOgg('v1'));
    // Fresh again: no request inside the next window.
    expect(await cache.ensureCry(25)).toBe(abs);
    expect(upstream.calls).toHaveLength(2);
  });

  it('replaces a changed cry and drops one removed upstream', async () => {
    upstream.set('latest', 25, syntheticOgg('v1'), '"e1"');
    const cache = makeCache({ missingTtlMs: MINUTE_MS });
    const abs = (await cache.ensureCry(25))!;
    upstream.set('latest', 25, syntheticOgg('v2'), '"e2"');
    now += CRY_REVALIDATE_MS + 1;
    expect(await cache.ensureCry(25)).toBe(abs);
    expect(fs.readFileSync(abs)).toEqual(syntheticOgg('v2'));

    upstream.files.clear();
    now += CRY_REVALIDATE_MS + 1;
    expect(await cache.ensureCry(25)).toBeNull();
    expect(fs.existsSync(abs)).toBe(false);
    expect(fs.existsSync(`${abs}.etag`)).toBe(false);
  });

  it('serves the stale copy while offline, without trying another variant', async () => {
    upstream.set('latest', 25, syntheticOgg('v1'));
    upstream.set('legacy', 25, syntheticOgg('legacy'));
    const cache = makeCache();
    const abs = (await cache.ensureCry(25))!;
    upstream.offline = true;
    now += CRY_REVALIDATE_MS + 1;
    expect(await cache.ensureCry(25)).toBe(abs);
    expect(fs.readFileSync(abs)).toEqual(syntheticOgg('v1'));
    expect(upstream.callsFor('legacy', 25)).toBe(0);
  });

  it('fetches each cry once for concurrent requests (single-flight)', async () => {
    upstream.set('latest', 150, syntheticOgg());
    upstream.hold = true;
    const cache = makeCache();
    const pending = [cache.ensureCry(150), cache.ensureCry(150), cache.ensureCry(150)];
    await new Promise((resolve) => setTimeout(resolve, 10));
    upstream.releaseAll();
    const results = await Promise.all(pending);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(path.join(root, '0150.ogg'));
    expect(upstream.calls).toHaveLength(1);
  });

  it('downloads at most two cries at once; the rest wait their turn', async () => {
    const dexes = [1, 4, 7, 25];
    for (const dex of dexes) upstream.set('latest', dex, syntheticOgg(String(dex)));
    upstream.hold = true;
    const cache = makeCache();
    const pending = dexes.map((dex) => cache.ensureCry(dex));
    await vi.waitFor(() => expect(upstream.calls).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Which two start first depends on which cache check (a stat) returns
    // first; only the limit is the contract.
    const urls = dexes.map((dex) => `${CRY_BASE}/latest/${dex}.ogg`);
    const first = upstream.calls.map((c) => c.url);
    expect(first).toHaveLength(2);
    expect(new Set(first).size).toBe(2);
    for (const url of first) expect(urls).toContain(url);
    upstream.releaseAll();
    await vi.waitFor(() => expect(upstream.calls).toHaveLength(4));
    expect(upstream.calls.map((c) => c.url).sort()).toEqual([...urls].sort());
    upstream.hold = false;
    upstream.releaseAll();
    const results = await Promise.all(pending);
    expect(results).toEqual(
      dexes.map((dex) => path.join(root, `${String(dex).padStart(4, '0')}.ogg`)),
    );
  });

  it('never builds a path or a request from an invalid dex', async () => {
    const cache = makeCache();
    for (const dex of [0, -1, 1026, 2.5, Number.NaN]) {
      expect(cache.pathFor(dex)).toBeNull();
      expect(await cache.ensureCry(dex)).toBeNull();
    }
    expect(upstream.calls).toHaveLength(0);
  });
});
