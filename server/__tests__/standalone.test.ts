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
});

describe('displayHostFor', () => {
  it('turns wildcard bind addresses into a browsable loopback host', () => {
    expect(displayHostFor('0.0.0.0')).toBe('127.0.0.1');
    expect(displayHostFor('::')).toBe('127.0.0.1');
    expect(displayHostFor('')).toBe('127.0.0.1');
    expect(displayHostFor('192.168.1.5')).toBe('192.168.1.5');
  });
});
