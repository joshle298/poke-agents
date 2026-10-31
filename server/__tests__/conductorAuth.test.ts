import { describe, expect, it, vi } from 'vitest';

import {
  type ExecFileFn,
  keychainAccount,
  normalizeBaseUrlForKeychain,
  resolveBaseUrl,
  resolveConductorAuth,
} from '../src/providers/stream/conductor/auth.js';

function execReturning(stdout: string): ExecFileFn & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ stdout })) as unknown as ExecFileFn & ReturnType<typeof vi.fn>;
}

describe('Conductor auth resolution', () => {
  it('prefers CONDUCTOR_API_KEY, then CONDUCTOR_API_TOKEN, before the Keychain', async () => {
    const execFile = execReturning('from-keychain\n');
    const both = await resolveConductorAuth({
      env: { CONDUCTOR_API_KEY: 'key-1', CONDUCTOR_API_TOKEN: 'token-1' },
      platform: 'darwin',
      execFile,
    });
    expect(both).toEqual({
      baseUrl: 'https://api.conductor.build',
      token: 'key-1',
      source: 'CONDUCTOR_API_KEY',
    });
    const tokenOnly = await resolveConductorAuth({
      env: { CONDUCTOR_API_KEY: '', CONDUCTOR_API_TOKEN: 'token-1' },
      platform: 'darwin',
      execFile,
    });
    expect(tokenOnly.source).toBe('CONDUCTOR_API_TOKEN');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reads the CLI Keychain entry on macOS with the absolute security path and no shell', async () => {
    const execFile = execReturning('kc-token\n');
    const auth = await resolveConductorAuth({
      env: { CONDUCTOR_API_URL: 'https://api.example.test/v1/' },
      platform: 'darwin',
      execFile,
    });
    expect(auth).toEqual({
      baseUrl: 'https://api.example.test/v1',
      token: 'kc-token',
      source: 'keychain',
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args, opts] = execFile.mock.calls[0] as [string, string[], { timeout: number }];
    expect(file).toBe('/usr/bin/security');
    expect(args).toEqual([
      'find-generic-password',
      '-s',
      'com.conductor.cli',
      '-a',
      'default:https://api.example.test/v1',
      '-w',
    ]);
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it('treats a missing Keychain entry as no token, and skips the Keychain off macOS', async () => {
    const failing = vi.fn(async () => {
      throw new Error('The specified item could not be found in the keychain.');
    }) as unknown as ExecFileFn;
    expect(await resolveConductorAuth({ env: {}, platform: 'darwin', execFile: failing })).toEqual({
      baseUrl: 'https://api.conductor.build',
    });
    const execFile = execReturning('never');
    expect(await resolveConductorAuth({ env: {}, platform: 'linux', execFile })).toEqual({
      baseUrl: 'https://api.conductor.build',
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('normalizes the base URL the way the CLI does for the Keychain account', () => {
    expect(resolveBaseUrl({})).toBe('https://api.conductor.build');
    expect(resolveBaseUrl({ CONDUCTOR_API_URL: 'https://api.example.test///' })).toBe(
      'https://api.example.test',
    );
    expect(normalizeBaseUrlForKeychain('https://api.example.test/v1/?a=1#frag')).toBe(
      'https://api.example.test/v1',
    );
    expect(normalizeBaseUrlForKeychain('https://api.conductor.build')).toBe(
      'https://api.conductor.build',
    );
    expect(keychainAccount('https://api.conductor.build/')).toBe(
      'default:https://api.conductor.build',
    );
  });
});
