import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquirePollerLock } from '../src/providers/stream/conductor/pollerLock.js';

describe('Conductor poller lock (one poller per machine)', () => {
  let dir: string;
  const alive = new Set<number>();
  const isAlive = (pid: number) => alive.has(pid);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-lock-'));
    alive.clear();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('refuses a second office while the first is running, and says which one has it', () => {
    alive.add(100);
    const first = acquirePollerLock({ dir, pid: 100, port: 41510, isAlive });
    expect(first.acquired).toBe(true);

    const second = acquirePollerLock({ dir, pid: 200, port: 50123, isAlive });
    expect(second).toEqual({ acquired: false, holder: { pid: 100, port: 41510 } });
    expect(fs.statSync(path.join(dir, 'conductor.lock')).mode & 0o777).toBe(0o600);

    // Once the first one stops, the next office polls.
    if (first.acquired) first.release();
    expect(acquirePollerLock({ dir, pid: 200, isAlive }).acquired).toBe(true);
  });

  it('takes over a lock whose process is gone (a crash) or that is unreadable', () => {
    expect(acquirePollerLock({ dir, pid: 100, isAlive }).acquired).toBe(true);
    // PID 100 died without releasing.
    expect(acquirePollerLock({ dir, pid: 200, isAlive }).acquired).toBe(true);

    fs.writeFileSync(path.join(dir, 'conductor.lock'), 'not json');
    expect(acquirePollerLock({ dir, pid: 300, isAlive }).acquired).toBe(true);
  });

  it("never releases another office's lock", () => {
    alive.add(100).add(200);
    const first = acquirePollerLock({ dir, pid: 100, isAlive });
    const stale = acquirePollerLock({ dir, pid: 200, isAlive });
    expect(stale.acquired).toBe(false);
    // An office that lost the lock and then took it over from a dead holder
    // must not delete the live holder's file when it stops.
    alive.delete(100);
    const takeover = acquirePollerLock({ dir, pid: 200, isAlive });
    expect(takeover.acquired).toBe(true);
    if (first.acquired) first.release();
    expect(fs.existsSync(path.join(dir, 'conductor.lock'))).toBe(true);
  });
});
