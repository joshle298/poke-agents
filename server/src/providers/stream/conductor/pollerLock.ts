/**
 * One Conductor poller per machine: `~/.pixel-agents/conductor.lock`.
 *
 * Offices in different modes (`npm start`, then `poke-agents --claude`) do not
 * share a server, and each used to attach its own Conductor provider: two
 * request budgets against one account, and two copies of conductor-state.json
 * and standalone-state.json overwriting each other's hidden/pinned/scope
 * changes and agent ids. The first office to start takes the lock; a later one
 * runs without Conductor and says which office has it. A lock whose process is
 * gone is taken over.
 */

import * as fs from 'fs';
import * as path from 'path';

import { POLLER_LOCK_FILE_NAME, STATE_FILE_MODE } from './constants.js';

export interface PollerLockHolder {
  pid: number;
  port?: number;
}

export type PollerLock =
  { acquired: true; release(): void } | { acquired: false; holder: PollerLockHolder };

export interface PollerLockOptions {
  /** Directory of the lock file (~/.pixel-agents). */
  dir: string;
  /** The office this process serves, shown to a second office. */
  port?: number;
  /** Injected for tests. */
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(file: string): PollerLockHolder | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    if (!Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0) return null;
    return {
      pid: raw.pid as number,
      port: Number.isSafeInteger(raw.port) ? (raw.port as number) : undefined,
    };
  } catch {
    return null;
  }
}

export function acquirePollerLock(opts: PollerLockOptions): PollerLock {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? processAlive;
  const file = path.join(opts.dir, POLLER_LOCK_FILE_NAME);
  const body = JSON.stringify({ pid, port: opts.port });
  fs.mkdirSync(opts.dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx', mode: STATE_FILE_MODE });
      return {
        acquired: true,
        release: () => {
          if (readHolder(file)?.pid === pid) fs.rmSync(file, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = readHolder(file);
    if (holder && holder.pid !== pid && isAlive(holder.pid)) return { acquired: false, holder };
    // Ours from an earlier run, a dead process's, or unreadable: take it over.
    fs.rmSync(file, { force: true });
  }
  return { acquired: false, holder: readHolder(file) ?? { pid: 0 } };
}

/**
 * Who holds the lock, when a live process other than this one does; null when
 * it is free, ours, a dead process's or unreadable (acquirePollerLock would
 * take it). Takes nothing: a check that must not leave the lock held.
 */
export function pollerLockHolder(
  opts: Pick<PollerLockOptions, 'dir' | 'pid' | 'isAlive'>,
): PollerLockHolder | null {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? processAlive;
  const holder = readHolder(path.join(opts.dir, POLLER_LOCK_FILE_NAME));
  return holder && holder.pid !== pid && isAlive(holder.pid) ? holder : null;
}
