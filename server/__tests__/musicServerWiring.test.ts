import type { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { createHttpServer } from '../src/httpServer.js';
import { MusicService } from '../src/music/musicService.js';

const TOKEN = 'wiring-token';

describe('Jukebox route wiring', () => {
  let base: string;
  let music: MusicService;
  let store: AgentStateStore;
  let app: FastifyInstance | null = null;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-wiring-'));
    fs.mkdirSync(path.join(base, 'music', 'Album'), { recursive: true });
    fs.writeFileSync(path.join(base, 'music', 'Album', '01 Song.mp3'), 'synthetic bytes');
    music = new MusicService({
      musicDir: path.join(base, 'music'),
      stateFile: path.join(base, 'music.json'),
      platform: 'linux',
      home: base,
      log: () => {},
    });
    store = new AgentStateStore();
  });

  afterEach(async () => {
    await app?.close();
    app = null;
    store.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  });

  async function trackUrl(port: number): Promise<string> {
    const id = (await music.library()).albums[0].tracks[0].id;
    return `http://127.0.0.1:${port}/api/music/track/${id}?token=${TOKEN}`;
  }

  it('serves folder tracks from the standalone server', async () => {
    const server = await createHttpServer({ embedded: false, token: TOKEN, store, music });
    app = server.app;
    const res = await fetch(await trackUrl(server.port));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('synthetic bytes');
  });

  it('has no music route on the embedded (VS Code) server', async () => {
    const server = await createHttpServer({ embedded: true, token: TOKEN, store, music });
    app = server.app;
    expect((await fetch(await trackUrl(server.port))).status).toBe(404);
  });
});
