/**
 * Shared harness for the Conductor provider tests: a fake API, a manual clock
 * and a sink that records what the provider pushed. Nothing reaches the network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach } from 'vitest';

import type { ConductorSessionSummary } from '../../../../core/src/messages.js';
import type {
  AgentEvent,
  AgentEventSink,
  AgentLinkEvent,
  StreamProviderStatus,
  StreamSessionInfo,
} from '../../../../core/src/provider.js';
import type { ClientClock } from '../../../src/providers/stream/conductor/client.js';
import {
  type ConductorProvider,
  createConductorProvider,
} from '../../../src/providers/stream/conductor/conductor.js';
import type { ConductorItem } from '../../../src/providers/stream/conductor/types.js';
import { FakeConductorApi } from './fakeConductorApi.js';

export const FIXTURES = __dirname;
export const KEY = 'test-api-key-not-real';
export const NOW = Date.parse('2026-01-01T12:05:10.000Z');
export const readme = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'README.json'), 'utf-8')) as {
  sessions: Record<string, string>;
  workspaces: Record<string, string>;
};
export const ORCH = readme.sessions.S_ORCH;
export const CHILD = readme.sessions.S_CHILD;
export const WS_ORCH = readme.workspaces.WS_ORCH;
export const WS_CHILD = readme.workspaces.WS_CHILD;

export function fixture(name: string): ConductorItem[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8')) as ConductorItem[];
}

/** Copy a fixture feed into another session, shifted so its last item lands at `endMs`. */
export function retime(items: ConductorItem[], sessionId: string, endMs: number): ConductorItem[] {
  const last = Date.parse(items[items.length - 1].receivedAt);
  return items.map((item) => ({
    ...structuredClone(item),
    id: `${sessionId.slice(0, 8)}-${item.id}`,
    sessionId,
    receivedAt: new Date(endMs - (last - Date.parse(item.receivedAt))).toISOString(),
  }));
}

export const idleFeed = (id: string, endMs: number) =>
  retime(fixture('claude-turn.json'), id, endMs);
/** Claude turn cut right after the Bash tool_use: active with one tool open. */
export const workingFeed = (id: string, endMs: number) =>
  retime(fixture('claude-turn.json').slice(0, 8), id, endMs);

export function uuid(n: number): string {
  return `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export class RecordingSink implements AgentEventSink {
  upserts: StreamSessionInfo[] = [];
  events: Array<[string, AgentEvent]> = [];
  links: AgentLinkEvent[] = [];
  removed: Array<[string, string | undefined]> = [];
  statuses: StreamProviderStatus[] = [];
  lists: ConductorSessionSummary[][] = [];
  adopted = new Set<string>();
  /** Upserts and links in arrival order (`upsert:<id>`, `link:<kind>:<from>><to>`). */
  order: string[] = [];

  upsertSession(info: StreamSessionInfo): void {
    this.upserts.push(structuredClone(info));
    this.adopted.add(info.sessionId);
    this.order.push(`upsert:${info.sessionId}`);
  }
  emit(sessionId: string, event: AgentEvent): void {
    this.events.push([sessionId, event]);
  }
  link(event: AgentLinkEvent): void {
    this.links.push(event);
    this.order.push(`link:${event.kind}:${event.fromSessionId}>${event.toSessionId}`);
  }
  removeSession(sessionId: string, reason?: string): void {
    this.removed.push([sessionId, reason]);
    this.adopted.delete(sessionId);
  }
  setStatus(status: StreamProviderStatus): void {
    this.statuses.push(status);
  }
  sessionsChanged(sessions: ConductorSessionSummary[]): void {
    this.lists.push(sessions);
  }

  firstUpsert(id: string) {
    return this.upserts.find((u) => u.sessionId === id);
  }
  lastUpsert(id: string) {
    return [...this.upserts].reverse().find((u) => u.sessionId === id);
  }
  eventsFor(id: string): AgentEvent[] {
    return this.events.filter(([sid]) => sid === id).map(([, e]) => e);
  }
  lastStatus(): StreamProviderStatus | undefined {
    return this.statuses.at(-1);
  }
}

export function manualClock(start: number): ClientClock & { t: number } {
  const clock = {
    t: start,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
    random: () => 0.5,
  };
  return clock;
}

export const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

export function tmpStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-poller-'));
  tmpDirs.push(dir);
  return dir;
}

export function writeState(dir: string, data: unknown): void {
  fs.writeFileSync(path.join(dir, 'conductor-state.json'), JSON.stringify(data));
}

export interface Harness {
  clock: ClientClock & { t: number };
  api: FakeConductorApi;
  sink: RecordingSink;
  provider: ConductorProvider;
  stateDir: string;
  logs: string[];
}

export async function settle(provider: ConductorProvider, rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await provider.tick();
}

export async function boot(opts: {
  prepare: (api: FakeConductorApi, clock: { t: number }) => void;
  stateDir?: string;
  budget?: number;
  clock?: ClientClock & { t: number };
  api?: FakeConductorApi;
  sink?: RecordingSink;
}): Promise<Harness> {
  const clock = opts.clock ?? manualClock(NOW);
  const api = opts.api ?? new FakeConductorApi(() => clock.t);
  opts.prepare(api, clock);
  const sink = opts.sink ?? new RecordingSink();
  const stateDir = opts.stateDir ?? tmpStateDir();
  const logs: string[] = [];
  const provider = createConductorProvider({
    fetchImpl: api.fetch,
    env: { CONDUCTOR_API_KEY: KEY },
    stateDir,
    clock,
    autoTick: false,
    platform: 'linux',
    budgetPerMinute: opts.budget ?? 60_000,
    log: (m) => logs.push(m),
  });
  await provider.start(sink);
  await settle(provider);
  return { clock, api, sink, provider, stateDir, logs };
}
