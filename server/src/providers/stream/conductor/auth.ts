/**
 * Conductor credentials, in this order: CONDUCTOR_API_KEY, then
 * CONDUCTOR_API_TOKEN, then the key the user connected with in the office
 * (Poke Agents' own store: its macOS Keychain item, or memory for this run
 * elsewhere, see keyStore.ts), then (macOS only) the Conductor CLI's Keychain
 * item, read only. The token is returned to the caller and nowhere else: it is
 * never logged, persisted by this module, or placed on a command line.
 */

import { execFile as nodeExecFile } from 'child_process';

import type { ConductorAuthSource } from '../../../../../core/src/messages.js';
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
import type { ConductorKeyStore } from './keyStore.js';

/** Runs a binary by absolute path without a shell and resolves its stdout. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  opts: { timeout: number },
) => Promise<{ stdout: string }>;

export interface ConductorAuth {
  baseUrl: string;
  token?: string;
  source?: ConductorAuthSource;
  /** The variable the key came from, when `source` is `env` (for the log). */
  envName?: string;
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

/** The environment variable holding a key, if one does (CONDUCTOR_API_KEY first). */
export function envKeyName(env: NodeJS.ProcessEnv): string | undefined {
  return [ENV_API_KEY, ENV_API_TOKEN].find((name) => !!env[name]?.trim());
}

/** A generic password from the Keychain, or undefined when there is none (or
 *  access was denied, or there is no Keychain). Never throws. */
export async function readKeychainPassword(
  execFile: ExecFileFn,
  service: string,
  account: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFile(
      SECURITY_BIN,
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS },
    );
    const value = stdout.replace(/\r?\n$/, '').trim();
    return value || undefined;
  } catch {
    // Not found, access denied, or no Keychain: treated the same as no token.
    return undefined;
  }
}

export async function resolveConductorAuth(opts: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  execFile: ExecFileFn;
  /** Poke Agents' own store for a key connected in the office. */
  keyStore?: ConductorKeyStore;
}): Promise<ConductorAuth> {
  const baseUrl = resolveBaseUrl(opts.env);
  const envName = envKeyName(opts.env);
  if (envName) {
    return { baseUrl, token: opts.env[envName]!.trim(), source: 'env', envName };
  }
  const saved = await opts.keyStore?.read(baseUrl);
  if (saved) return { baseUrl, token: saved.key, source: saved.source };
  if (opts.platform !== 'darwin') return { baseUrl };
  const token = await readKeychainPassword(
    opts.execFile,
    KEYCHAIN_SERVICE,
    keychainAccount(baseUrl),
  );
  return token ? { baseUrl, token, source: 'cli' } : { baseUrl };
}
