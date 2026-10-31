/**
 * `--open` must never put the office token on the browser's command line: the
 * CLI mints a one-time launch code from the server and opens /launch/<code>,
 * which the server redeems once and redirects to the tokened URL.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LAUNCH_CODE_MAX, LAUNCH_CODE_TTL_MS } from '../src/constants.js';
import { LaunchCodes } from '../src/launchCodes.js';
import { openAppWindow, requestLaunchUrl } from '../src/openAppWindow.js';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { PixelAgentsServer } = await import('../src/server.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');

describe('LaunchCodes', () => {
  it('redeems a code once, and never an unknown or malformed one', () => {
    const codes = new LaunchCodes();
    const code = codes.mint();
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(codes.redeem(code)).toBe(true);
    expect(codes.redeem(code)).toBe(false);
    expect(codes.redeem('x'.repeat(32))).toBe(false);
    expect(codes.redeem('../../etc/passwd')).toBe(false);
    expect(codes.redeem(undefined)).toBe(false);
  });

  it('expires unused codes and keeps only the newest few', () => {
    let now = 1_000;
    const codes = new LaunchCodes(() => now);
    const stale = codes.mint();
    now += LAUNCH_CODE_TTL_MS + 1;
    expect(codes.redeem(stale)).toBe(false);

    const minted = Array.from({ length: LAUNCH_CODE_MAX + 1 }, () => codes.mint());
    expect(codes.redeem(minted[0])).toBe(false);
    expect(codes.redeem(minted[minted.length - 1])).toBe(true);
  });
});

describe('launch routes and --open', () => {
  let server: InstanceType<typeof PixelAgentsServer>;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-launch-'));
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
    server = new PixelAgentsServer();
  });

  afterEach(() => {
    server.stop();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  async function start(): Promise<{ base: string; token: string }> {
    const config = await server.start({ embedded: false, store: new AgentStateStore() });
    return { base: `http://127.0.0.1:${config.port}`, token: config.token };
  }

  it('opens a window on a one-time URL that redirects to the tokened office', async () => {
    const { base, token } = await start();
    const argv: string[][] = [];
    const via = await openAppWindow(await requestLaunchUrl(base, token), {
      platform: 'darwin',
      exec: async (file, args) => {
        argv.push([file, ...args]);
      },
    });
    expect(via).toBe('Google Chrome');
    const launched = argv[0].join(' ');
    expect(launched).not.toContain(token);
    const url = /--app=(\S+)/.exec(launched)?.[1] ?? '';
    expect(url).toMatch(new RegExp(`^${base}/launch/[A-Za-z0-9_-]+$`));

    // The window's first request is redirected to the tokened URL...
    const first = await fetch(url, { redirect: 'manual' });
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe(`/?token=${encodeURIComponent(token)}`);
    expect(first.headers.get('cache-control')).toBe('no-store');
    // ...and a copy read from argv afterwards is worthless.
    const replay = await fetch(url, { redirect: 'manual' });
    expect(replay.status).toBe(410);
    expect(await replay.text()).not.toContain(token);
  });

  it('mints codes only for the token holder', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/launch-code`, { method: 'POST' });
    expect(res.status).toBe(401);
    await expect(requestLaunchUrl(base, 'not-the-token')).rejects.toThrow(/HTTP 401/);
  });

  it('redeems only under an allowed Host (DNS-rebinding defence)', async () => {
    const { base, token } = await start();
    const url = await requestLaunchUrl(base, token);
    const { request } = await import('http');
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});
