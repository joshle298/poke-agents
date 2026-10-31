import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  displayMusicPath,
  MusicFolderLibrary,
  parseTrackFileName,
  scanMusicFolder,
} from '../src/music/folderLibrary.js';

/** A few bytes standing in for audio: the scan reads names, never contents. */
function touch(file: string, bytes = 'synthetic'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

let base: string;
let root: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-folder-'));
  root = path.join(base, 'music');
  fs.mkdirSync(root);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('parseTrackFileName', () => {
  it('reads track and disc numbers the way rippers and stores write them', () => {
    expect(parseTrackFileName('03 - Littleroot Town')).toEqual({
      title: 'Littleroot Town',
      trackNumber: 3,
    });
    expect(parseTrackFileName('03. Route 101')).toEqual({ title: 'Route 101', trackNumber: 3 });
    expect(parseTrackFileName('12 Battle! Wild Pokémon')).toEqual({
      title: 'Battle! Wild Pokémon',
      trackNumber: 12,
    });
    expect(parseTrackFileName('2-05 Pokémon Center')).toEqual({
      title: 'Pokémon Center',
      trackNumber: 5,
      discNumber: 2,
    });
    expect(parseTrackFileName('Opening')).toEqual({ title: 'Opening' });
    expect(parseTrackFileName('07_victory_road')).toEqual({
      title: 'victory road',
      trackNumber: 7,
    });
  });

  it('composes decomposed accents (macOS file names) for display', () => {
    expect(parseTrackFileName('01 Pokémon Center').title).toBe('Pokémon Center');
  });
});

describe('scanMusicFolder', () => {
  it('lists nested albums, merges disc folders and sorts tracks by disc and number', async () => {
    touch(path.join(root, 'Pokémon X & Y', '02 - Kalos Route.m4a'));
    touch(path.join(root, 'Pokémon X & Y', '01 - Title Screen.m4a'));
    touch(path.join(root, 'Game Freak', 'Pokémon Ruby', 'Disc 2', '01 Ending.mp3'));
    touch(path.join(root, 'Game Freak', 'Pokémon Ruby', 'Disc 1', '10 Route 101.mp3'));
    touch(path.join(root, 'Game Freak', 'Pokémon Ruby', 'Disc 1', '02 Opening.mp3'));
    touch(path.join(root, 'loose.ogg'));

    const scan = await scanMusicFolder(root);
    expect(scan.exists).toBe(true);
    expect(scan.truncated).toBe(false);
    expect(scan.albums.map((a) => a.name)).toEqual([
      'Other tracks',
      'Pokémon Ruby',
      'Pokémon X & Y',
    ]);
    const ruby = scan.albums[1];
    expect(ruby.tracks.map((t) => [t.discNumber, t.trackNumber, t.title])).toEqual([
      [1, 2, 'Opening'],
      [1, 10, 'Route 101'],
      [2, 1, 'Ending'],
    ]);
    expect(ruby.tracks.every((t) => t.mimeType === 'audio/mpeg')).toBe(true);
    const xy = scan.albums[2];
    expect(xy.tracks.map((t) => t.title)).toEqual(['Title Screen', 'Kalos Route']);
    expect(xy.tracks[0].mimeType).toBe('audio/mp4');
    expect(scan.albums[0].tracks[0].mimeType).toBe('audio/ogg');
  });

  it('skips unsupported files, dotfiles and hidden folders', async () => {
    touch(path.join(root, 'Album', '01 Song.flac'));
    touch(path.join(root, 'Album', 'cover.jpg'));
    touch(path.join(root, 'Album', 'notes.txt'));
    touch(path.join(root, 'Album', '02 Protected.m4p'));
    touch(path.join(root, 'Album', '.03 Hidden.mp3'));
    touch(path.join(root, '.Trash', '01 Deleted.mp3'));
    touch(path.join(root, 'Album', '04 Loud.WAV'));

    const scan = await scanMusicFolder(root);
    expect(scan.albums).toHaveLength(1);
    expect(scan.albums[0].tracks.map((t) => [t.title, t.mimeType])).toEqual([
      ['Song', 'audio/flac'],
      ['Loud', 'audio/wav'],
    ]);
  });

  it('keeps ids stable across scans and different per file', async () => {
    touch(path.join(root, 'A', '01 One.mp3'));
    touch(path.join(root, 'B', '01 One.mp3'));
    const first = await scanMusicFolder(root);
    const second = await scanMusicFolder(root);
    expect(second.albums.map((a) => a.id)).toEqual(first.albums.map((a) => a.id));
    const ids = first.albums.flatMap((a) => [a.id, ...a.tracks.map((t) => t.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-f0-9]{24}$/.test(id))).toBe(true);
  });

  it('names same-named folders by their path', async () => {
    touch(path.join(root, 'Pokémon Emerald', 'OST', '01 a.mp3'));
    touch(path.join(root, 'Pokémon Platinum', 'OST', '01 b.mp3'));
    const names = (await scanMusicFolder(root)).albums.map((a) => a.name);
    expect(names).toEqual(['Pokémon Emerald / OST', 'Pokémon Platinum / OST']);
  });

  it('follows symlinks that stay inside the music folder', async () => {
    touch(path.join(root, 'Real Album', '01 Song.mp3'));
    fs.symlinkSync(path.join(root, 'Real Album', '01 Song.mp3'), path.join(root, 'linked.mp3'));
    const scan = await scanMusicFolder(root);
    const loose = scan.albums.find((a) => a.name === 'Other tracks');
    expect(loose?.tracks.map((t) => t.title)).toEqual(['linked']);
    expect(loose?.tracks[0].absPath).toBe(
      fs.realpathSync(path.join(root, 'Real Album', '01 Song.mp3')),
    );
  });

  it('refuses symlinks (files and folders) that lead outside the music folder', async () => {
    const outside = path.join(base, 'outside');
    touch(path.join(outside, '01 Secret.mp3'));
    touch(path.join(outside, 'Album', '01 Other.mp3'));
    fs.symlinkSync(path.join(outside, '01 Secret.mp3'), path.join(root, 'secret.mp3'));
    fs.symlinkSync(path.join(outside, 'Album'), path.join(root, 'Linked Album'));
    fs.symlinkSync('../outside', path.join(root, 'up'));
    touch(path.join(root, 'Mine', '01 Mine.mp3'));

    const scan = await scanMusicFolder(root);
    expect(scan.albums.map((a) => a.name)).toEqual(['Mine']);
    const paths = scan.albums.flatMap((a) => a.tracks.map((t) => t.absPath));
    expect(paths.every((p) => p.startsWith(fs.realpathSync(root) + path.sep))).toBe(true);
  });

  it('reads the file type from where a link leads, not from its name', async () => {
    touch(path.join(root, 'Notes', 'notes.txt'));
    fs.symlinkSync(path.join(root, 'Notes', 'notes.txt'), path.join(root, 'song.mp3'));
    touch(path.join(root, 'Mine', '01 Mine.mp3'));
    const scan = await scanMusicFolder(root);
    expect(scan.albums.map((a) => a.name)).toEqual(['Mine']);
  });

  it('does not loop on a symlink cycle and stops at the depth limit', async () => {
    touch(path.join(root, 'A', '01 a.mp3'));
    fs.symlinkSync(path.join(root, 'A'), path.join(root, 'A', 'again'));
    touch(path.join(root, '1', '2', '3', '4', '5', 'deep.mp3'));
    const scan = await scanMusicFolder(root);
    expect(scan.albums.map((a) => a.name)).toEqual(['A']);
  });

  it('stops at the track limit and says so', async () => {
    for (let i = 1; i <= 5; i++) touch(path.join(root, 'Big', `${i} t.mp3`));
    const scan = await scanMusicFolder(root, { maxDepth: 4, maxTracks: 3, maxEntries: 100 });
    expect(scan.truncated).toBe(true);
    expect(scan.albums[0].tracks).toHaveLength(3);
  });

  it('is an empty library when the folder is missing or a file', async () => {
    expect(await scanMusicFolder(path.join(base, 'nope'))).toEqual({
      exists: false,
      albums: [],
      truncated: false,
    });
    touch(path.join(base, 'file'));
    expect((await scanMusicFolder(path.join(base, 'file'))).exists).toBe(false);
  });
});

describe('MusicFolderLibrary', () => {
  it('opens only tracks from a scan, and only while they resolve inside the folder', async () => {
    touch(path.join(root, 'Album', '01 Song.mp3'), 'abcdef');
    const library = new MusicFolderLibrary(root);
    const scan = await library.scan();
    const id = scan.albums[0].tracks[0].id;

    const opened = await library.openTrack(id);
    expect(opened?.size).toBe(6);
    expect(opened?.mimeType).toBe('audio/mpeg');
    await opened?.handle.close();

    expect(await library.openTrack('0'.repeat(24))).toBeNull();

    // The scanned file is swapped for a link to a file outside the folder.
    const outside = path.join(base, 'secret.mp3');
    touch(outside, 'secret');
    fs.rmSync(path.join(root, 'Album', '01 Song.mp3'));
    fs.symlinkSync(outside, path.join(root, 'Album', '01 Song.mp3'));
    expect(await library.openTrack(id)).toBeNull();
  });

  it('refuses a track swapped for a link after its path was resolved', async () => {
    const track = path.join(root, 'Album', '01 Song.mp3');
    touch(track, 'abcdef');
    const library = new MusicFolderLibrary(root);
    const id = (await library.scan()).albums[0].tracks[0].id;
    const outside = path.join(base, 'secret.mp3');
    touch(outside, 'secret');

    // The swap lands between the realpath check and the open.
    const realTrack = fs.realpathSync(track);
    const realpath = fs.promises.realpath.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'realpath').mockImplementation(async (p) => {
      const resolved = await realpath(p);
      if (resolved !== realTrack) return resolved;
      fs.rmSync(track);
      fs.symlinkSync(outside, track);
      return realTrack;
    });
    try {
      expect(await library.openTrack(id)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('serves regular files only', async () => {
    const track = path.join(root, 'Album', '01 Song.mp3');
    touch(track);
    const library = new MusicFolderLibrary(root);
    const id = (await library.scan()).albums[0].tracks[0].id;
    fs.rmSync(track);
    fs.mkdirSync(track);
    expect(await library.openTrack(id)).toBeNull();
  });

  it('creates the folder on demand', async () => {
    const library = new MusicFolderLibrary(path.join(base, 'new', 'music'));
    await library.ensureFolder();
    expect(fs.statSync(path.join(base, 'new', 'music')).isDirectory()).toBe(true);
  });
});

describe('displayMusicPath', () => {
  it('shows the home directory as ~', () => {
    expect(displayMusicPath('/Users/ash/.pixel-agents/music', '/Users/ash')).toBe(
      '~/.pixel-agents/music',
    );
    expect(displayMusicPath('/srv/music', '/Users/ash')).toBe('/srv/music');
  });
});
