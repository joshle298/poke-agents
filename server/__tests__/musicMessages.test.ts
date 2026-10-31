import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MusicCommandAction } from '../../core/src/messages.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import type { OsaExec } from '../src/music/macApps.js';
import { parseMusicCommand } from '../src/music/musicMessages.js';
import { MusicService } from '../src/music/musicService.js';

type Message = Record<string, unknown>;

const ACTIONS: MusicCommandAction[] = [
  'play',
  'pause',
  'resume',
  'next',
  'previous',
  'setShuffle',
  'setVolume',
  'refresh',
  'scanLibrary',
  'addStation',
  'removeStation',
  'openFolder',
];

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

describe('Jukebox client messages', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Message[];
  let exec: ReturnType<typeof vi.fn<OsaExec>>;
  let openFolder: ReturnType<typeof vi.fn<(dir: string) => Promise<void>>>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let music: MusicService;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-messages-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    exec = vi.fn<OsaExec>(async () => ({ stdout: 'ok\n', stderr: '' }));
    openFolder = vi.fn(async () => {});
    fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
    music = new MusicService({
      musicDir: path.join(tempHome, 'music'),
      stateFile: path.join(tempHome, 'music.json'),
      platform: 'darwin',
      home: tempHome,
      exec,
      pathExists: async () => true,
      openFolder,
      fetch: fetchMock as unknown as typeof fetch,
      settleMs: 0,
      log: () => {},
    });
  });

  afterEach(() => {
    store.dispose();
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function ctx(overrides: Partial<ClientMessageContext> = {}): ClientMessageContext {
    return { store, cache: null, privileged: true, music, ...overrides };
  }

  function send(msg: Message, context: ClientMessageContext = ctx()): void {
    handleClientMessage(msg, (m) => sent.push(m), context);
  }

  /** A valid musicCommand for each action. */
  function validCommand(action: MusicCommandAction): Message {
    return {
      type: 'musicCommand',
      action,
      source: action === 'openFolder' ? 'folder' : 'spotify',
      stationId: 'spotify-album-4aawyAB9vmqN3uQ7FjRGTy',
      uri: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy',
      volume: 50,
      shuffle: true,
    };
  }

  describe('read-only offices', () => {
    it('refuses every musicCommand action without running anything', async () => {
      for (const action of ACTIONS) send(validCommand(action), ctx({ privileged: false }));
      await settle();
      expect(sent).toEqual(
        ACTIONS.map((action) => ({
          type: 'musicActionResult',
          action,
          source: action === 'openFolder' ? 'folder' : 'spotify',
          ok: false,
          message: 'Read-only office: open the tokened URL to use the Jukebox.',
        })),
      );
      expect(exec).not.toHaveBeenCalled();
      expect(openFolder).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(tempHome, 'music.json'))).toBe(false);
      expect(fs.existsSync(path.join(tempHome, 'music'))).toBe(false);
    });

    it('sends no library to a read-only office', async () => {
      fs.mkdirSync(path.join(tempHome, 'music', 'Album'), { recursive: true });
      fs.writeFileSync(path.join(tempHome, 'music', 'Album', '01 a.mp3'), 'x');
      send({ type: 'requestMusicLibrary' }, ctx({ privileged: false }));
      await settle();
      expect(sent).toEqual([]);
    });

    it('stays silent for a malformed command from a read-only office', async () => {
      send({ type: 'musicCommand', action: 'rm', source: 'folder' }, ctx({ privileged: false }));
      await settle();
      expect(sent).toEqual([]);
    });
  });

  describe('privileged offices', () => {
    it('answers requestMusicLibrary with the library', async () => {
      fs.mkdirSync(path.join(tempHome, 'music', 'Pokémon Ruby'), { recursive: true });
      fs.writeFileSync(path.join(tempHome, 'music', 'Pokémon Ruby', '01 Opening.mp3'), 'x');
      send({ type: 'requestMusicLibrary' });
      await settle();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'musicLibrary',
        folderPath: `~${path.sep}music`,
        albums: [{ name: 'Pokémon Ruby', tracks: [{ title: 'Opening' }] }],
      });
    });

    it('runs a command and answers with the result and what changed', async () => {
      send({ type: 'musicCommand', action: 'openFolder', source: 'folder' });
      await settle();
      expect(openFolder).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([
        { type: 'musicActionResult', action: 'openFolder', source: 'folder', ok: true },
      ]);

      sent = [];
      send({
        type: 'musicCommand',
        action: 'addStation',
        source: 'spotify',
        uri: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy',
      });
      await settle();
      expect(sent.map((m) => m.type)).toEqual(['musicActionResult', 'musicLibrary']);
    });

    it('rejects malformed commands before they reach the service', async () => {
      const bad: Message[] = [
        { type: 'musicCommand', action: 'play', source: 'youtube' },
        { type: 'musicCommand', action: 'doShellScript', source: 'apple' },
        { type: 'musicCommand', action: 'setVolume', source: 'apple', volume: 101 },
        { type: 'musicCommand', action: 'setVolume', source: 'apple' },
        { type: 'musicCommand', action: 'setShuffle', source: 'apple', shuffle: 'yes' },
        { type: 'musicCommand', action: 'play', source: 'apple', stationId: '../x' },
        { type: 'musicCommand', action: 'play', source: 'apple', stationId: 'a b' },
        { type: 'musicCommand', action: 'addStation', source: 'spotify' },
        { type: 'musicCommand', action: 'addStation', source: 'spotify', uri: 'x'.repeat(501) },
        { type: 'musicCommand', action: 'removeStation', source: 'spotify' },
      ];
      for (const msg of bad) send(msg);
      await settle();
      expect(exec).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      // Recognizable action + source get a refusal; the rest are dropped.
      expect(sent.every((m) => m.type === 'musicActionResult' && m.ok === false)).toBe(true);
      expect(sent).toHaveLength(8);
    });

    it('answers when this server has no Jukebox (VS Code embedded)', async () => {
      send({ type: 'requestMusicLibrary' }, ctx({ music: undefined }));
      send({ type: 'musicCommand', action: 'pause', source: 'apple' }, ctx({ music: undefined }));
      await settle();
      expect(sent[0]).toMatchObject({
        type: 'musicLibrary',
        sources: [
          { id: 'folder', available: false },
          { id: 'apple', available: false },
          { id: 'spotify', available: false },
        ],
      });
      expect(sent[1]).toMatchObject({ type: 'musicActionResult', ok: false });
    });
  });

  it('parseMusicCommand keeps only known fields', () => {
    expect(
      parseMusicCommand({
        type: 'musicCommand',
        action: 'play',
        source: 'apple',
        stationId: 'abc',
        extra: 'ignored',
      }),
    ).toEqual({ action: 'play', source: 'apple', stationId: 'abc' });
  });
});
