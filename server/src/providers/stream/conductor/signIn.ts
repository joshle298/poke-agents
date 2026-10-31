/**
 * Connecting the office to Conductor from the UI, and signing out.
 *
 * Conductor has no OAuth or device-code flow for other apps: `conductor auth
 * login` itself opens the API keys page, takes a pasted key, checks it with
 * GET /me and saves it. The office does the same with its own store: a key the
 * user pastes (connectConductor) is checked with GET /me against the
 * configured base URL (text that is one key pasted twice tries a single copy
 * first, conductorKeyCandidates), saved where keyStore.ts keeps it (Poke Agents' own
 * Keychain item on macOS, memory elsewhere; never the Conductor CLI's item),
 * and Conductor polling restarts in this process so sessions walk in without
 * restarting the office. Signing out (disconnectConductor) forgets only that
 * key and restarts polling, which then uses whatever sign-in is left.
 *
 * The key is never logged, echoed in a reply, or put in an error message.
 */

import type { ConductorAuthSource } from '../../../../../core/src/messages.js';
import { envKeyName, resolveBaseUrl } from './auth.js';
import {
  CONNECT_SETTLE_TIMEOUT_MS,
  KEY_CHECK_FAILED_MESSAGE,
  KEY_INVALID_MESSAGE,
  KEY_REJECTED_MESSAGE,
  KEY_UNREACHABLE_MESSAGE,
  KEYCHAIN_REMOVE_FAILED_MESSAGE,
  KEYCHAIN_SAVE_FAILED_NOTE,
  REQUEST_TIMEOUT_MS,
} from './constants.js';
import { apiKeyCandidates, type ConductorKeyStore } from './keyStore.js';
import type { ConductorMe } from './types.js';

/** A refusal whose message is safe to show the user as is. */
export class SignInError extends Error {}

/** Conductor answered 401 or 403: it doesn't take this key. */
class KeyRejectedError extends SignInError {
  constructor() {
    super(KEY_REJECTED_MESSAGE);
  }
}

export interface SignInResult {
  /** What the office shows: "Connected as …", or what signing out left. */
  message: string;
  /** The account the key belongs to (connect only). */
  account?: string;
}

/** What the office's message handler calls (ClientMessageContext.conductorSignIn). */
export interface ConductorSignInControl {
  connect(rawKey: unknown): Promise<SignInResult>;
  disconnect(): Promise<SignInResult>;
}

export interface ConductorSignInOptions {
  env: NodeJS.ProcessEnv;
  keyStore: ConductorKeyStore;
  fetchImpl?: typeof fetch;
  /** Why this office can't change its Conductor sign-in now (Conductor off,
   *  another office polls it), or undefined. */
  refusal(): string | undefined;
  /** Restart Conductor polling so it resolves the sign-in again. Resolves with
   *  the source the new poller found (undefined: none, or not within
   *  `settleTimeoutMs`, default SIGN_IN_SETTLE_TIMEOUT_MS). */
  restart(settleTimeoutMs?: number): Promise<ConductorAuthSource | undefined>;
  log?: (message: string) => void;
  /** GET /me timeout. */
  timeoutMs?: number;
}

/**
 * GET /me with the key, as `conductor auth login` checks one. Rejects with a
 * SignInError: 401/403 → rejected, network failure or timeout → unreachable,
 * anything else unexpected → "couldn't check".
 */
export async function verifyConductorKey(
  baseUrl: string,
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ConductorMe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/me`, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: controller.signal,
      });
    } catch {
      throw new SignInError(KEY_UNREACHABLE_MESSAGE);
    }
    if (res.status === 401 || res.status === 403) throw new KeyRejectedError();
    if (!res.ok) throw new SignInError(KEY_CHECK_FAILED_MESSAGE);
    let me: Partial<ConductorMe> | null;
    try {
      me = (await res.json()) as Partial<ConductorMe> | null;
    } catch {
      // A body cut off by the timeout is a network failure too.
      throw new SignInError(
        controller.signal.aborted ? KEY_UNREACHABLE_MESSAGE : KEY_CHECK_FAILED_MESSAGE,
      );
    }
    if (!me || typeof me.userId !== 'string' || !me.userId) {
      throw new SignInError(KEY_CHECK_FAILED_MESSAGE);
    }
    return me as ConductorMe;
  } finally {
    clearTimeout(timer);
  }
}

/** The account to name: the email, else the name, on one line. */
export function accountName(me: ConductorMe): string | undefined {
  const name = me.email?.trim() || me.name?.trim();
  return name ? name.replace(/\s+/g, ' ') : undefined;
}

export class ConductorSignIn implements ConductorSignInControl {
  private readonly opts: ConductorSignInOptions;
  private readonly log: (message: string) => void;
  /** Connects and sign-outs run one at a time, in order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: ConductorSignInOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => undefined);
  }

  connect(rawKey: unknown): Promise<SignInResult> {
    return this.serialize(() => this.runConnect(rawKey));
  }

  disconnect(): Promise<SignInResult> {
    return this.serialize(() => this.runDisconnect());
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runConnect(rawKey: unknown): Promise<SignInResult> {
    const candidates = apiKeyCandidates(rawKey);
    if (candidates.length === 0) throw new SignInError(KEY_INVALID_MESSAGE);
    const refusal = this.opts.refusal();
    if (refusal) throw new SignInError(refusal);
    const envName = envKeyName(this.opts.env);
    if (envName) {
      // The environment comes first, so a saved key would never be used.
      throw new SignInError(
        `This office signs in with ${envName} from its environment. Change it there, then restart Poke Agents.`,
      );
    }
    const baseUrl = resolveBaseUrl(this.opts.env);
    const { key, me } = await this.firstAccepted(baseUrl, candidates);
    if (typeof rawKey === 'string' && key !== rawKey.trim()) {
      this.log('the pasted key was one key twice; connected with a single copy');
    }
    const stored = await this.opts.keyStore.save(baseUrl, key);
    const fellBack = stored === 'session' && this.opts.keyStore.storage === 'keychain';
    this.log(
      stored === 'app'
        ? 'connected with a key from the office, saved in the Keychain'
        : `connected with a key from the office, kept in memory until the office stops${fellBack ? ' (the Keychain refused it)' : ''}`,
    );
    // The key is known good: the reply need not wait long for the poller.
    await this.opts.restart(CONNECT_SETTLE_TIMEOUT_MS);
    const account = accountName(me);
    const connected = account ? `Connected as ${account}` : 'Connected to Conductor';
    // The note goes on its own line: the office titles itself with the first.
    return {
      message: fellBack ? `${connected}\n${KEYCHAIN_SAVE_FAILED_NOTE}` : connected,
      account,
    };
  }

  /**
   * The first candidate Conductor accepts (GET /me), and its account. Only a
   * rejection moves on to the next one (a key pasted twice tries one copy,
   * then the text as pasted); an unreachable Conductor stops at once.
   */
  private async firstAccepted(
    baseUrl: string,
    candidates: string[],
  ): Promise<{ key: string; me: ConductorMe }> {
    for (const key of candidates) {
      try {
        const me = await verifyConductorKey(
          baseUrl,
          key,
          this.opts.fetchImpl ?? fetch,
          this.opts.timeoutMs,
        );
        return { key, me };
      } catch (err) {
        if (!(err instanceof KeyRejectedError)) throw err;
      }
    }
    throw new KeyRejectedError();
  }

  private async runDisconnect(): Promise<SignInResult> {
    const refusal = this.opts.refusal();
    if (refusal) throw new SignInError(refusal);
    const baseUrl = resolveBaseUrl(this.opts.env);
    let removed: boolean;
    try {
      removed = await this.opts.keyStore.remove(baseUrl);
    } catch {
      throw new SignInError(KEYCHAIN_REMOVE_FAILED_MESSAGE);
    }
    if (removed) this.log('signed out: forgot the key saved in Poke Agents');
    const next = await this.opts.restart();
    return { message: signOutMessage(removed, next, envKeyName(this.opts.env)) };
  }
}

/** What signing out did, and what still signs the office in. */
export function signOutMessage(
  removed: boolean,
  next: ConductorAuthSource | undefined,
  envName: string | undefined,
): string {
  const done = removed ? 'Signed out.' : 'Poke Agents had no saved key.';
  if (next === 'cli') return `${done} Still signed in through the Conductor CLI.`;
  if (next === 'env')
    return `${done} ${envName ?? 'An environment variable'} still signs this office in.`;
  return done;
}
