import { describe, expect, it, vi } from 'vitest';

import {
  type ExecFileFn,
  keychainAccount,
  resolveConductorAuth,
} from '../src/providers/stream/conductor/auth.js';
import {
  createConductorKeyStore,
  keychainAddLine,
  normalizeApiKey,
  type RunWithInputFn,
} from '../src/providers/stream/conductor/keyStore.js';

/** Shaped like a Conductor key; not a real one. */
const KEY = `pa_${'fake'.repeat(11)}`;
const OTHER_KEY = `pa_${'wrong'.repeat(9)}`;
const BASE = 'https://api.conductor.build';
const ACCOUNT = 'default:https://api.conductor.build';
const OUR_SERVICE = 'com.joshle298.pokeagents.conductor';
const CLI_SERVICE = 'com.conductor.cli';

interface ExecCall {
  file: string;
  args: string[];
}

/**
 * A pretend `/usr/bin/security` with a Keychain of generic passwords keyed by
 * service and account. `-i` reads its one command from stdin, as the real
 * interactive mode does. It never runs anything.
 */
function fakeSecurity(opts: { items?: Record<string, string>; refuseWrites?: boolean } = {}) {
  const items = new Map(Object.entries(opts.items ?? {}));
  const execCalls: ExecCall[] = [];
  const inputCalls: Array<{ file: string; args: string[]; input: string }> = [];
  const at = (service: string, account: string) => `${service}|${account}`;
  const arg = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];

  const execFile = vi.fn(async (file: string, args: readonly string[]) => {
    execCalls.push({ file, args: [...args] });
    const key = at(arg(args, '-s'), arg(args, '-a'));
    if (args[0] === 'find-generic-password') {
      const value = items.get(key);
      if (value === undefined) throw Object.assign(new Error('not found'), { code: 44 });
      return { stdout: `${value}\n` };
    }
    if (args[0] === 'delete-generic-password') {
      if (!items.delete(key)) throw Object.assign(new Error('not found'), { code: 44 });
      return { stdout: '' };
    }
    throw new Error(`unexpected ${args[0]}`);
  }) as unknown as ExecFileFn;

  const runWithInput: RunWithInputFn = vi.fn(async (file, args, input) => {
    inputCalls.push({ file, args: [...args], input });
    const match =
      /^add-generic-password -U -s "([^"]+)" -a "([^"]+)" -l "([^"]+)" -w "([^"]+)"\n$/.exec(input);
    if (match && !opts.refuseWrites) items.set(at(match[1], match[2]), match[4]);
    return { code: 0 };
  });

  return { items, execFile, runWithInput, execCalls, inputCalls, at };
}

describe('normalizeApiKey', () => {
  it('accepts key-shaped text, trimmed, with no fixed prefix', () => {
    expect(normalizeApiKey(`  ${KEY}\n`)).toBe(KEY);
    expect(normalizeApiKey('x'.repeat(20))).toBe('x'.repeat(20));
    expect(normalizeApiKey('abc-DEF_123'.repeat(3))).toBe('abc-DEF_123'.repeat(3));
  });

  it('refuses anything else, and oversize payloads before trimming', () => {
    for (const bad of [
      undefined,
      42,
      '',
      'too-short',
      `${KEY} extra`,
      `${KEY}"`,
      `${KEY}\\`,
      `${KEY}\n-w other`,
      'x'.repeat(201),
      `${' '.repeat(990)}${KEY}`,
    ]) {
      expect(normalizeApiKey(bad)).toBeNull();
    }
  });
});

describe('keychainAddLine', () => {
  it('names only Poke Agents’ own item, every value quoted', () => {
    expect(keychainAddLine(ACCOUNT, KEY)).toBe(
      `add-generic-password -U -s "${OUR_SERVICE}" -a "${ACCOUNT}" -l "Poke Agents Conductor API key" -w "${KEY}"\n`,
    );
    expect(keychainAddLine(ACCOUNT, KEY)).not.toContain(CLI_SERVICE);
  });

  it('refuses values that could break out of the line', () => {
    expect(() => keychainAddLine(ACCOUNT, `${KEY}" -s "${CLI_SERVICE}`)).toThrow();
    expect(() => keychainAddLine('default:https://x.test/"\n-w', KEY)).toThrow();
    expect(() => keychainAddLine('default:https://x.test/a\\b', KEY)).toThrow();
  });
});

describe('Conductor key store on macOS', () => {
  it('writes through `security -i` on stdin, never with the key in argv, and reads it back', async () => {
    const security = fakeSecurity();
    const store = createConductorKeyStore({
      platform: 'darwin',
      execFile: security.execFile,
      runWithInput: security.runWithInput,
    });
    expect(store.storage).toBe('keychain');
    expect(await store.save(BASE, KEY)).toBe('app');

    expect(security.inputCalls).toHaveLength(1);
    const [write] = security.inputCalls;
    expect(write.file).toBe('/usr/bin/security');
    expect(write.args).toEqual(['-i']);
    expect(write.input).toContain(`-w "${KEY}"`);
    // The read-back: argv names the item, never the key.
    expect(security.execCalls).toEqual([
      {
        file: '/usr/bin/security',
        args: ['find-generic-password', '-s', OUR_SERVICE, '-a', ACCOUNT, '-w'],
      },
    ]);
    for (const call of [...security.execCalls, ...security.inputCalls]) {
      expect(call.args.join(' ')).not.toContain(KEY);
    }
    expect(security.items.get(security.at(OUR_SERVICE, ACCOUNT))).toBe(KEY);
    expect(await store.read(BASE)).toEqual({ key: KEY, source: 'app' });
  });

  it('keeps the key for this session when the read-back does not match', async () => {
    const security = fakeSecurity({ refuseWrites: true });
    const store = createConductorKeyStore({
      platform: 'darwin',
      execFile: security.execFile,
      runWithInput: security.runWithInput,
    });
    expect(await store.save(BASE, KEY)).toBe('session');
    expect(await store.read(BASE)).toEqual({ key: KEY, source: 'session' });
    expect(security.items.size).toBe(0);
  });

  it('a key kept in memory this run wins over an older Keychain item', async () => {
    const security = fakeSecurity({ items: { [`${OUR_SERVICE}|${ACCOUNT}`]: OTHER_KEY } });
    const store = createConductorKeyStore({
      platform: 'darwin',
      execFile: security.execFile,
      runWithInput: vi.fn(async () => {
        throw new Error('security is missing');
      }),
    });
    expect(await store.read(BASE)).toEqual({ key: OTHER_KEY, source: 'app' });
    expect(await store.save(BASE, KEY)).toBe('session');
    expect(await store.read(BASE)).toEqual({ key: KEY, source: 'session' });
  });

  it('deletes only its own item, never the Conductor CLI’s', async () => {
    const security = fakeSecurity({
      items: { [`${OUR_SERVICE}|${ACCOUNT}`]: KEY, [`${CLI_SERVICE}|${ACCOUNT}`]: OTHER_KEY },
    });
    const store = createConductorKeyStore({
      platform: 'darwin',
      execFile: security.execFile,
      runWithInput: security.runWithInput,
    });
    expect(await store.remove(BASE)).toBe(true);
    expect(security.execCalls.at(-1)).toEqual({
      file: '/usr/bin/security',
      args: ['delete-generic-password', '-s', OUR_SERVICE, '-a', ACCOUNT],
    });
    expect(security.items.has(security.at(OUR_SERVICE, ACCOUNT))).toBe(false);
    expect(security.items.get(security.at(CLI_SERVICE, ACCOUNT))).toBe(OTHER_KEY);
    // Nothing left of ours: a second sign-out removes nothing.
    expect(await store.remove(BASE)).toBe(false);
    const touched = security.execCalls.filter((c) => c.args[0] !== 'find-generic-password');
    expect(touched.every((c) => c.args.includes(OUR_SERVICE))).toBe(true);
    expect(touched.some((c) => c.args.includes(CLI_SERVICE))).toBe(false);
  });

  it('reports a delete that left the item behind', async () => {
    const security = fakeSecurity({ items: { [`${OUR_SERVICE}|${ACCOUNT}`]: KEY } });
    const execFile = vi.fn(async (file: string, args: readonly string[]) => {
      if (args[0] === 'delete-generic-password')
        throw Object.assign(new Error('denied'), { code: 1 });
      return security.execFile(file, args, { timeout: 1 });
    }) as unknown as ExecFileFn;
    const store = createConductorKeyStore({ platform: 'darwin', execFile });
    await expect(store.remove(BASE)).rejects.toThrow();
  });
});

describe('Conductor key store elsewhere', () => {
  it('keeps the key in memory for this run and never runs `security`', async () => {
    const security = fakeSecurity();
    const store = createConductorKeyStore({
      platform: 'linux',
      execFile: security.execFile,
      runWithInput: security.runWithInput,
    });
    expect(store.storage).toBe('session');
    expect(await store.read(BASE)).toBeUndefined();
    expect(await store.save(BASE, KEY)).toBe('session');
    expect(await store.read(BASE)).toEqual({ key: KEY, source: 'session' });
    expect(await store.read('https://other.example.test')).toBeUndefined();
    expect(await store.remove(BASE)).toBe(true);
    expect(await store.read(BASE)).toBeUndefined();
    expect(security.execCalls).toEqual([]);
    expect(security.inputCalls).toEqual([]);
  });
});

describe('Conductor sign-in resolution order', () => {
  const both = {
    [`${OUR_SERVICE}|${ACCOUNT}`]: 'app_key_not_real_app_key_not_real',
    [`${CLI_SERVICE}|${ACCOUNT}`]: 'cli_key_not_real_cli_key_not_real',
  };

  it('env key, env token, Poke Agents’ item, then the CLI’s item', async () => {
    const security = fakeSecurity({ items: both });
    const keyStore = createConductorKeyStore({
      platform: 'darwin',
      execFile: security.execFile,
      runWithInput: security.runWithInput,
    });
    const resolve = (env: NodeJS.ProcessEnv) =>
      resolveConductorAuth({ env, platform: 'darwin', execFile: security.execFile, keyStore });

    expect(
      await resolve({ CONDUCTOR_API_KEY: 'env-key', CONDUCTOR_API_TOKEN: 'env-token' }),
    ).toEqual({
      baseUrl: BASE,
      token: 'env-key',
      source: 'env',
      envName: 'CONDUCTOR_API_KEY',
    });
    expect(await resolve({ CONDUCTOR_API_TOKEN: 'env-token' })).toMatchObject({
      token: 'env-token',
      source: 'env',
      envName: 'CONDUCTOR_API_TOKEN',
    });
    expect(await resolve({})).toMatchObject({
      token: both[`${OUR_SERVICE}|${ACCOUNT}`],
      source: 'app',
    });

    security.items.delete(security.at(OUR_SERVICE, ACCOUNT));
    expect(await resolve({})).toMatchObject({
      token: both[`${CLI_SERVICE}|${ACCOUNT}`],
      source: 'cli',
    });

    security.items.clear();
    expect(await resolve({})).toEqual({ baseUrl: BASE });
  });

  it('off macOS: env, then this session’s key, and no Keychain at all', async () => {
    const security = fakeSecurity({ items: both });
    const keyStore = createConductorKeyStore({ platform: 'linux', execFile: security.execFile });
    const resolve = () =>
      resolveConductorAuth({ env: {}, platform: 'linux', execFile: security.execFile, keyStore });
    expect(await resolve()).toEqual({ baseUrl: BASE });
    await keyStore.save(BASE, KEY);
    expect(await resolve()).toEqual({ baseUrl: BASE, token: KEY, source: 'session' });
    expect(security.execCalls).toEqual([]);
  });

  it('uses the same account scheme as the CLI for its own item', () => {
    expect(keychainAccount(`${BASE}/`)).toBe(ACCOUNT);
  });
});
