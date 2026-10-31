/**
 * Conductor credentials, resolved the way the official CLI resolves them:
 * CONDUCTOR_API_KEY, then CONDUCTOR_API_TOKEN, then (macOS only) the CLI's
 * Keychain entry. The token is returned to the caller and nowhere else: it is
 * never logged, persisted, or placed on a command line.
 */

import { execFile as nodeExecFile } from 'child_process';

import {
  CONDUCTOR_DEFAULT_BASE_URL,
  ENV_API_KEY,
  ENV_API_TOKEN,
  ENV_API_URL,
  KEYCHAIN_ACCOUNT_PREFIX,
  KEYCHAIN_SERVICE,
  KEYCHAIN_TIMEOUT_MS,
  SECURITY_BIN,
} from './constants.js';

/** Runs a binary by absolute path without a shell and resolves its stdout. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  opts: { timeout: number },
) => Promise<{ stdout: string }>;

export type TokenSource = 'CONDUCTOR_API_KEY' | 'CONDUCTOR_API_TOKEN' | 'keychain';

export interface ConductorAuth {
  baseUrl: string;
  token?: string;
  source?: TokenSource;
}

export const defaultExecFile: ExecFileFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    nodeExecFile(
      file,
      [...args],
      { timeout: opts.timeout, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) reject(err);
        else resolve({ stdout });
      },
    );
  });

/** Base URL: CONDUCTOR_API_URL (trailing slashes trimmed, as the CLI does) or the default. */
export function resolveBaseUrl(env: NodeJS.ProcessEnv): string {
  const fromEnv = env[ENV_API_URL];
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/+$/, '');
  return CONDUCTOR_DEFAULT_BASE_URL;
}

/** The CLI's Keychain account key: strip trailing `/`, query and hash. */
export function normalizeBaseUrlForKeychain(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return trimmed;
  }
}

export function keychainAccount(baseUrl: string): string {
  return `${KEYCHAIN_ACCOUNT_PREFIX}:${normalizeBaseUrlForKeychain(baseUrl)}`;
}

export async function resolveConductorAuth(opts: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  execFile: ExecFileFn;
}): Promise<ConductorAuth> {
  const baseUrl = resolveBaseUrl(opts.env);
  for (const name of [ENV_API_KEY, ENV_API_TOKEN] as const) {
    const value = opts.env[name]?.trim();
    if (value) return { baseUrl, token: value, source: name };
  }
  if (opts.platform !== 'darwin') return { baseUrl };
  try {
    const { stdout } = await opts.execFile(
      SECURITY_BIN,
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', keychainAccount(baseUrl), '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS },
    );
    const token = stdout.replace(/\r?\n$/, '').trim();
    if (token) return { baseUrl, token, source: 'keychain' };
  } catch {
    // Not found, access denied, or no Keychain: treated the same as no token.
  }
  return { baseUrl };
}
