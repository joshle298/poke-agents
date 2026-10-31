import Fastify, { type FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MusicFolderLibrary } from '../src/music/folderLibrary.js';
import { parseRangeHeader } from '../src/music/range.js';
import { registerMusicRoutes } from '../src/music/routes.js';
import { privilegedHostnames } from '../src/wsAuth.js';

const HOST = '127.0.0.1:41510';
const TOKEN = 'test-token-123';
/** 1000 synthetic bytes standing in for an audio file (never real audio). */
const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

describe('parseRangeHeader', () => {
  it('reads one byte range, clamped to the file', () => {
    expect(parseRangeHeader('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRangeHeader('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRangeHeader('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRangeHeader('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRangeHeader(' bytes=10-10 ', 1000)).toEqual({ start: 10, end: 10 });
  });

  it('answers unsatisfiable past the end, and ignores what it does not understand', () => {
    expect(parseRangeHeader('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRangeHeader(undefined, 1000)).toBeNull();
    expect(parseRangeHeader('bytes=5-1', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=0-1,5-9', 1000)).toBeNull();
    expect(parseRangeHeader('items=0-1', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=-', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=a-b', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=99999999999999999999-', 1000)).toBeNull();
  });
});

describe('GET /api/music/track/:id', () => {
  let base: string;
  let root: string;
  let app: FastifyInstance;
  let ids: Record<string, string>;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-route-'));
    root = path.join(base, 'music');
    fs.mkdirSync(path.join(root, 'Album'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Album', '01 Song.mp3'), BODY);
    fs.writeFileSync(path.join(root, 'Album', '02 Tune.m4a'), BODY);
    fs.writeFileSync(path.join(root, 'Album', '03 Voice.opus'), BODY);
    fs.writeFileSync(path.join(root, 'Album', '04 Empty.wav'), '');
    // A private file beside the music folder that no request may reach.
    fs.writeFileSync(path.join(base, 'secret.mp3'), 'secret');

    const library = new MusicFolderLibrary(root);
    const scan = await library.scan();
    ids = Object.fromEntries(scan.albums[0].tracks.map((t) => [t.title, t.id]));
    app = Fastify();
    registerMusicRoutes(app, {
      token: TOKEN,
      allowedHostnames: privilegedHostnames('127.0.0.1', ['office.example.ts.net']),
      library,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  function get(
    id: string,
    {
      host = HOST,
      token = TOKEN,
      range,
    }: { host?: string; token?: string | null; range?: string } = {},
  ) {
    const query = token === null ? '' : `?token=${encodeURIComponent(token)}`;
    return app.inject({
      method: 'GET',
      url: `/api/music/track/${id}${query}`,
      headers: { host, ...(range ? { range } : {}) },
    });
  }

  it('streams the whole file with its type, length and range support advertised', async () => {
    const res = await get(ids['Song']);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['content-length']).toBe('1000');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.rawPayload).toEqual(BODY);
  });

  it('serves each format with its own content type', async () => {
    const tracks = (await new MusicFolderLibrary(root).scan()).albums[0].tracks;
    const types: string[] = [];
    for (const track of tracks) {
      types.push(String((await get(track.id)).headers['content-type']));
    }
    expect(types).toEqual(['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav']);
  });

  it('answers a byte range with 206 and exact bounds', async () => {
    const res = await get(ids['Song'], { range: 'bytes=100-199' });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 100-199/1000');
    expect(res.headers['content-length']).toBe('100');
    expect(res.rawPayload).toEqual(BODY.subarray(100, 200));

    const tail = await get(ids['Song'], { range: 'bytes=-10' });
    expect(tail.statusCode).toBe(206);
    expect(tail.headers['content-range']).toBe('bytes 990-999/1000');
    expect(tail.rawPayload).toEqual(BODY.subarray(990));

    const open = await get(ids['Song'], { range: 'bytes=995-' });
    expect(open.headers['content-range']).toBe('bytes 995-999/1000');
    expect(open.rawPayload).toEqual(BODY.subarray(995));
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await app.inject({
      method: 'HEAD',
      url: `/api/music/track/${ids['Song']}?token=${TOKEN}`,
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe('1000');
    expect(res.rawPayload.length).toBe(0);
  });

  it('answers 416 for a range past the end', async () => {
    const res = await get(ids['Song'], { range: 'bytes=1000-1010' });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */1000');
    expect(res.rawPayload.length).toBe(0);
  });

  it('serves an empty file as an empty 200', async () => {
    const res = await get(ids['Empty']);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe('0');
  });

  it('needs the server token', async () => {
    expect((await get(ids['Song'], { token: null })).statusCode).toBe(403);
    expect((await get(ids['Song'], { token: 'wrong' })).statusCode).toBe(403);
  });

  it('accepts an --allowed-host name and refuses any other Host, token or not', async () => {
    expect((await get(ids['Song'], { host: 'office.example.ts.net' })).statusCode).toBe(200);
    expect((await get(ids['Song'], { host: 'rebound.example:41510' })).statusCode).toBe(403);
    expect((await get(ids['Song'], { host: 'evil@127.0.0.1' })).statusCode).toBe(403);
  });

  it('serves nothing but scanned ids', async () => {
    const urls = [
      '0'.repeat(24),
      'ABCDEF0123456789abcdef01',
      '..%2Fsecret.mp3',
      '..%2F..%2Fsecret.mp3',
      `${ids['Song']}%2F..%2F..%2Fsecret.mp3`,
      `${ids['Song']}0`,
      'Album%2F01%20Song.mp3',
    ];
    for (const id of urls) {
      const res = await get(id);
      expect(res.statusCode, id).toBe(404);
      expect(res.rawPayload.toString()).not.toContain('secret');
    }
  });
});
