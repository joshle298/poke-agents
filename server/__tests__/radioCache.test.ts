import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setSoundsEnabled } from '../src/audio/sounds.js';
import { RADIO_CACHE_SUBDIR } from '../src/music/constants.js';
import {
  defaultRadioCacheRoot,
  isRadioTrackId,
  RadioCache,
  type RadioCacheOptions,
} from '../src/music/radioCache.js';
import type { RadioTrack } from '../src/music/radioCatalog.js';
import { radioOffReason, setRadioEnabled } from '../src/music/radioSwitch.js';
import {
  fakeRadioFetch,
  forbiddenFetch,
  radioTrack,
  syntheticTrackBytes,
} from './radioTestUtils.js';

const TOWN = syntheticTrackBytes(1);
const ROUTE = syntheticTrackBytes(2, 3000);

let root: string;
let logs: string[];
let tracks: RadioTrack[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-cache-'));
  logs = [];
  tracks = [radioTrack('town', TOWN), radioTrack('route', ROUTE)];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function cache(options: RadioCacheOptions = {}): RadioCache {
  return new RadioCache({
    root,
    tracks,
    offReason: () => null,
    log: (message) => logs.push(message),
    ...options,
  });
}

const files = () => ({ [tracks[0].url]: TOWN, [tracks[1].url]: ROUTE });
/** What the cache directory holds (no stray temporary files). */
const listing = () => fs.readdirSync(root).sort();

describe('RadioCache', () => {
  it('downloads a track on first use, keeps it under its id, and serves it from disk after', async () => {
    const fetch = fakeRadioFetch(files());
    const radio = cache({ fetch });

    const abs = await radio.ensureTrack('radio-town');
    expect(abs).toBe(path.join(root, 'radio-town.ogg'));
    expect(fs.readFileSync(abs as string)).toEqual(TOWN);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(tracks[0].url);
    expect(init.headers['user-agent']).toMatch(/^poke-agents\//);
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(await radio.ensureTrack('radio-town')).toBe(abs);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(listing()).toEqual(['radio-town.ogg']);
  });

  it('hashes a copy cached by an earlier run before trusting it', async () => {
    fs.writeFileSync(path.join(root, 'radio-town.ogg'), TOWN);
    const radio = cache({ fetch: forbiddenFetch() });
    expect(await radio.ensureTrack('radio-town')).toBe(path.join(root, 'radio-town.ogg'));
  });

  it('rejects a download that does not match its checksum and keeps nothing', async () => {
    const tampered = Buffer.from(TOWN);
    tampered[100] ^= 0xff;
    const fetch = fakeRadioFetch({ [tracks[0].url]: tampered });
    const radio = cache({ fetch });

    expect(await radio.ensureTrack('radio-town')).toBeNull();
    expect(listing()).toEqual([]);
    expect(logs.join('\n')).toMatch(/radio-town: the download doesn't match its checksum/);
    expect(await radio.openTrack('radio-town')).toBeNull();
  });

  it('rejects a download larger or shorter than the manifest says', async () => {
    const longer = Buffer.concat([TOWN, Buffer.from('extra')]);
    const shorter = TOWN.subarray(0, TOWN.length - 1);
    const radio = cache({ fetch: fakeRadioFetch({ [tracks[0].url]: longer }) });
    expect(await radio.ensureTrack('radio-town')).toBeNull();
    const radio2 = cache({ fetch: fakeRadioFetch({ [tracks[0].url]: shorter }) });
    expect(await radio2.ensureTrack('radio-town')).toBeNull();
    expect(listing()).toEqual([]);
  });

  it('keeps nothing from an error page or a failed connection', async () => {
    const page = cache({
      fetch: fakeRadioFetch({}, () => new Response('<html>moved</html>', { status: 503 })),
    });
    expect(await page.ensureTrack('radio-town')).toBeNull();
    const offline = cache({
      fetch: fakeRadioFetch({}, () => Promise.reject(new TypeError('fetch failed'))),
    });
    expect(await offline.ensureTrack('radio-town')).toBeNull();
    expect(listing()).toEqual([]);
  });

  it('backs off after a failure, doubling, and tries again once it has passed', async () => {
    let now = 1_000_000;
    let online = false;
    const fetch = fakeRadioFetch(files(), () =>
      online ? undefined : Promise.reject(new TypeError('offline')),
    );
    const radio = cache({ fetch, now: () => now, failureBackoffMs: 1000 });

    expect(await radio.ensureTrack('radio-town')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await radio.ensureTrack('radio-town')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 1001;
    expect(await radio.ensureTrack('radio-town')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    now += 1001; // the second failure doubled the wait to 2 s
    expect(await radio.ensureTrack('radio-town')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);

    now += 1000;
    online = true;
    expect(await radio.ensureTrack('radio-town')).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    // Another track was never held back by this one's failures.
    expect(await radio.ensureTrack('radio-route')).not.toBeNull();
  });

  it('downloads a track once for concurrent requests', async () => {
    const fetch = fakeRadioFetch(files());
    const radio = cache({ fetch });
    const [a, b, c] = await Promise.all([
      radio.ensureTrack('radio-town'),
      radio.ensureTrack('radio-town'),
      radio.openTrack('radio-town'),
    ]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    await c?.handle.close();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('downloads a corrupted or replaced cached copy again', async () => {
    const fetch = fakeRadioFetch(files());
    const radio = cache({ fetch });
    const abs = path.join(root, 'radio-town.ogg');

    // Same size, different bytes.
    const corrupted = Buffer.from(TOWN);
    corrupted[10] ^= 0x01;
    fs.writeFileSync(abs, corrupted);
    expect(await radio.ensureTrack('radio-town')).toBe(abs);
    expect(fs.readFileSync(abs)).toEqual(TOWN);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toMatch(/doesn't match its checksum; downloading it again/);

    // Truncated after it was verified: the size and time changed, so it is checked again.
    fs.writeFileSync(abs, TOWN.subarray(0, 100));
    expect(await radio.ensureTrack('radio-town')).toBe(abs);
    expect(fs.readFileSync(abs)).toEqual(TOWN);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('knows only manifest ids, and builds paths from them alone', async () => {
    const fetch = forbiddenFetch();
    const radio = cache({ fetch });
    for (const id of [
      'radio-unknown',
      'radio-town/../../etc/passwd',
      '../radio-town',
      'radio-TOWN',
      'radio-town.ogg',
      'town',
      '',
      `radio-${'a'.repeat(80)}`,
    ]) {
      expect(await radio.ensureTrack(id), id).toBeNull();
      expect(await radio.openTrack(id), id).toBeNull();
      expect(radio.pathFor(id), id).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(isRadioTrackId('radio-town')).toBe(true);
    expect(isRadioTrackId('radio-a-b-c1')).toBe(true);
    expect(isRadioTrackId('radio--town')).toBe(false);
    expect(isRadioTrackId('radio-town-')).toBe(false);
  });

  it('downloads and serves nothing while the radio is off', async () => {
    fs.writeFileSync(path.join(root, 'radio-town.ogg'), TOWN);
    const fetch = forbiddenFetch();
    const radio = cache({ fetch, offReason: () => 'The radio is off (--no-radio).' });
    expect(radio.offReason()).toBe('The radio is off (--no-radio).');
    expect(await radio.ensureTrack('radio-town')).toBeNull();
    expect(await radio.ensureTrack('radio-route')).toBeNull();
    expect(await radio.openTrack('radio-town')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('opens a track with its size and content type', async () => {
    const radio = cache({ fetch: fakeRadioFetch(files()) });
    const opened = await radio.openTrack('radio-route');
    expect(opened).not.toBeNull();
    try {
      expect(opened?.size).toBe(ROUTE.length);
      expect(opened?.mimeType).toBe('audio/ogg');
    } finally {
      await opened?.handle.close();
    }
  });

  it('caches under ~/.pixel-agents/cache/music/radio by default', () => {
    expect(RADIO_CACHE_SUBDIR).toEqual(['cache', 'music', 'radio']);
    expect(defaultRadioCacheRoot()).toBe(
      path.join(os.homedir(), '.pixel-agents', 'cache', 'music', 'radio'),
    );
  });
});

describe('radio switch', () => {
  // vitest.config.ts starts every test file with POKE_AGENTS_RADIO=off.
  beforeEach(() => setRadioEnabled(true));
  afterEach(() => {
    setRadioEnabled(false);
    setSoundsEnabled(true);
  });

  it('is on until --no-radio or --no-sounds turns it off', () => {
    expect(radioOffReason()).toBeNull();
    setRadioEnabled(false);
    expect(radioOffReason()).toMatch(/--no-radio/);
    setRadioEnabled(true);
    setSoundsEnabled(false);
    expect(radioOffReason()).toMatch(/--no-sounds/);
  });

  it('turns the default cache off with it', async () => {
    const fetch = forbiddenFetch();
    const radio = new RadioCache({ root, tracks, fetch });
    setRadioEnabled(false);
    expect(await radio.ensureTrack('radio-town')).toBeNull();
    setRadioEnabled(true);
    setSoundsEnabled(false);
    expect(await radio.ensureTrack('radio-town')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
