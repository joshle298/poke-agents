/**
 * While the office has no Conductor sign-in (authRequired), the provider looks
 * again for one saved outside the office: every SIGN_IN_RECHECK_MS on macOS,
 * and at once when the Mac app's window gains focus (recheckSignIn). A refused
 * read of the Conductor CLI's Keychain item is never repeated, so a denied
 * Keychain prompt doesn't come back every 30 seconds.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExecFileFn } from '../src/providers/stream/conductor/auth.js';
import { createConductorProvider } from '../src/providers/stream/conductor/conductor.js';
import {
  APP_KEYCHAIN_SERVICE,
  KEYCHAIN_SERVICE,
  SIGN_IN_RECHECK_MS,
} from '../src/providers/stream/conductor/constants.js';
import { createConductorKeyStore } from '../src/providers/stream/conductor/keyStore.js';
import { FakeConductorApi } from './fixtures/conductor/fakeConductorApi.js';
import {
  manualClock,
  NOW,
  RecordingSink,
  tmpStateDir,
} from './fixtures/conductor/pollerHarness.js';

const CLI_KEY = `cd_${'cli'.repeat(15)}`;
const APP_KEY = `pa_${'app'.repeat(15)}`;

/** What `security find-generic-password` does for one Keychain item. */
type Item = { value: string } | { exit: number } | 'missing';

/** A fake /usr/bin/security with the CLI's item and Poke Agents' own. */
function keychain() {
  const items: Record<string, Item> = {
    [KEYCHAIN_SERVICE]: 'missing',
    [APP_KEYCHAIN_SERVICE]: 'missing',
  };
  const reads: string[] = [];
  const execFile: ExecFileFn = async (_file, args) => {
    const service = args[args.indexOf('-s') + 1];
    reads.push(service);
    const item = items[service] ?? 'missing';
    if (item === 'missing') throw Object.assign(new Error('not found'), { code: 44 });
    if ('exit' in item) throw Object.assign(new Error('refused'), { code: item.exit });
    return { stdout: `${item.value}\n` };
  };
  const readsOf = (service: string) => reads.filter((s) => s === service).length;
  return { items, execFile, readsOf };
}

function setup(opts: { platform?: NodeJS.Platform } = {}) {
  const clock = manualClock(NOW);
  const api = new FakeConductorApi(() => clock.t);
  const meAuth: Array<string | null> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/me') {
      meAuth.push(new Headers(init?.headers).get('authorization'));
    }
    return api.fetch(input, init);
  }) as typeof fetch;
  const kc = keychain();
  const platform = opts.platform ?? 'darwin';
  const logs: string[] = [];
  const provider = createConductorProvider({
    fetchImpl,
    env: {},
    platform,
    execFile: kc.execFile,
    keyStore: createConductorKeyStore({ platform, execFile: kc.execFile }),
    stateDir: tmpStateDir(),
    clock,
    autoTick: false,
    log: (message) => logs.push(message),
  });
  const sink = new RecordingSink();
  return { api, meAuth, kc, provider, sink, logs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('looking for a sign-in while signed out', () => {
  it('connects once `conductor auth login` saves a key, found within SIGN_IN_RECHECK_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = setup();
    await h.provider.start(h.sink);
    expect(h.sink.lastStatus()).toMatchObject({ state: 'authRequired' });
    // Nothing yet: each look reads both items and stays signed out.
    await vi.advanceTimersByTimeAsync(SIGN_IN_RECHECK_MS);
    expect(h.kc.readsOf(KEYCHAIN_SERVICE)).toBe(2);
    expect(h.sink.lastStatus()).toMatchObject({ state: 'authRequired' });
    expect(h.api.calls).toEqual([]);

    h.kc.items[KEYCHAIN_SERVICE] = { value: CLI_KEY };
    await vi.advanceTimersByTimeAsync(SIGN_IN_RECHECK_MS);
    await vi.waitFor(() => expect(h.sink.lastStatus()).toMatchObject({ state: 'connected' }));
    expect(h.sink.lastStatus()).toMatchObject({ authSource: 'cli' });
    expect(h.meAuth).toEqual([`Bearer ${CLI_KEY}`]);
    expect(h.logs).toContain('found a sign-in made outside the office');
    expect(h.logs.join('\n')).not.toContain(CLI_KEY);

    // Connected: no more looking.
    const reads = h.kc.readsOf(KEYCHAIN_SERVICE);
    await vi.advanceTimersByTimeAsync(3 * SIGN_IN_RECHECK_MS);
    expect(h.kc.readsOf(KEYCHAIN_SERVICE)).toBe(reads);
    await h.provider.stop();
  });

  it('looks at once when asked (the Mac app’s window focus), Poke Agents’ own item first', async () => {
    const h = setup();
    await h.provider.start(h.sink);
    expect(h.sink.lastStatus()).toMatchObject({ state: 'authRequired' });
    h.kc.items[APP_KEYCHAIN_SERVICE] = { value: APP_KEY };
    h.kc.items[KEYCHAIN_SERVICE] = { value: CLI_KEY };
    h.provider.recheckSignIn();
    await vi.waitFor(() => expect(h.sink.lastStatus()).toMatchObject({ state: 'connected' }));
    expect(h.sink.lastStatus()).toMatchObject({ authSource: 'app' });
    expect(h.meAuth).toEqual([`Bearer ${APP_KEY}`]);
    // The status said so while /me ran: the Connect card gives way.
    expect(h.sink.statuses.map((s) => s.state)).toEqual([
      'connecting',
      'authRequired',
      'connecting',
      'connected',
    ]);
    await h.provider.stop();
  });

  it('never reads a refused CLI item again (no Keychain prompt every 30 s); its own item still', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = setup();
    // errSecAuthFailed: the user clicked Deny on the Keychain prompt.
    h.kc.items[KEYCHAIN_SERVICE] = { exit: 51 };
    await h.provider.start(h.sink);
    expect(h.sink.lastStatus()).toMatchObject({ state: 'authRequired' });
    expect(h.kc.readsOf(KEYCHAIN_SERVICE)).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * SIGN_IN_RECHECK_MS);
    h.provider.recheckSignIn();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.kc.readsOf(KEYCHAIN_SERVICE)).toBe(1);
    expect(h.kc.readsOf(APP_KEYCHAIN_SERVICE)).toBe(4);
    await h.provider.stop();
  });

  it('reports a key Conductor rejects, then stops looking', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = setup();
    await h.provider.start(h.sink);
    h.api.override(
      (c) => c.path === '/me',
      () => new Response('{"userMessage":"bad key"}', { status: 401 }),
    );
    h.kc.items[KEYCHAIN_SERVICE] = { value: `${CLI_KEY}${CLI_KEY}` };
    await vi.advanceTimersByTimeAsync(SIGN_IN_RECHECK_MS);
    await vi.waitFor(() => expect(h.sink.lastStatus()).toMatchObject({ state: 'unauthorized' }));
    expect(h.sink.lastStatus()).toMatchObject({
      authSource: 'cli',
      message: 'Conductor rejected the API key. Connect with a new key in the office.',
    });
    const reads = h.kc.readsOf(KEYCHAIN_SERVICE);
    await vi.advanceTimersByTimeAsync(3 * SIGN_IN_RECHECK_MS);
    expect(h.kc.readsOf(KEYCHAIN_SERVICE)).toBe(reads);
    await h.provider.stop();
  });

  it('never looks off macOS, nor after stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const linux = setup({ platform: 'linux' });
    await linux.provider.start(linux.sink);
    expect(linux.sink.lastStatus()).toMatchObject({ state: 'authRequired' });
    expect(vi.getTimerCount()).toBe(0);
    await linux.provider.stop();

    const mac = setup();
    await mac.provider.start(mac.sink);
    const reads = mac.kc.readsOf(KEYCHAIN_SERVICE);
    await mac.provider.stop();
    mac.kc.items[KEYCHAIN_SERVICE] = { value: CLI_KEY };
    mac.provider.recheckSignIn();
    await vi.advanceTimersByTimeAsync(3 * SIGN_IN_RECHECK_MS);
    expect(mac.kc.readsOf(KEYCHAIN_SERVICE)).toBe(reads);
    expect(mac.api.calls).toEqual([]);
  });
});
