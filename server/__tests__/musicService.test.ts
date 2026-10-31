import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appleMusicCommand, spotifyCommand } from '../src/music/appleScripts.js';
import type { OsaExec } from '../src/music/macApps.js';
import {
  type MusicCommandInput,
  MusicService,
  openFolderWithSystem,
} from '../src/music/musicService.js';

const US = '\u001f';
const RS = '\u001e';
const SPOTIFY_ID = '4aawyAB9vmqN3uQ7FjRGTy';

let base: string;
let musicDir: string;
let stateFile: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-service-'));
  musicDir = path.join(base, 'music');
  stateFile = path.join(base, 'music.json');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** Answers each fixed script the way the app would (never runs anything). */
function fakeOsascript(
  answers: { albums?: string; status?: string; fail?: { stderr: string } } = {},
) {
  return vi.fn<OsaExec>(async (_file, args) => {
    const script = args[1];
    if (answers.fail) return Promise.reject(Object.assign(new Error('failed'), answers.fail));
    if (script === appleMusicCommand('listPokemonAlbums').script) {
      return { stdout: `${answers.albums ?? ''}\n`, stderr: '' };
    }
    if (
      script === appleMusicCommand('status').script ||
      script === spotifyCommand('status').script
    ) {
      return {
        stdout: `${answers.status ?? ['running', 'playing', 'true', '50', 'Route 1', 'Pokémon Red', 'GF'].join(US)}\n`,
        stderr: '',
      };
    }
    return { stdout: 'ok\n', stderr: '' };
  });
}

function service(
  options: {
    platform?: NodeJS.Platform;
    exec?: OsaExec;
    fetch?: typeof fetch;
    openFolder?: (dir: string) => Promise<void>;
    installed?: boolean;
  } = {},
) {
  return new MusicService({
    musicDir,
    stateFile,
    platform: options.platform ?? 'darwin',
    home: base,
    exec: options.exec ?? fakeOsascript(),
    pathExists: async () => options.installed ?? true,
    openFolder: options.openFolder ?? (async () => {}),
    fetch:
      options.fetch ?? (vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch),
    settleMs: 0,
    log: () => {},
  });
}

function cmd(input: MusicCommandInput): MusicCommandInput {
  return input;
}

function scriptsRun(exec: ReturnType<typeof fakeOsascript>): string[] {
  return exec.mock.calls.map(([, args]) => args[1]);
}

describe('MusicService.library', () => {
  it('lists folder albums without server paths, and which sources work', async () => {
    fs.mkdirSync(path.join(musicDir, 'Pokémon Ruby'), { recursive: true });
    fs.writeFileSync(path.join(musicDir, 'Pokémon Ruby', '01 Opening.mp3'), 'x');

    const library = await service({ platform: 'linux' }).library();
    expect(library.type).toBe('musicLibrary');
    expect(library.sources).toEqual([
      { id: 'folder', available: true },
      { id: 'apple', available: false, reason: 'Music control needs macOS.' },
      { id: 'spotify', available: false, reason: 'Spotify control needs macOS.' },
    ]);
    expect(library.albums).toEqual([
      {
        id: expect.stringMatching(/^[a-f0-9]{24}$/),
        name: 'Pokémon Ruby',
        tracks: [
          {
            id: expect.stringMatching(/^[a-f0-9]{24}$/),
            title: 'Opening',
            trackNumber: 1,
            mimeType: 'audio/mpeg',
          },
        ],
      },
    ]);
    expect(library.folderPath).toBe(`~${path.sep}music`);
    expect(JSON.stringify(library)).not.toContain(base);
    expect(library.appleLibraryScanned).toBe(false);
    expect(library.stations).toEqual([]);
  });

  it('reports the apps available on a Mac that has them', async () => {
    const library = await service().library();
    expect(library.sources.map((s) => [s.id, s.available])).toEqual([
      ['folder', true],
      ['apple', true],
      ['spotify', true],
    ]);
  });
});

describe('MusicService.command: the music folder', () => {
  it('creates and opens the folder', async () => {
    const openFolder = vi.fn(async () => {});
    const outcome = await service({ openFolder }).command(
      cmd({ action: 'openFolder', source: 'folder' }),
    );
    expect(outcome.result).toEqual({
      type: 'musicActionResult',
      action: 'openFolder',
      source: 'folder',
      ok: true,
    });
    expect(openFolder).toHaveBeenCalledWith(musicDir);
    expect(fs.statSync(musicDir).isDirectory()).toBe(true);
  });

  it('opens the folder with /usr/bin/open on macOS and xdg-open on Linux, never a shell', async () => {
    const run = vi.fn(async () => {});
    await openFolderWithSystem('/Users/ash/.pixel-agents/music', 'darwin', run);
    await openFolderWithSystem('/home/ash/.pixel-agents/music', 'linux', run);
    expect(run.mock.calls).toEqual([
      ['/usr/bin/open', ['/Users/ash/.pixel-agents/music']],
      ['xdg-open', ['/home/ash/.pixel-agents/music']],
    ]);
    await expect(openFolderWithSystem('C:\\music', 'win32', run)).rejects.toThrow(/file manager/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('leaves folder playback to the page', async () => {
    const outcome = await service().command(cmd({ action: 'play', source: 'folder' }));
    expect(outcome.result.ok).toBe(false);
  });
});

describe('MusicService.command: the Music app', () => {
  it('scans the library for Pokémon albums and plays one by id', async () => {
    const exec = fakeOsascript({
      albums: [
        ['Pokémon Ruby', 'Pokémon Ruby', 'Pokémon X & Y'].join(US),
        ['Game Freak', 'Game Freak', ''].join(US),
        ['A', 'A', 'Shota Kageyama'].join(US),
      ].join(RS),
    });
    const music = service({ exec });
    const scanned = await music.command(cmd({ action: 'scanLibrary', source: 'apple' }));
    expect(scanned.result.ok).toBe(true);
    expect(scanned.library?.appleLibraryScanned).toBe(true);
    const albums = scanned.library?.appleAlbums ?? [];
    expect(albums.map((a) => [a.name, a.artist, a.trackCount])).toEqual([
      ['Pokémon Ruby', 'Game Freak', 2],
      ['Pokémon X & Y', 'Shota Kageyama', 1],
    ]);

    exec.mockClear();
    const played = await music.command(
      cmd({ action: 'play', source: 'apple', stationId: albums[0].id, shuffle: true }),
    );
    expect(played.result.ok).toBe(true);
    const [first, second] = exec.mock.calls;
    expect(first[1]).toEqual([
      '-e',
      appleMusicCommand('playAlbum', { albumName: 'any' }).script,
      '_Pokémon Ruby',
      '_true',
    ]);
    expect(second[1][1]).toBe(appleMusicCommand('status').script);
    expect(played.state).toEqual({
      type: 'musicState',
      source: 'apple',
      running: true,
      playing: true,
      shuffle: true,
      volume: 50,
      track: 'Route 1',
      album: 'Pokémon Red',
      artist: 'GF',
    });
  });

  it('shuffles every Pokémon album when no album is named', async () => {
    const exec = fakeOsascript();
    await service({ exec }).command(cmd({ action: 'play', source: 'apple' }));
    expect(exec.mock.calls[0][1]).toEqual([
      '-e',
      appleMusicCommand('playAllPokemon').script,
      '_true',
    ]);
  });

  it('opens a saved Apple Music link in the app', async () => {
    const exec = fakeOsascript();
    const music = service({ exec });
    const added = await music.command(
      cmd({
        action: 'addStation',
        source: 'apple',
        uri: 'https://music.apple.com/us/album/pokemon-ruby-sapphire/123',
      }),
    );
    expect(added.library?.stations).toEqual([
      {
        id: 'apple-album-123',
        source: 'apple',
        kind: 'album',
        name: 'Pokemon Ruby Sapphire',
        url: 'https://music.apple.com/us/album/pokemon-ruby-sapphire/123',
      },
    ]);
    await music.command(cmd({ action: 'play', source: 'apple', stationId: 'apple-album-123' }));
    expect(exec.mock.calls[0][1]).toEqual([
      '-e',
      appleMusicCommand('openLocation', {
        url: 'itmss://music.apple.com/us/album/x/1?app=music',
      }).script,
      '_itmss://music.apple.com/us/album/pokemon-ruby-sapphire/123?app=music',
    ]);
  });

  it('refuses an album id it never scanned', async () => {
    const exec = fakeOsascript();
    const outcome = await service({ exec }).command(
      cmd({ action: 'play', source: 'apple', stationId: 'a'.repeat(24) }),
    );
    expect(outcome.result).toMatchObject({ ok: false, message: expect.stringContaining('Scan') });
    expect(exec).not.toHaveBeenCalled();
  });

  it('runs the controls and reads the state back', async () => {
    const exec = fakeOsascript();
    const music = service({ exec });
    for (const input of [
      cmd({ action: 'pause', source: 'apple' }),
      cmd({ action: 'resume', source: 'apple' }),
      cmd({ action: 'next', source: 'apple' }),
      cmd({ action: 'previous', source: 'apple' }),
      cmd({ action: 'setShuffle', source: 'apple', shuffle: false }),
      cmd({ action: 'setVolume', source: 'apple', volume: 30 }),
    ]) {
      const outcome = await music.command(input);
      expect(outcome.result.ok, input.action).toBe(true);
      expect(outcome.state?.source).toBe('apple');
    }
    expect(scriptsRun(exec)).toEqual([
      appleMusicCommand('pause').script,
      appleMusicCommand('status').script,
      appleMusicCommand('resume').script,
      appleMusicCommand('status').script,
      appleMusicCommand('next').script,
      appleMusicCommand('status').script,
      appleMusicCommand('previous').script,
      appleMusicCommand('status').script,
      appleMusicCommand('setShuffle', { shuffle: false }).script,
      appleMusicCommand('status').script,
      appleMusicCommand('setVolume', { volume: 30 }).script,
      appleMusicCommand('status').script,
    ]);
    expect(exec.mock.calls[10][1].slice(2)).toEqual(['_30']);
  });

  it('reports a refused Automation permission in the state', async () => {
    const exec = fakeOsascript({
      fail: { stderr: 'execution error: Not authorized to send Apple events to Music. (-1743)' },
    });
    const outcome = await service({ exec }).command(cmd({ action: 'refresh', source: 'apple' }));
    expect(outcome.result.ok).toBe(true);
    expect(outcome.state).toMatchObject({
      running: false,
      playing: false,
      error: expect.stringContaining('Automation'),
    });
    const play = await service({ exec }).command(cmd({ action: 'play', source: 'apple' }));
    expect(play.result).toMatchObject({
      ok: false,
      message: expect.stringContaining('Automation'),
    });
  });

  it('runs nothing off macOS', async () => {
    const exec = fakeOsascript();
    const outcome = await service({ exec, platform: 'linux' }).command(
      cmd({ action: 'play', source: 'apple' }),
    );
    expect(outcome.result).toMatchObject({ ok: false, message: 'Music control needs macOS.' });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('MusicService.command: Spotify', () => {
  it('saves a pasted link named by oEmbed, plays it and keeps it across restarts', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ title: 'Pokémon Sleep\u0007 Soundtrack', type: 'rich' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const exec = fakeOsascript();
    const music = service({ exec, fetch: fetchMock });
    const added = await music.command(
      cmd({
        action: 'addStation',
        source: 'spotify',
        uri: `https://open.spotify.com/intl-fr/album/${SPOTIFY_ID}?si=abc`,
      }),
    );
    expect(added.result.ok).toBe(true);
    expect(vi.mocked(fetchMock).mock.calls[0][0]).toBe(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/album/${SPOTIFY_ID}`)}`,
    );
    const station = {
      id: `spotify-album-${SPOTIFY_ID}`,
      source: 'spotify',
      kind: 'album',
      name: 'Pokémon Sleep Soundtrack',
      url: `https://open.spotify.com/album/${SPOTIFY_ID}`,
    };
    expect(added.library?.stations).toEqual([station]);

    const played = await music.command(
      cmd({ action: 'play', source: 'spotify', stationId: station.id, shuffle: true }),
    );
    expect(played.result.ok).toBe(true);
    expect(exec.mock.calls[0][1]).toEqual([
      '-e',
      spotifyCommand('playUri', { uri: `spotify:album:${SPOTIFY_ID}` }).script,
      `_spotify:album:${SPOTIFY_ID}`,
      '_true',
    ]);

    // A new server reads the saved link back.
    expect((await service().library()).stations).toEqual([station]);
    expect((fs.statSync(stateFile).mode & 0o777).toString(8)).toBe('600');

    const removed = await service().command(
      cmd({ action: 'removeStation', source: 'spotify', stationId: station.id }),
    );
    expect(removed.library?.stations).toEqual([]);
  });

  it('falls back to a plain name when oEmbed fails, and rejects other links', async () => {
    const fetchMock = vi.fn(async () => Promise.reject(new Error('offline'))) as typeof fetch;
    const music = service({ fetch: fetchMock });
    const added = await music.command(
      cmd({ action: 'addStation', source: 'spotify', uri: `spotify:playlist:${SPOTIFY_ID}` }),
    );
    expect(added.library?.stations[0].name).toBe('Spotify playlist');

    const bad = await music.command(
      cmd({ action: 'addStation', source: 'spotify', uri: 'https://evil.example/album/x' }),
    );
    expect(bad.result).toMatchObject({
      ok: false,
      message: expect.stringContaining('open.spotify.com'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-validates the saved file, dropping or rebuilding anything that does not check out', async () => {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        stations: [
          { source: 'spotify', url: 'javascript:alert(1)', name: 'bad' },
          { source: 'spotify', url: `spotify:album:${SPOTIFY_ID}" & beep & "`, name: 'bad' },
          {
            source: 'spotify',
            url: `https://open.spotify.com/track/${SPOTIFY_ID}`,
            name: 'Line\nbreak',
            target: 'do shell script "x"',
          },
          { source: 'folder', url: '/etc/passwd', name: 'bad' },
        ],
      }),
    );
    const exec = fakeOsascript();
    const music = service({ exec });
    const { stations } = await music.library();
    expect(stations).toEqual([
      {
        id: `spotify-track-${SPOTIFY_ID}`,
        source: 'spotify',
        kind: 'track',
        name: 'Line break',
        url: `https://open.spotify.com/track/${SPOTIFY_ID}`,
      },
    ]);
    await music.command(cmd({ action: 'play', source: 'spotify', stationId: stations[0].id }));
    expect(exec.mock.calls[0][1].slice(2)).toEqual([`_spotify:track:${SPOTIFY_ID}`, '_false']);
  });

  it('has no library to scan', async () => {
    const outcome = await service().command(cmd({ action: 'scanLibrary', source: 'spotify' }));
    expect(outcome.result.ok).toBe(false);
  });
});
