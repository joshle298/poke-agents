/**
 * Where Poke Agents keeps a Conductor API key the user connected with in the
 * office (connectConductor).
 *
 * - macOS: Poke Agents' OWN Keychain item (APP_KEYCHAIN_SERVICE, account
 *   `default:<normalized base url>`). Never the Conductor CLI's item
 *   (com.conductor.cli): that is Conductor's own sign-in, which Poke Agents
 *   reads (auth.ts) but never writes or deletes.
 * - Elsewhere there is no Keychain: the key lives in this process's memory for
 *   this run only. So does a key the Keychain refused to save.
 *
 * The key never reaches a command line, where other local users could read it
 * (`ps`): the write runs `security -i` and hands it the command on stdin, after
 * every value in that line passed a strict pattern, then reads the item back.
 * The service is always APP_KEYCHAIN_SERVICE, never the CLI's KEYCHAIN_SERVICE.
 * Nothing here logs the key, a command line carrying it, or the child's output.
 *
 * Who can read the item: it is written without `-T`, so macOS's default
 * access list trusts the program that created it, /usr/bin/security. Any
 * program running as this user can therefore read it with `security
 * find-generic-password` without a prompt, as it could read an environment
 * variable. The Keychain keeps the key encrypted at rest and from other users,
 * not from the user's own programs (README: Sign In, Privacy). An access list
 * trusting nothing (`-T ""`) would instead prompt on every office start.
 */

import { spawn } from 'child_process';

import { conductorKeyCandidates } from '../../../../../core/src/conductorKey.js';
import type { ConductorAuthSource } from '../../../../../core/src/messages.js';
import { defaultExecFile, type ExecFileFn, keychainAccount, readKeychainPassword } from './auth.js';
import {
  API_KEY_PATTERN,
  APP_KEYCHAIN_LABEL,
  APP_KEYCHAIN_SERVICE,
  KEYCHAIN_READ_BACK_TIMEOUT_MS,
  KEYCHAIN_TIMEOUT_MS,
  KEYCHAIN_WRITE_TIMEOUT_MS,
  SECURITY_BIN,
  SECURITY_ITEM_NOT_FOUND_EXIT,
} from './constants.js';

/** Runs a binary by absolute path without a shell, writes `input` to its
 *  stdin and closes it, and resolves the exit code. Its output is discarded. */
export type RunWithInputFn = (
  file: string,
  args: readonly string[],
  input: string,
  opts: { timeout: number },
) => Promise<{ code: number | null }>;

export const defaultRunWithInput: RunWithInputFn = (file, args, input, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout);
    timer.unref?.();
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
    // `security` may exit before reading everything (EPIPE): the read-back decides.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });

/** The keys to try from a client message, in order (conductorKeyCandidates:
 *  trimmed, a key pasted twice tries one copy first); empty when it isn't a
 *  key. */
export function apiKeyCandidates(raw: unknown): string[] {
  return typeof raw === 'string' ? conductorKeyCandidates(raw) : [];
}

/** Characters a value in the `security -i` line may hold: no quotes,
 *  backslashes, control characters or line breaks, so double quotes around it
 *  are unambiguous to any quote-aware parser. */
const KEYCHAIN_LINE_VALUE = /^[A-Za-z0-9 ._:/@~%+=,-]{1,300}$/;

export class KeychainLineError extends Error {}

/**
 * The one `security -i` command that saves (or replaces, `-U`) Poke Agents'
 * item. Every interpolated value is checked first; the service must be ours.
 */
export function keychainAddLine(account: string, key: string): string {
  if (!API_KEY_PATTERN.test(key)) throw new KeychainLineError('Not an API key');
  for (const value of [APP_KEYCHAIN_SERVICE, account, APP_KEYCHAIN_LABEL]) {
    if (!KEYCHAIN_LINE_VALUE.test(value)) throw new KeychainLineError('Unsafe Keychain value');
  }
  return `add-generic-password -U -s "${APP_KEYCHAIN_SERVICE}" -a "${account}" -l "${APP_KEYCHAIN_LABEL}" -w "${key}"\n`;
}

/** A key Poke Agents saved, and where it came from. */
export interface SavedKey {
  key: string;
  source: Extract<ConductorAuthSource, 'app' | 'session'>;
}

export interface ConductorKeyStore {
  /** Where a newly connected key goes: `keychain` (macOS) or `session`. */
  readonly storage: 'keychain' | 'session';
  /** The key saved for this API base URL, or undefined. Never throws. */
  read(baseUrl: string): Promise<SavedKey | undefined>;
  /** Save (replace) the key. Resolves where it went: `app` (the Keychain,
   *  verified by reading it back) or `session` (memory: no Keychain here, or
   *  the Keychain refused it). */
  save(baseUrl: string, key: string): Promise<SavedKey['source']>;
  /** Forget the saved key; true when there was one. Rejects only when the
   *  Keychain item is still there afterwards. Never touches the CLI's item. */
  remove(baseUrl: string): Promise<boolean>;
}

export interface KeyStoreOptions {
  platform: NodeJS.Platform;
  /** Injected for tests: runs /usr/bin/security (never a shell). */
  execFile?: ExecFileFn;
  /** Injected for tests: runs `security -i` with the command on stdin. */
  runWithInput?: RunWithInputFn;
}

function exitCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

export function createConductorKeyStore(opts: KeyStoreOptions): ConductorKeyStore {
  const execFile = opts.execFile ?? defaultExecFile;
  const runWithInput = opts.runWithInput ?? defaultRunWithInput;
  const keychain = opts.platform === 'darwin';
  /** This run's keys by account: off macOS, or when the Keychain refused one. */
  const memory = new Map<string, string>();

  const readItem = (account: string, timeoutMs?: number) =>
    readKeychainPassword(execFile, APP_KEYCHAIN_SERVICE, account, timeoutMs);

  const writeItem = async (account: string, key: string): Promise<boolean> => {
    let line: string;
    try {
      line = keychainAddLine(account, key);
    } catch {
      return false;
    }
    try {
      await runWithInput(SECURITY_BIN, ['-i'], line, { timeout: KEYCHAIN_WRITE_TIMEOUT_MS });
    } catch {
      return false;
    }
    // Interactive mode's exit status says little about the command it ran:
    // only reading the item back proves the save.
    return (await readItem(account, KEYCHAIN_READ_BACK_TIMEOUT_MS)) === key;
  };

  return {
    storage: keychain ? 'keychain' : 'session',

    async read(baseUrl) {
      const account = keychainAccount(baseUrl);
      // A key kept in memory this run is the newest intent (the Keychain may
      // still hold an older one it refused to replace).
      const remembered = memory.get(account);
      if (remembered) return { key: remembered, source: 'session' };
      if (!keychain) return undefined;
      const key = await readItem(account);
      return key ? { key, source: 'app' } : undefined;
    },

    async save(baseUrl, key) {
      const account = keychainAccount(baseUrl);
      if (keychain && (await writeItem(account, key))) {
        memory.delete(account);
        return 'app';
      }
      memory.set(account, key);
      return 'session';
    },

    async remove(baseUrl) {
      const account = keychainAccount(baseUrl);
      let removed = memory.delete(account);
      if (!keychain) return removed;
      try {
        await execFile(
          SECURITY_BIN,
          ['delete-generic-password', '-s', APP_KEYCHAIN_SERVICE, '-a', account],
          { timeout: KEYCHAIN_TIMEOUT_MS },
        );
        removed = true;
      } catch (err) {
        if (exitCode(err) !== SECURITY_ITEM_NOT_FOUND_EXIT && (await readItem(account))) {
          throw new Error('The Keychain item is still there');
        }
      }
      return removed;
    },
  };
}
