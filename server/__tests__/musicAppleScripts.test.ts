import { describe, expect, it, vi } from 'vitest';

import {
  APPLE_MUSIC_ACTIONS,
  appleMusicCommand,
  ARG_PREFIX,
  parsePokemonAlbums,
  parseStatus,
  ScriptArgumentError,
  SPOTIFY_ACTIONS,
  spotifyCommand,
} from '../src/music/appleScripts.js';
import { MacMusicApp, mapOsaError, osaErrorNumber, type OsaExec } from '../src/music/macApps.js';

const US = '\u001f';
const RS = '\u001e';
const URI = 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy';
const HOSTILE = '" & (do shell script "touch /tmp/pwned") & "';

/** Every command each table can build, with valid parameters. */
function allCommands() {
  const music = [...APPLE_MUSIC_ACTIONS].map((action) =>
    appleMusicCommand(action, {
      albumName: 'Pokémon X & Y',
      shuffle: true,
      volume: 40,
      url: 'itmss://music.apple.com/us/album/x/1?app=music',
    }),
  );
  const spotify = [...SPOTIFY_ACTIONS].map((action) =>
    spotifyCommand(action, { uri: URI, shuffle: false, volume: 40 }),
  );
  return [...music, ...spotify];
}

/** Rough block balance: every tell/if/try/repeat/run block is closed in order. */
function blocksBalance(script: string): boolean {
  const stack: string[] = [];
  for (const raw of script.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('end ')) {
      const kind = line.slice(4).split(' ')[0];
      if (stack.pop() !== kind) return false;
    } else if (line === 'on run argv') stack.push('run');
    else if (line.startsWith('tell ') && !/ to /.test(line)) stack.push('tell');
    else if (line.startsWith('if ') && line.endsWith(' then')) stack.push('if');
    else if (line === 'try') stack.push('try');
    else if (line.startsWith('repeat')) stack.push('repeat');
  }
  return stack.length === 0;
}

describe('AppleScript builders', () => {
  it('builds only fixed, well-formed scripts that read their values from argv', () => {
    for (const command of allCommands()) {
      expect(command.script.startsWith('on run argv')).toBe(true);
      expect(command.script.endsWith('end run')).toBe(true);
      expect(blocksBalance(command.script), command.script).toBe(true);
      expect(command.script).not.toContain('${');
      expect(command.script).not.toMatch(/do shell script|run script|load script|system attribute/);
      // Only the two apps are ever addressed.
      for (const target of command.script.match(/application id "[^"]+"/g) ?? []) {
        expect([
          'application id "com.apple.Music"',
          'application id "com.spotify.client"',
        ]).toContain(target);
      }
      for (const arg of command.args) expect(arg.startsWith(ARG_PREFIX)).toBe(true);
      expect(command.timeoutMs).toBeGreaterThan(0);
    }
  });

  it('passes untrusted names only as arguments, never in the script text', () => {
    const benign = appleMusicCommand('playAlbum', { albumName: 'Pokémon Ruby', shuffle: false });
    const hostile = appleMusicCommand('playAlbum', { albumName: HOSTILE, shuffle: true });
    expect(hostile.script).toBe(benign.script);
    expect(hostile.script).not.toContain('pwned');
    expect(hostile.args).toEqual([`${ARG_PREFIX}${HOSTILE}`, `${ARG_PREFIX}true`]);
    // A name that looks like an osascript option stays an argument.
    expect(appleMusicCommand('playAlbum', { albumName: '-e' }).args[0]).toBe(`${ARG_PREFIX}-e`);
  });

  it('refuses arguments that are not one printable line', () => {
    for (const albumName of ['', 'a\nb', 'tab\there', 'nul\u0000', 'x'.repeat(1001)]) {
      expect(
        () => appleMusicCommand('playAlbum', { albumName }),
        JSON.stringify(albumName),
      ).toThrow(ScriptArgumentError);
    }
  });

  it('builds only allowlisted actions', () => {
    for (const action of ['doShellScript', 'activate', 'quit', 'toString', '__proto__', '']) {
      expect(() => appleMusicCommand(action)).toThrow(ScriptArgumentError);
      expect(() => spotifyCommand(action)).toThrow(ScriptArgumentError);
    }
    // Each app only has its own commands.
    expect(() => spotifyCommand('playAlbum', { albumName: 'x' } as never)).toThrow(
      ScriptArgumentError,
    );
    expect(() => appleMusicCommand('playUri', { uri: URI } as never)).toThrow(ScriptArgumentError);
  });

  it('validates volumes, Spotify URIs and Apple Music links', () => {
    expect(appleMusicCommand('setVolume', { volume: 0 }).args).toEqual([`${ARG_PREFIX}0`]);
    expect(spotifyCommand('setVolume', { volume: 100 }).args).toEqual([`${ARG_PREFIX}100`]);
    for (const volume of [-1, 101, 1.5, Number.NaN, '50' as unknown as number, undefined]) {
      expect(() => appleMusicCommand('setVolume', { volume })).toThrow(ScriptArgumentError);
    }
    expect(spotifyCommand('playUri', { uri: URI, shuffle: true }).args).toEqual([
      `${ARG_PREFIX}${URI}`,
      `${ARG_PREFIX}true`,
    ]);
    for (const uri of [
      'spotify:album:short',
      `${URI}" & beep & "`,
      'https://open.spotify.com/album/x',
    ]) {
      expect(() => spotifyCommand('playUri', { uri })).toThrow(ScriptArgumentError);
    }
    for (const url of [
      'https://music.apple.com/us/album/x/1',
      'itmss://evil.example/x?app=music',
      'itmss://music.apple.com/us/album/x/1?app=music" & beep',
    ]) {
      expect(() => appleMusicCommand('openLocation', { url })).toThrow(ScriptArgumentError);
    }
  });

  it('never launches an app just to read or tweak it', () => {
    for (const action of ['status', 'pause', 'next', 'previous', 'setShuffle', 'setVolume']) {
      const music = appleMusicCommand(action, { volume: 10, shuffle: true });
      expect(music.script).toMatch(/is not running then return "notRunning"/);
      const spotify = spotifyCommand(action, { volume: 10, shuffle: true });
      expect(spotify.script).toMatch(/is not running then return "notRunning"/);
    }
  });

  it('only clears a queue playlist it marked as its own', () => {
    const script = appleMusicCommand('playAllPokemon').script;
    expect(script).toContain('if not owned then error');
    expect(script.indexOf('if not owned then error')).toBeLessThan(
      script.indexOf('delete every track of pl'),
    );
  });
});

describe('script output parsers', () => {
  it('reads app status', () => {
    expect(parseStatus('notRunning\n')).toEqual({ running: false, playing: false });
    expect(
      parseStatus(
        ['running', 'playing', 'true', '65', 'Route 1', 'Pokémon Red', 'Junichi Masuda'].join(US) +
          '\n',
      ),
    ).toEqual({
      running: true,
      playing: true,
      shuffle: true,
      volume: 65,
      track: 'Route 1',
      album: 'Pokémon Red',
      artist: 'Junichi Masuda',
    });
    expect(parseStatus(['running', 'stopped', 'false', '999', '', '', ''].join(US))).toEqual({
      running: true,
      playing: false,
      shuffle: false,
    });
    expect(parseStatus('garbage')).toEqual({ running: false, playing: false });
  });

  it('groups the library scan into albums with counts and their usual artist', () => {
    const albums = ['Pokémon Ruby', 'Pokémon Ruby', 'Pokémon X & Y', 'Bad\u0007Name', ''];
    const albumArtists = ['Game Freak', '', 'Game Freak', 'x', ''];
    const artists = ['Go Ichinose', 'Go Ichinose', 'Shota Kageyama', 'x', ''];
    const output = [albums.join(US), albumArtists.join(US), artists.join(US)].join(RS) + '\n';
    expect(parsePokemonAlbums(output)).toEqual([
      { name: 'Pokémon Ruby', trackCount: 2, artist: 'Game Freak' },
      { name: 'Pokémon X & Y', trackCount: 1, artist: 'Game Freak' },
    ]);
    expect(parsePokemonAlbums(`${RS}${RS}\n`)).toEqual([]);
  });
});

describe('MacMusicApp', () => {
  function app(
    id: 'apple' | 'spotify',
    {
      platform = 'darwin' as NodeJS.Platform,
      installed = true,
      exec = vi.fn<OsaExec>(async () => ({ stdout: 'ok\n', stderr: '' })),
    } = {},
  ) {
    const pathExists = vi.fn(async () => installed);
    const log = vi.fn();
    return {
      exec,
      pathExists,
      log,
      app: new MacMusicApp(id, { platform, exec, pathExists, home: '/Users/ash', log }),
    };
  }

  it('runs osascript by absolute path with the script and arguments, no shell', async () => {
    const { app: music, exec } = app('apple');
    const command = appleMusicCommand('playAlbum', { albumName: 'Pokémon Ruby', shuffle: true });
    expect(await music.run(command)).toBe('ok\n');
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args, options] = exec.mock.calls[0];
    expect(file).toBe('/usr/bin/osascript');
    expect(args).toEqual(['-e', command.script, ...command.args]);
    expect(options.timeout).toBe(command.timeoutMs);
  });

  it('runs nothing off macOS or when the app is missing', async () => {
    const linux = app('apple', { platform: 'linux' });
    expect(await linux.app.availability()).toEqual({
      available: false,
      reason: 'Music control needs macOS.',
    });
    await expect(linux.app.run(appleMusicCommand('status'))).rejects.toMatchObject({
      kind: 'unsupported',
    });
    expect(linux.exec).not.toHaveBeenCalled();
    expect(linux.pathExists).not.toHaveBeenCalled();

    const missing = app('spotify', { installed: false });
    expect(await missing.app.availability()).toEqual({
      available: false,
      reason: "Spotify isn't installed.",
    });
    await expect(missing.app.run(spotifyCommand('status'))).rejects.toMatchObject({
      kind: 'notInstalled',
    });
    expect(missing.exec).not.toHaveBeenCalled();
    expect(missing.pathExists).toHaveBeenCalledWith('/Applications/Spotify.app');
    expect(missing.pathExists).toHaveBeenCalledWith('/Users/ash/Applications/Spotify.app');
  });

  it('turns osascript failures into short messages and logs the raw one', async () => {
    const denied = Object.assign(new Error('Command failed'), {
      code: 1,
      stderr: '0:42: execution error: Not authorized to send Apple events to Music. (-1743)\n',
    });
    const { app: music, log } = app('apple', {
      exec: vi.fn<OsaExec>(async () => Promise.reject(denied)),
    });
    await expect(music.run(appleMusicCommand('status'))).rejects.toMatchObject({
      kind: 'notAuthorized',
      message: expect.stringContaining('Privacy & Security › Automation'),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('(-1743)'));
  });

  it('maps the errors that matter', () => {
    const err = (stderr: string, extra: object = {}) => ({ code: 1, stderr, ...extra });
    expect(osaErrorNumber('execution error: x (-600)\n')).toBe(-600);
    expect(mapOsaError('apple', err('x (-600)')).kind).toBe('notRunning');
    expect(mapOsaError('spotify', err('x (-10814)')).kind).toBe('notInstalled');
    expect(mapOsaError('apple', err('x (7404)')).kind).toBe('albumGone');
    expect(mapOsaError('apple', err('x (7409)')).message).toContain('Poke Agents Jukebox');
    expect(mapOsaError('apple', { killed: true, signal: 'SIGTERM' }).kind).toBe('timeout');
    expect(mapOsaError('apple', { code: 'ENOENT' }).kind).toBe('unsupported');
    expect(mapOsaError('spotify', err('weird')).message).toBe("Spotify couldn't do that.");
  });
});
