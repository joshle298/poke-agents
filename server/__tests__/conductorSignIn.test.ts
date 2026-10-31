import { describe, expect, it, type Mock, vi } from 'vitest';

import type { ConductorAuthSource } from '../../core/src/messages.js';
import {
  type ConductorKeyStore,
  createConductorKeyStore,
} from '../src/providers/stream/conductor/keyStore.js';
import {
  ConductorSignIn,
  signOutMessage,
  verifyConductorKey,
} from '../src/providers/stream/conductor/signIn.js';

const KEY = `pa_${'fake'.repeat(11)}`;
const BASE = 'https://api.conductor.build';
const ME = { userId: 'u-1', email: 'user@example.com', name: 'Example User' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A fetch that answers /me from `respond`, recording what it was asked. */
function fakeFetch(respond: (auth: string | null) => Response | Promise<Response>) {
  const calls: Array<{ url: string; method?: string; auth: string | null }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ url: String(input), method: init?.method, auth });
    return respond(auth);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A fetch that never answers until its signal aborts (a dead network). */
const hangingFetch = ((_: unknown, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })) as unknown as typeof fetch;

describe('verifyConductorKey', () => {
  it('asks GET /me with the key as a Bearer token and returns the account', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, ME));
    await expect(verifyConductorKey(`${BASE}/`, KEY, fetchImpl)).resolves.toEqual(ME);
    expect(calls).toEqual([{ url: `${BASE}/me`, method: 'GET', auth: `Bearer ${KEY}` }]);
  });

  it('maps 401 and 403 to a rejection, and other failures to plain messages', async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = fakeFetch(() => json(status, { userMessage: 'bad key' }));
      await expect(verifyConductorKey(BASE, KEY, fetchImpl)).rejects.toThrow(
        'That key was rejected by Conductor.',
      );
    }
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(verifyConductorKey(BASE, KEY, down)).rejects.toThrow("Couldn't reach Conductor.");
    await expect(verifyConductorKey(BASE, KEY, hangingFetch, 20)).rejects.toThrow(
      "Couldn't reach Conductor.",
    );
    for (const res of [json(500, {}), json(200, { name: 'no id' }), new Response('not json')]) {
      const { fetchImpl } = fakeFetch(() => res);
      await expect(verifyConductorKey(BASE, KEY, fetchImpl)).rejects.toThrow(
        "Conductor couldn't check the key. Try again.",
      );
    }
  });
});

interface Harness {
  signIn: ConductorSignIn;
  keyStore: ConductorKeyStore;
  restart: Mock<() => Promise<ConductorAuthSource | undefined>>;
  logs: string[];
  calls: Array<{ url: string; auth: string | null }>;
}

function harness(
  opts: {
    env?: NodeJS.ProcessEnv;
    refusal?: string;
    respond?: (auth: string | null) => Response;
    next?: ConductorAuthSource;
    keyStore?: ConductorKeyStore;
  } = {},
): Harness {
  const keyStore = opts.keyStore ?? createConductorKeyStore({ platform: 'linux' });
  const restart = vi.fn(async (): Promise<ConductorAuthSource | undefined> => opts.next);
  const logs: string[] = [];
  const { fetchImpl, calls } = fakeFetch(
    opts.respond ?? ((auth) => (auth === `Bearer ${KEY}` ? json(200, ME) : json(401, {}))),
  );
  const signIn = new ConductorSignIn({
    env: opts.env ?? {},
    keyStore,
    fetchImpl,
    refusal: () => opts.refusal,
    restart,
    log: (message) => logs.push(message),
  });
  return { signIn, keyStore, restart, logs, calls };
}

describe('ConductorSignIn.connect', () => {
  it('checks the key, keeps it, restarts polling and names the account', async () => {
    const h = harness({ next: 'session' });
    await expect(h.signIn.connect(`  ${KEY}\n`)).resolves.toEqual({
      message: 'Connected as user@example.com',
      account: 'user@example.com',
    });
    expect(h.calls).toHaveLength(1);
    expect(await h.keyStore.read(BASE)).toEqual({ key: KEY, source: 'session' });
    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(h.logs.join('\n')).not.toContain(KEY);
  });

  it('keeps and restarts nothing when Conductor rejects the key or can’t be reached', async () => {
    const rejected = harness({ respond: () => json(401, {}) });
    await expect(rejected.signIn.connect(KEY)).rejects.toThrow(
      'That key was rejected by Conductor.',
    );
    const down = harness({
      respond: () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(down.signIn.connect(KEY)).rejects.toThrow("Couldn't reach Conductor.");
    for (const h of [rejected, down]) {
      expect(await h.keyStore.read(BASE)).toBeUndefined();
      expect(h.restart).not.toHaveBeenCalled();
    }
  });

  it('refuses a malformed key before any request', async () => {
    const h = harness();
    for (const bad of ['short', 42, null, `${KEY}"`, 'x'.repeat(1001)]) {
      await expect(h.signIn.connect(bad)).rejects.toThrow(
        "That doesn't look like a Conductor API key.",
      );
    }
    expect(h.calls).toEqual([]);
  });

  it('refuses when the environment signs the office in, or another office polls Conductor', async () => {
    const env = harness({ env: { CONDUCTOR_API_TOKEN: 'from-env' } });
    await expect(env.signIn.connect(KEY)).rejects.toThrow(
      /signs in with CONDUCTOR_API_TOKEN from its environment/,
    );
    const locked = harness({
      refusal: 'Another Poke Agents office (port 41510) tracks Conductor.',
    });
    await expect(locked.signIn.connect(KEY)).rejects.toThrow('Another Poke Agents office');
    for (const h of [env, locked]) {
      expect(h.calls).toEqual([]);
      expect(h.restart).not.toHaveBeenCalled();
    }
  });

  it('checks the key against CONDUCTOR_API_URL', async () => {
    const h = harness();
    // Not an env KEY: only the URL is set.
    const signIn = new ConductorSignIn({
      env: { CONDUCTOR_API_URL: 'https://api.example.test/' },
      keyStore: h.keyStore,
      fetchImpl: fakeFetch(() => json(200, ME)).fetchImpl,
      refusal: () => undefined,
      restart: h.restart,
    });
    await signIn.connect(KEY);
    expect(await h.keyStore.read('https://api.example.test')).toMatchObject({ key: KEY });
  });

  it('says so when the Keychain refused the key and it is kept for this session', async () => {
    const keyStore: ConductorKeyStore = {
      storage: 'keychain',
      read: async () => undefined,
      save: async () => 'session',
      remove: async () => false,
    };
    const h = harness({ keyStore });
    const result = await h.signIn.connect(KEY);
    expect(result.message).toBe(
      "Connected as user@example.com. Couldn't save it in the Keychain, so it is kept for this session only.",
    );
  });

  it('runs connects one at a time', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const keyStore = createConductorKeyStore({ platform: 'linux' });
    const signIn = new ConductorSignIn({
      env: {},
      keyStore,
      fetchImpl: fakeFetch(() => json(200, ME)).fetchImpl,
      refusal: () => undefined,
      restart: async () => {
        order.push('restart');
        await gate;
        return 'session';
      },
    });
    const first = signIn.connect(KEY);
    const second = signIn.disconnect().then(() => order.push('disconnected'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['restart']);
    release();
    await first;
    await second;
    expect(order).toEqual(['restart', 'restart', 'disconnected']);
  });
});

describe('ConductorSignIn.disconnect', () => {
  it('forgets the saved key, restarts polling, and says what still signs in', async () => {
    const h = harness({ next: undefined });
    await h.signIn.connect(KEY);
    h.restart.mockClear();
    await expect(h.signIn.disconnect()).resolves.toEqual({ message: 'Signed out.' });
    expect(await h.keyStore.read(BASE)).toBeUndefined();
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it('is honest about a CLI or environment sign-in that remains', () => {
    expect(signOutMessage(true, 'cli', undefined)).toBe(
      'Signed out. Still signed in through the Conductor CLI.',
    );
    expect(signOutMessage(false, 'cli', undefined)).toBe(
      'Poke Agents had no saved key. Still signed in through the Conductor CLI.',
    );
    expect(signOutMessage(true, 'env', 'CONDUCTOR_API_KEY')).toBe(
      'Signed out. CONDUCTOR_API_KEY still signs this office in.',
    );
    expect(signOutMessage(true, undefined, undefined)).toBe('Signed out.');
  });

  it('reports a Keychain item it could not remove', async () => {
    const keyStore: ConductorKeyStore = {
      storage: 'keychain',
      read: async () => undefined,
      save: async () => 'app',
      remove: async () => {
        throw new Error('still there');
      },
    };
    const h = harness({ keyStore });
    await expect(h.signIn.disconnect()).rejects.toThrow(
      "Couldn't remove the key from the Keychain.",
    );
    expect(h.restart).not.toHaveBeenCalled();
  });
});
