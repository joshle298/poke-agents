/**
 * One-time launch codes for `--open`.
 *
 * The office token is a long-lived bearer capability (Conductor writes, and a
 * shell with --claude). Handing the tokened URL to a browser on its command
 * line put it in that process's argv, readable by other local users for the
 * browser's lifetime. Instead the CLI asks the running server for a code
 * (POST /api/launch-code, Bearer token) and opens `/launch/<code>`; the server
 * redeems the code once and redirects the window to the tokened URL, so the
 * token travels only in an HTTP response to the browser that asked. A code
 * that was used or expired is worthless, so a leaked argv grants nothing.
 */

import * as crypto from 'crypto';

import { LAUNCH_CODE_BYTES, LAUNCH_CODE_MAX, LAUNCH_CODE_TTL_MS } from './constants.js';

/** Shape of a code as minted (base64url), checked before any lookup. */
const CODE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export class LaunchCodes {
  /** Unredeemed codes, oldest first, with their expiry (epoch ms). */
  private readonly codes = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** A fresh single-use code, valid for LAUNCH_CODE_TTL_MS. */
  mint(): string {
    this.prune();
    const code = crypto.randomBytes(LAUNCH_CODE_BYTES).toString('base64url');
    this.codes.set(code, this.now() + LAUNCH_CODE_TTL_MS);
    while (this.codes.size > LAUNCH_CODE_MAX) {
      const oldest = this.codes.keys().next().value;
      if (oldest === undefined) break;
      this.codes.delete(oldest);
    }
    return code;
  }

  /** True once for a valid unexpired code; the code is spent either way. */
  redeem(code: unknown): boolean {
    if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return false;
    const expiry = this.codes.get(code);
    this.codes.delete(code);
    return expiry !== undefined && this.now() <= expiry;
  }

  private prune(): void {
    const now = this.now();
    for (const [code, expiry] of this.codes) if (now > expiry) this.codes.delete(code);
  }
}
