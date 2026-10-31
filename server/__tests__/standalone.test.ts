import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolated HOME: the office writes its token, registry entry and settings
// under ~/.pixel-agents/.
let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { displayHostFor, startStandalone } = await import('../src/standalone.js');
const { requestLaunchUrl } = await import('../src/openAppWindow.js');
const { areSoundsEnabled, setSoundsEnabled } = await import('../src/audio/sounds.js');
const { MusicService } = await import('../src/music/musicService.js');
const { RadioCache } = await import('../src/music/radioCache.js');
const { radioOffReason, setRadioEnabled } = await import('../src/music/radioSwitch.js');
const { fakeRadioFetch, forbiddenFetch, radioTrack, syntheticTrackBytes } =
  await import('./radioTestUtils.js');
type Office = Awaited<ReturnType<typeof startStandalone>>;

/** The CLI's build output: assets/ and webview/ (built by `npm run build:app`). */
const DIST_ROOT = path.join(__dirname, '../../dist');

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function startOffice(port: number): Promise<Office> {
  return startStandalone({ distRoot: DIST_ROOT, port, conductor: false, claude: false });
}

describe('startStandalone', () => {
  const started: Office[] = [];

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-standalone-test-'));
  });

  afterEach(async () => {
    for (const office of started.splice(0)) await office.stop();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('serves the office at a tokened loopback URL it owns', async () => {
    const port = await freePort();
    const office = await startOffice(port);
    started.push(office);

    expect(office.ownsServer).toBe(true);
    expect(office.pid).toBe(process.pid);
    expect(office.port).toBe(port);
    const url = new URL(office.url);
    expect(url.host).toBe(`127.0.0.1:${port}`);
    expect(url.searchParams.get('token')).toBe(office.token);
    const page = await fetch(office.url);
    expect(await page.text()).toContain('<div id="root">');
  });

  it('reuses a running office with the same access instead of starting another', async () => {
    const port = await freePort();
    const first = await startOffice(port);
    started.push(first);
    const second = await startStandalone({
      distRoot: DIST_ROOT,
      port: await freePort(),
      conductor: false,
      claude: false,
    });
    started.push(second);

    expect(second.ownsServer).toBe(false);
    expect(second.url).toBe(first.url);
    // Stopping the reusing side leaves the running office up.
    await second.stop();
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true);
  });

  it('frees its port on stop, so the same process can start again on it', async () => {
    const port = await freePort();
    const office = await startOffice(port);
    await office.stop();
    await office.stop(); // idempotent
    expect(fs.readdirSync(path.join(tmpBase, '.pixel-agents', 'servers'))).toEqual([]);

    const again = await startOffice(port);
    started.push(again);
    expect(again.ownsServer).toBe(true);
    expect(again.port).toBe(port);
    expect(again.token).toBe(office.token); // the standalone token persists
  });

  it('stops while a window is still connected, and starts again on the same port', async () => {
    const port = await freePort();
    const office = await startOffice(port);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    const closed = new Promise((resolve) => (socket.onclose = resolve));

    await office.stop();
    await closed; // the open socket did not hold the server up

    const again = await startOffice(port);
    started.push(again);
    expect(again.port).toBe(port);
  });

  it('reports its Conductor status to a listener that subscribes after the start', async () => {
    // No token anywhere: no env key, and a base URL with no Keychain item, so
    // nothing is fetched and macOS shows no Keychain prompt.
    vi.stubEnv('CONDUCTOR_API_KEY', '');
    vi.stubEnv('CONDUCTOR_API_TOKEN', '');
    vi.stubEnv('CONDUCTOR_API_URL', 'http://127.0.0.1:9');
    try {
      const office = await startStandalone({
        distRoot: DIST_ROOT,
        port: await freePort(),
        conductor: true,
        claude: false,
        sprites: false,
      });
      started.push(office);
      await vi.waitFor(() =>
        expect(office.conductorStatus()).toMatchObject({
          type: 'conductorStatus',
          state: 'authRequired',
        }),
      );

      const off = await startOffice(await freePort());
      started.push(off);
      expect(off.conductorStatus()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('startStandalone: polish behaviors the CLI and the Mac app share', () => {
  const started: Office[] = [];

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-standalone-test-'));
    // No Conductor token anywhere, so nothing is fetched and macOS shows no
    // Keychain prompt; the poller still starts and reports authRequired.
    vi.stubEnv('CONDUCTOR_API_KEY', '');
    vi.stubEnv('CONDUCTOR_API_TOKEN', '');
    vi.stubEnv('CONDUCTOR_API_URL', 'http://127.0.0.1:9');
  });

  afterEach(async () => {
    for (const office of started.splice(0)) await office.stop();
    vi.unstubAllEnvs();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  const lockFile = (): string => path.join(tmpBase, '.pixel-agents', 'conductor.lock');

  it('takes the Conductor lock while it polls and releases it on stop', async () => {
    const port = await freePort();
    const office = await startStandalone({
      distRoot: DIST_ROOT,
      port,
      conductor: true,
      claude: false,
      sprites: false,
    });
    expect(JSON.parse(fs.readFileSync(lockFile(), 'utf-8'))).toEqual({ pid: process.pid, port });
    await vi.waitFor(() => expect(office.conductorStatus()).not.toBeNull());

    await office.stop();
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('runs without Conductor while another live office holds the lock, and leaves its lock alone', async () => {
    const holder = JSON.stringify({ pid: process.ppid, port: 41999 });
    fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
    fs.writeFileSync(lockFile(), holder);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const office = await startStandalone({
        distRoot: DIST_ROOT,
        port: await freePort(),
        conductor: true,
        claude: false,
        sprites: false,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('on port 41999'));
      expect(office.conductorStatus()).toBeNull();
      await office.stop();
      expect(fs.readFileSync(lockFile(), 'utf-8')).toBe(holder);
    } finally {
      warn.mockRestore();
    }
  });

  it("gives --open a one-time launch URL on the office's base that redirects to the tokened URL", async () => {
    const office = await startOffice(await freePort());
    started.push(office);
    expect(office.baseUrl).toBe(`http://127.0.0.1:${office.port}`);
    expect(office.url).toBe(`${office.baseUrl}/?token=${office.token}`);

    const launchUrl = await requestLaunchUrl(office.baseUrl, office.token);
    expect(launchUrl).not.toContain(office.token);
    const first = await fetch(launchUrl, { redirect: 'manual' });
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe(`/?token=${encodeURIComponent(office.token)}`);
    expect((await fetch(launchUrl, { redirect: 'manual' })).status).toBe(410);
  });
});

describe('startStandalone: sounds', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-standalone-test-'));
  });

  afterEach(() => {
    setSoundsEnabled(true);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('serves the sound pack, and none with sounds: false (--no-sounds)', async () => {
    const on = await startOffice(await freePort());
    try {
      expect(areSoundsEnabled()).toBe(true);
      expect((await fetch(`${on.baseUrl}/api/sounds`)).status).toBe(200);
    } finally {
      await on.stop();
    }

    const off = await startStandalone({
      distRoot: DIST_ROOT,
      port: await freePort(),
      conductor: false,
      claude: false,
      sounds: false,
    });
    try {
      expect(areSoundsEnabled()).toBe(false);
      expect((await fetch(`${off.baseUrl}/api/sounds`)).status).toBe(404);
    } finally {
      await off.stop();
    }
  });
});

describe('startStandalone: the Jukebox', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-standalone-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('serves music folder tracks with the MusicService the CLI and the Mac app pass, none without', async () => {
    const musicDir = path.join(tmpBase, 'music-folder');
    fs.mkdirSync(path.join(musicDir, 'Album'), { recursive: true });
    fs.writeFileSync(path.join(musicDir, 'Album', '01 Song.mp3'), 'synthetic bytes');
    const music = new MusicService({
      musicDir,
      stateFile: path.join(tmpBase, 'music.json'),
      platform: 'linux',
      home: tmpBase,
      log: () => {},
    });
    const id = (await music.library()).albums[0].tracks[0].id;
    const track = (office: Office) =>
      `${office.baseUrl}/api/music/track/${id}?token=${office.token}`;

    const withMusic = await startStandalone({
      distRoot: DIST_ROOT,
      port: await freePort(),
      conductor: false,
      claude: false,
      music,
    });
    try {
      const res = await fetch(track(withMusic));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('synthetic bytes');
    } finally {
      await withMusic.stop();
    }

    // Without one there is no music route: the SPA's history fallback answers.
    const without = await startOffice(await freePort());
    try {
      const res = await fetch(track(without));
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
      expect(await res.text()).not.toContain('synthetic bytes');
    } finally {
      await without.stop();
    }
  });
});

describe('startStandalone: Poke Agents Radio', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-standalone-test-'));
    // vitest.config.ts sets POKE_AGENTS_RADIO=off for every test file.
    vi.stubEnv('POKE_AGENTS_RADIO', '');
    setRadioEnabled(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setRadioEnabled(false);
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  function musicWith(
    fetch: ReturnType<typeof forbiddenFetch>,
    track: ReturnType<typeof radioTrack>,
  ) {
    return new MusicService({
      radio: new RadioCache({
        root: path.join(tmpBase, 'radio'),
        tracks: [track],
        fetch,
        log: () => {},
      }),
      musicDir: path.join(tmpBase, 'music-folder'),
      stateFile: path.join(tmpBase, 'music.json'),
      platform: 'linux',
      home: tmpBase,
      log: () => {},
    });
  }

  it('streams a radio track through the office, and none with radio: false (--no-radio)', async () => {
    const bytes = syntheticTrackBytes(9);
    const track = radioTrack('town', bytes);
    const url = (office: Office) =>
      `${office.baseUrl}/api/music/track/radio-town?token=${office.token}`;

    const on = await startStandalone({
      distRoot: DIST_ROOT,
      port: await freePort(),
      conductor: false,
      claude: false,
      music: musicWith(fakeRadioFetch({ [track.url]: bytes }), track),
    });
    try {
      expect(radioOffReason()).toBeNull();
      const res = await fetch(url(on));
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
    } finally {
      await on.stop();
    }

    const noDownloads = forbiddenFetch();
    const off = await startStandalone({
      distRoot: DIST_ROOT,
      port: await freePort(),
      conductor: false,
      claude: false,
      radio: false,
      music: musicWith(noDownloads, track),
    });
    try {
      expect(radioOffReason()).toMatch(/--no-radio/);
      expect((await fetch(url(off))).status).toBe(404);
      expect(noDownloads).not.toHaveBeenCalled();
    } finally {
      await off.stop();
    }
  });
});

describe('displayHostFor', () => {
  it('turns wildcard bind addresses into a browsable loopback host', () => {
    expect(displayHostFor('0.0.0.0')).toBe('127.0.0.1');
    expect(displayHostFor('::')).toBe('127.0.0.1');
    expect(displayHostFor('')).toBe('127.0.0.1');
    expect(displayHostFor('192.168.1.5')).toBe('192.168.1.5');
  });
});
