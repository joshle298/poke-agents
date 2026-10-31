import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ConductorSessionSummary } from '../../core/src/messages.js';
import type {
  AgentEvent,
  AgentEventSink,
  AgentLinkEvent,
  StreamProviderStatus,
  StreamSessionInfo,
} from '../../core/src/provider.js';
import type { ClientClock } from '../src/providers/stream/conductor/client.js';
import {
  type ConductorProvider,
  createConductorProvider,
} from '../src/providers/stream/conductor/conductor.js';
import { planIntervals } from '../src/providers/stream/conductor/poller.js';
import type { ConductorItem } from '../src/providers/stream/conductor/types.js';
import { FakeConductorApi, ME } from './fixtures/conductor/fakeConductorApi.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'conductor');
const KEY = 'test-api-key-not-real';
const NOW = Date.parse('2026-01-01T12:05:10.000Z');
const readme = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'README.json'), 'utf-8')) as {
  sessions: Record<string, string>;
  workspaces: Record<string, string>;
};
const ORCH = readme.sessions.S_ORCH;
const CHILD = readme.sessions.S_CHILD;
const WS_ORCH = readme.workspaces.WS_ORCH;
const WS_CHILD = readme.workspaces.WS_CHILD;

function fixture(name: string): ConductorItem[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8')) as ConductorItem[];
}

/** Copy a fixture feed into another session, shifted so its last item lands at `endMs`. */
function retime(items: ConductorItem[], sessionId: string, endMs: number): ConductorItem[] {
  const last = Date.parse(items[items.length - 1].receivedAt);
  return items.map((item) => ({
    ...structuredClone(item),
    id: `${sessionId.slice(0, 8)}-${item.id}`,
    sessionId,
    receivedAt: new Date(endMs - (last - Date.parse(item.receivedAt))).toISOString(),
  }));
}

const idleFeed = (id: string, endMs: number) => retime(fixture('claude-turn.json'), id, endMs);
/** Claude turn cut right after the Bash tool_use: active with one tool open. */
const workingFeed = (id: string, endMs: number) =>
  retime(fixture('claude-turn.json').slice(0, 8), id, endMs);

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

class RecordingSink implements AgentEventSink {
  upserts: StreamSessionInfo[] = [];
  events: Array<[string, AgentEvent]> = [];
  links: AgentLinkEvent[] = [];
  removed: Array<[string, string | undefined]> = [];
  statuses: StreamProviderStatus[] = [];
  lists: ConductorSessionSummary[][] = [];
  adopted = new Set<string>();

  upsertSession(info: StreamSessionInfo): void {
    this.upserts.push(structuredClone(info));
    this.adopted.add(info.sessionId);
  }
  emit(sessionId: string, event: AgentEvent): void {
    this.events.push([sessionId, event]);
  }
  link(event: AgentLinkEvent): void {
    this.links.push(event);
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

function manualClock(start: number): ClientClock & { t: number } {
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

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-poller-'));
  tmpDirs.push(dir);
  return dir;
}

function writeState(dir: string, data: unknown): void {
  fs.writeFileSync(path.join(dir, 'conductor-state.json'), JSON.stringify(data));
}

interface Harness {
  clock: ClientClock & { t: number };
  api: FakeConductorApi;
  sink: RecordingSink;
  provider: ConductorProvider;
  stateDir: string;
  logs: string[];
}

async function settle(provider: ConductorProvider, rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await provider.tick();
}

async function boot(opts: {
  prepare: (api: FakeConductorApi, clock: { t: number }) => void;
  stateDir?: string;
  budget?: number;
  clock?: ClientClock & { t: number };
  api?: FakeConductorApi;
}): Promise<Harness> {
  const clock = opts.clock ?? manualClock(NOW);
  const api = opts.api ?? new FakeConductorApi(() => clock.t);
  opts.prepare(api, clock);
  const sink = new RecordingSink();
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

/** Orchestrator (working) + its child (idle), plus sessions that must stay out. */
function orchestration(api: FakeConductorApi): void {
  api.addWorkspace({
    id: WS_ORCH,
    name: 'Orchestration',
    number: 101,
    lastActivityAt: '2026-01-01T12:05:00.500Z',
  });
  api.addWorkspace({
    id: WS_CHILD,
    name: 'Worker A',
    number: 102,
    state: 'sleeping',
    lastActivityAt: '2026-01-01T12:01:04.000Z',
  });
  api.addSession({
    id: ORCH,
    workspaceId: WS_ORCH,
    name: 'Orchestrator',
    items: fixture('orchestrator-spawn-claude.json'),
    status: { status: 'working' },
  });
  api.addSession({
    id: CHILD,
    workspaceId: WS_CHILD,
    name: 'Worker A',
    model: 'gpt-6.1-sol',
    resolvedModel: 'gpt-6.1-sol',
    items: fixture('child-first-message.json'),
  });
  api.addSession({
    id: uuid(0xa1),
    workspaceId: WS_ORCH,
    name: null,
    model: null,
    resolvedModel: null,
  });
  api.addSession({
    id: uuid(0xa2),
    workspaceId: WS_ORCH,
    name: 'Old chat',
    archivedAt: '2026-01-01T11:59:00.000Z',
    items: idleFeed(uuid(0xa2), NOW - 600_000),
  });
  const team = uuid(0xb1);
  api.addWorkspace({ id: team, creatorId: uuid(0xfeed2), creatorName: 'Teammate' });
  api.addSession({
    id: uuid(0xb2),
    workspaceId: team,
    name: 'Teammate work',
    items: idleFeed(uuid(0xb2), NOW - 30_000),
  });
  const old = uuid(0xc1);
  api.addWorkspace({ id: old, lastActivityAt: new Date(NOW - 8 * 3_600_000).toISOString() });
  api.addSession({
    id: uuid(0xc2),
    workspaceId: old,
    name: 'Yesterday',
    items: idleFeed(uuid(0xc2), NOW - 8 * 3_600_000),
  });
}

describe('Conductor provider startup', () => {
  it('adopts in-scope sessions with their state, details, lead and links; ignores the rest', async () => {
    const { sink, api, provider } = await boot({ prepare: orchestration });
    expect([...sink.adopted].sort()).toEqual([ORCH, CHILD].sort());

    const orch = sink.firstUpsert(ORCH);
    expect(orch).toMatchObject({
      sessionId: ORCH,
      label: 'Orchestrator',
      directoryName: 'example-repo',
      initialStatus: 'active',
      details: {
        harness: 'claude',
        model: 'claude-opus-5-5[1m]',
        repo: 'example-org/example-repo',
        workspaceId: WS_ORCH,
        workspaceName: 'Orchestration',
        workspaceNumber: 101,
        creatorName: 'Example User',
        messageCount: 15,
        externalUrl: `conductor://workspace?id=${WS_ORCH}&session=${ORCH}`,
      },
    });
    expect(sink.firstUpsert(CHILD)).toMatchObject({
      initialStatus: 'waiting',
      details: { harness: 'codex' },
    });
    expect(sink.lastUpsert(CHILD)?.leadSessionId).toBe(ORCH);

    // The orchestrator's gauge is seeded from its last main-chain usage.
    expect(sink.eventsFor(ORCH)).toContainEqual({
      kind: 'contextUsage',
      tokens: 2 + 100 + 80_500 + 20,
      model: 'claude-opus-5-5[1m]',
      window: 1_000_000,
    });

    const links = sink.links.map(
      (l) =>
        `${l.kind}:${l.fromSessionId === ORCH ? 'O' : 'C'}>${l.toSessionId === ORCH ? 'O' : 'C'}`,
    );
    expect(links.sort()).toEqual(['messaged:C>O', 'messaged:O>C', 'spawned:O>C', 'watched:O>C']);
    expect(sink.links.every((l) => !l.live)).toBe(true);

    expect(sink.lastStatus()).toMatchObject({
      state: 'connected',
      account: 'user@example.com',
      workspaceCount: 2,
      visibleCount: 2,
      scope: { creator: 'me', activeWithinHours: 6, showIdle: true, maxSessions: 24 },
    });
    // Never-started sessions are never polled; archived ones never adopted.
    expect(api.callsTo(`/sessions/${uuid(0xa1)}`)).toEqual([]);
    expect(sink.adopted.has(uuid(0xa2))).toBe(false);
    // Discovery asked only for my workspaces in the 6 h window.
    const discovery = api.calls.find((c) => c.path === '/v0/workspaces');
    expect(discovery?.query).toMatchObject({ creator: ME.userId, limit: '100' });
    expect(Date.parse(discovery?.query.since ?? '')).toBe(NOW - 6 * 3_600_000);
    await provider.stop();
  });

  it('onboards pinned first, then working, then by recent activity', async () => {
    const stateDir = tmpStateDir();
    const [pinned, working, recent] = [uuid(0x101), uuid(0x102), uuid(0x103)];
    writeState(stateDir, {
      version: 1,
      scope: { creator: 'me', activeWithinHours: 6, showIdle: true, maxSessions: 24 },
      sessions: { [pinned]: { pinned: true } },
    });
    const { api, sink, provider } = await boot({
      stateDir,
      prepare: (a) => {
        a.addWorkspace({
          id: uuid(0x201),
          lastActivityAt: new Date(NOW - 50 * 60_000).toISOString(),
        });
        a.addWorkspace({
          id: uuid(0x202),
          lastActivityAt: new Date(NOW - 20 * 60_000).toISOString(),
        });
        a.addWorkspace({ id: uuid(0x203), lastActivityAt: new Date(NOW - 60_000).toISOString() });
        a.addSession({
          id: recent,
          workspaceId: uuid(0x203),
          items: idleFeed(recent, NOW - 60_000),
        });
        a.addSession({
          id: working,
          workspaceId: uuid(0x202),
          items: workingFeed(working, NOW - 20 * 60_000),
          status: { status: 'working' },
        });
        a.addSession({
          id: pinned,
          workspaceId: uuid(0x201),
          items: idleFeed(pinned, NOW - 50 * 60_000),
        });
      },
    });
    const statusOrder = api.calls
      .filter((c) => c.path.endsWith('/status'))
      .map((c) => c.path.split('/')[3]);
    expect(statusOrder.slice(0, 3)).toEqual([pinned, recent, working]);
    const probeOrder = api.calls
      .filter(
        (c) => c.path.endsWith('/messages') && c.query.offset === '0' && c.query.limit === '1',
      )
      .map((c) => c.path.split('/')[3]);
    expect(probeOrder.slice(0, 3)).toEqual([pinned, working, recent]);
    expect(sink.adopted.size).toBe(3);
    await provider.stop();
  });

  it('reports authRequired without a token and never touches the network', async () => {
    const api = new FakeConductorApi(() => NOW);
    const sink = new RecordingSink();
    const provider = createConductorProvider({
      fetchImpl: api.fetch,
      env: {},
      platform: 'linux',
      stateDir: tmpStateDir(),
      autoTick: false,
    });
    await provider.start(sink);
    expect(sink.lastStatus()).toMatchObject({
      state: 'authRequired',
      message: 'Sign in with `conductor auth login` or set CONDUCTOR_API_KEY, then restart.',
    });
    expect(api.calls).toEqual([]);
  });

  it('reports unauthorized on a rejected key, and never logs the key', async () => {
    const clock = manualClock(NOW);
    const api = new FakeConductorApi(() => clock.t);
    api.override(
      (c) => c.path === '/me',
      () => new Response('{"userMessage":"bad key"}', { status: 401 }),
    );
    const { sink, logs } = await boot({ clock, api, prepare: () => {} });
    expect(sink.lastStatus()?.state).toBe('unauthorized');
    expect(logs.join('\n')).not.toContain(KEY);
    expect(api.calls.map((c) => c.path)).toEqual(['/me']);
  });
});

describe('Conductor provider polling', () => {
  it('re-probes the tail when the cursor 404s', async () => {
    const h = await boot({ prepare: orchestration });
    const before = h.api.calls.length;
    const linksBefore = h.sink.links.length;
    h.api.override(
      (c) => c.path === `/v0/sessions/${CHILD}/messages` && c.query.after !== undefined,
      () =>
        new Response(
          JSON.stringify({
            userMessage: 'Cursor message not found in this session',
            code: 'NOT_FOUND',
          }),
          {
            status: 404,
          },
        ),
    );
    h.provider.setFocus([CHILD]);
    h.clock.t += 3_000;
    await settle(h.provider, 2);
    const after = h.api.calls
      .slice(before)
      .filter((c) => c.path === `/v0/sessions/${CHILD}/messages`);
    expect(after[0].query.after).toBeDefined();
    const probes = after.slice(1).filter((c) => c.query.limit === '1');
    expect(probes.length).toBeGreaterThan(0);
    expect(after.some((c) => c.query.offset !== undefined && c.query.limit === '100')).toBe(true);
    expect(h.logs.some((l) => l.includes('re-probing'))).toBe(true);
    // The replay is silent: no duplicate links.
    expect(h.sink.links.length).toBe(linksBefore);
    await h.provider.stop();
  });

  it('honours retry-after on a general 429 and shows rateLimited until it passes', async () => {
    const h = await boot({ prepare: orchestration });
    h.clock.t += 16_000;
    const at429 = h.clock.t;
    h.api.override(
      (c) => c.path === '/v0/workspaces',
      () =>
        new Response(
          JSON.stringify({
            userMessage: 'Rate limit exceeded for API requests. Retry after 9 seconds.',
            code: 'RATE_LIMITED',
          }),
          { status: 429, headers: { 'retry-after': '9' } },
        ),
    );
    await h.provider.tick();
    expect(h.sink.statuses.some((s) => s.state === 'rateLimited')).toBe(true);
    // Requests issued once the 429 has been handled wait for retry-after (+ jitter).
    const handled = h.api.calls.length;
    h.provider.setFocus([ORCH]);
    await h.provider.tick();
    const later = h.api.calls.slice(handled);
    expect(later.length).toBeGreaterThan(0);
    expect(Math.min(...later.map((c) => c.at))).toBeGreaterThanOrEqual(at429 + 9_000);
    await h.provider.tick();
    expect(h.sink.lastStatus()?.state).toBe('connected');
    await h.provider.stop();
  });

  it('a resumed cursor after downtime emits no live links; steady polls do', async () => {
    const stateDir = tmpStateDir();
    const feed = fixture('orchestrator-spawn-claude.json');
    // The child's report and the wake arrived during the downtime, seconds ago.
    feed[13].receivedAt = new Date(NOW - 5_000).toISOString();
    feed[14].receivedAt = new Date(NOW - 4_500).toISOString();
    writeState(stateDir, {
      version: 1,
      scope: { creator: 'me', activeWithinHours: 6, showIdle: true, maxSessions: 24 },
      sessions: {
        [ORCH]: {
          cursor: { lastId: feed[12].id, lastIndex: 13 },
          firstSender: null,
          harness: 'claude',
        },
      },
    });
    const h = await boot({
      stateDir,
      prepare: (api) => {
        orchestration(api);
        const orch = api.sessions.get(ORCH);
        if (orch) orch.items = feed;
      },
    });
    expect(h.sink.links.length).toBeGreaterThan(0);
    expect(h.sink.links.filter((l) => l.live)).toEqual([]);
    expect(h.sink.links).toContainEqual(
      expect.objectContaining({
        kind: 'messaged',
        fromSessionId: CHILD,
        toSessionId: ORCH,
        live: false,
      }),
    );

    // A new report arrives while we poll steadily: that one animates.
    h.clock.t += 3_000;
    const report = structuredClone(feed[13]);
    report.id = 'live-report-item';
    report.sessionIndex = 16;
    report.content.id = '3e553e55-0000-4000-8000-0000000000aa';
    report.receivedAt = new Date(h.clock.t - 1_000).toISOString();
    h.api.sessions.get(ORCH)?.items.push(report);
    await settle(h.provider, 2);
    const live = h.sink.links.filter((l) => l.live);
    expect(live).toEqual([
      expect.objectContaining({ kind: 'messaged', fromSessionId: CHILD, toSessionId: ORCH }),
    ]);
    await h.provider.stop();
  });

  it('seeds a session whose only item is a queued first message as active', async () => {
    const id = uuid(0x301);
    const h = await boot({
      prepare: (api) => {
        api.addWorkspace({ id: uuid(0x302), lastActivityAt: new Date(NOW - 2_000).toISOString() });
        api.addSession({
          id,
          workspaceId: uuid(0x302),
          name: 'Fresh',
          items: [
            {
              id: 'queued-1',
              sessionId: id,
              sessionIndex: 1,
              type: 'userMessage',
              content: {
                id: uuid(0x303),
                message: 'Start the task.',
                state: 'queued',
                turnId: uuid(0x303),
              },
              receivedAt: new Date(NOW - 2_000).toISOString(),
            },
          ],
        });
      },
    });
    expect(h.sink.firstUpsert(id)?.initialStatus).toBe('active');
    // /status still says idle while the message waits: not forced to Done.
    h.clock.t += 31_000;
    await settle(h.provider, 3);
    expect(h.sink.eventsFor(id).filter((e) => e.kind === 'turnEnd')).toEqual([]);
    await h.provider.stop();
  });

  it('reconciles a turn the feed never closed when /status says idle', async () => {
    const id = uuid(0x401);
    const items = retime(fixture('codex-turn.json').slice(0, 19), id, NOW - 20_000);
    const h = await boot({
      prepare: (api) => {
        api.addWorkspace({ id: uuid(0x402), lastActivityAt: new Date(NOW - 20_000).toISOString() });
        api.addSession({
          id,
          workspaceId: uuid(0x402),
          model: 'gpt-6.1-sol',
          resolvedModel: 'gpt-6.1-sol',
          items,
        });
      },
    });
    expect(h.sink.firstUpsert(id)?.initialStatus).toBe('active');
    h.clock.t += 31_000;
    await settle(h.provider, 3);
    expect(h.sink.eventsFor(id)).toContainEqual({ kind: 'turnEnd', outcome: 'done' });
    await h.provider.stop();
  });

  it('plans slower intervals when demand exceeds the budget', () => {
    const light = planIntervals(120, {
      focus: 1,
      hot: 2,
      warm: 2,
      offscreen: 0,
      activeWorkspaces: 3,
    });
    expect(light).toMatchObject({ focusMs: 2_000, hotMs: 2_500, warmMs: 15_000, statusMs: 30_000 });
    const heavy = planIntervals(120, {
      focus: 1,
      hot: 20,
      warm: 10,
      offscreen: 5,
      activeWorkspaces: 10,
    });
    expect(heavy.warmMs).toBe(30_000);
    expect(heavy.statusMs).toBe(60_000);
    expect(heavy.hotMs).toBeGreaterThan(2_500);
    const perMinute =
      60_000 / 15_000 +
      10 +
      60_000 / heavy.focusMs +
      (21 * 60_000) / heavy.statusMs +
      (20 * 60_000) / heavy.hotMs +
      (10 * 60_000) / heavy.warmMs +
      (5 * 60_000) / heavy.offscreenMs;
    expect(perMinute).toBeLessThanOrEqual(120);
  });
});

describe('Conductor provider scope and visibility', () => {
  it('filters by creator and activity window, and re-filters when the scope changes', async () => {
    const h = await boot({ prepare: orchestration });
    expect(h.sink.adopted.has(uuid(0xb2))).toBe(false);
    expect(h.sink.adopted.has(uuid(0xc2))).toBe(false);
    h.provider.setScope({ creator: 'all', activeWithinHours: 12, showIdle: true, maxSessions: 24 });
    await settle(h.provider);
    expect(h.sink.adopted.has(uuid(0xb2))).toBe(true);
    expect(h.sink.adopted.has(uuid(0xc2))).toBe(true);
    expect(h.sink.lastStatus()?.scope).toEqual({
      creator: 'all',
      activeWithinHours: 12,
      showIdle: true,
      maxSessions: 24,
    });

    h.provider.setScope({
      creator: 'all',
      activeWithinHours: 12,
      showIdle: false,
      maxSessions: 24,
    });
    expect(h.sink.adopted.has(CHILD)).toBe(false);
    expect(h.sink.adopted.has(ORCH)).toBe(true);
    expect(h.sink.removed).toContainEqual([CHILD, 'scope']);
    // Persisted for the next run.
    await h.provider.stop();
    const saved = JSON.parse(
      fs.readFileSync(path.join(h.stateDir, 'conductor-state.json'), 'utf-8'),
    );
    expect(saved.scope).toEqual({
      creator: 'all',
      activeWithinHours: 12,
      showIdle: false,
      maxSessions: 24,
    });
  });

  it('fills the cap in order: pinned, needs-you, working, errored, then recent', async () => {
    const stateDir = tmpStateDir();
    const [pinned, waiting, working, errored, idle] = [
      uuid(0x501),
      uuid(0x502),
      uuid(0x503),
      uuid(0x504),
      uuid(0x505),
    ];
    writeState(stateDir, {
      version: 1,
      scope: { creator: 'me', activeWithinHours: 6, showIdle: true, maxSessions: 4 },
      sessions: { [pinned]: { pinned: true } },
    });
    const h = await boot({
      stateDir,
      prepare: (api) => {
        const add = (id: string, items: ConductorItem[], n: number) => {
          api.addWorkspace({ id: uuid(0x600 + n), lastActivityAt: items.at(-1)?.receivedAt });
          api.addSession({ id, workspaceId: uuid(0x600 + n), items });
        };
        add(pinned, idleFeed(pinned, NOW - 3 * 3_600_000), 1);
        add(idle, idleFeed(idle, NOW - 10_000), 2);
        add(errored, retime(fixture('error-claude-usage-limit.json'), errored, NOW - 600_000), 3);
        add(working, workingFeed(working, NOW - 900_000), 4);
        add(
          waiting,
          retime(fixture('wait-ask-user-question-pending.json'), waiting, NOW - 1_200_000),
          5,
        );
      },
    });
    expect([...h.sink.adopted].sort()).toEqual([pinned, waiting, working, errored].sort());
    expect(h.sink.firstUpsert(errored)).toMatchObject({
      initialStatus: 'error',
      errorMessage: "You've hit your session limit · resets 1:00pm (UTC)",
    });
    expect(h.sink.eventsFor(waiting)).toContainEqual({ kind: 'awaitingInput' });
    await h.provider.stop();
  });

  it('keeps a shown session until it falls 4 places past the cap', async () => {
    const stateDir = tmpStateDir();
    writeState(stateDir, {
      version: 1,
      scope: { creator: 'me', activeWithinHours: 6, showIdle: true, maxSessions: 2 },
      sessions: {},
    });
    const [x, y] = [uuid(0x701), uuid(0x702)];
    const h = await boot({
      stateDir,
      prepare: (api) => {
        api.addWorkspace({ id: uuid(0x711), lastActivityAt: new Date(NOW - 60_000).toISOString() });
        api.addWorkspace({
          id: uuid(0x712),
          lastActivityAt: new Date(NOW - 120_000).toISOString(),
        });
        api.addSession({ id: x, workspaceId: uuid(0x711), items: idleFeed(x, NOW - 60_000) });
        api.addSession({ id: y, workspaceId: uuid(0x712), items: idleFeed(y, NOW - 120_000) });
      },
    });
    expect([...h.sink.adopted].sort()).toEqual([x, y].sort());

    const addWorking = (n: number) => {
      const id = uuid(0x720 + n);
      h.api.addWorkspace({
        id: uuid(0x740 + n),
        lastActivityAt: new Date(h.clock.t).toISOString(),
      });
      h.api.addSession({
        id,
        workspaceId: uuid(0x740 + n),
        items: workingFeed(id, h.clock.t),
        status: { status: 'working' },
      });
      return id;
    };
    const z = [addWorking(1), addWorking(2), addWorking(3)];
    h.clock.t += 16_000;
    await settle(h.provider);
    // Ranks: z1 z2 z3 (working), x, y. Cap 2: z1, z2 shown; x and y stay (3 and 4 < 2 + 4).
    expect(h.sink.adopted.has(z[0]) && h.sink.adopted.has(z[1])).toBe(true);
    expect(h.sink.adopted.has(z[2])).toBe(false);
    expect(h.sink.adopted.has(x) && h.sink.adopted.has(y)).toBe(true);

    z.push(addWorking(4), addWorking(5));
    h.clock.t += 16_000;
    await settle(h.provider);
    // Now x is 6th (index 5 < 6) and stays, y is 7th and leaves.
    expect(h.sink.adopted.has(x)).toBe(true);
    expect(h.sink.adopted.has(y)).toBe(false);
    expect(h.sink.removed).toContainEqual([y, 'scope']);
    await h.provider.stop();
  });

  it('shows at most 12 children per Lead', async () => {
    const h = await boot({
      prepare: (api) => {
        orchestration(api);
        for (let i = 0; i < 13; i++) {
          const id = uuid(0x800 + i);
          const ws = uuid(0x900 + i);
          const items = idleFeed(id, NOW - 30_000 - i * 1_000);
          items[0].content.senderSessionId = ORCH;
          api.addWorkspace({ id: ws, lastActivityAt: items.at(-1)?.receivedAt });
          api.addSession({ id, workspaceId: ws, items });
        }
      },
    });
    const children = [...h.sink.adopted].filter((id) => id.startsWith('00000'));
    expect(children).toHaveLength(12);
    expect(h.provider.listSessions().filter((s) => s.leadSessionId === ORCH)).toHaveLength(14);
    await h.provider.stop();
  });
});

describe('Conductor provider controls', () => {
  it('persists hidden and pinned (0600, no token) and honours them after a restart', async () => {
    const h = await boot({ prepare: orchestration });
    h.provider.setSessionHidden(CHILD, true);
    expect(h.sink.removed).toContainEqual([CHILD, 'hidden']);
    h.provider.setSessionPinned(ORCH, true);
    expect(h.provider.listSessions().find((s) => s.sessionId === CHILD)).toMatchObject({
      hidden: true,
    });
    expect(h.provider.listSessions().find((s) => s.sessionId === ORCH)).toMatchObject({
      pinned: true,
    });
    await h.provider.stop();

    const file = path.join(h.stateDir, 'conductor-state.json');
    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain('Worker A report');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(raw);
    expect(saved.version).toBe(1);
    expect(saved.sessions[CHILD]).toMatchObject({
      hidden: true,
      firstSender: ORCH,
      harness: 'codex',
    });
    expect(saved.sessions[ORCH]).toMatchObject({ pinned: true, firstSender: null });
    expect(saved.sessions[ORCH].cursor.lastIndex).toBe(15);

    const again = await boot({ stateDir: h.stateDir, prepare: orchestration });
    expect(again.sink.adopted.has(CHILD)).toBe(false);
    expect(again.sink.adopted.has(ORCH)).toBe(true);
    again.provider.onDismiss(ORCH);
    expect(again.sink.removed).toContainEqual([ORCH, 'hidden']);
    await again.provider.stop();
  });

  it('archives to the PC Box and restores back into the office (against the fake API)', async () => {
    const h = await boot({ prepare: orchestration });
    await h.provider.archiveSession(CHILD);
    expect(h.api.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      `/v0/sessions/${CHILD}/archive`,
    ]);
    expect(h.sink.removed).toContainEqual([CHILD, 'archived']);
    expect(h.provider.listSessions().find((s) => s.sessionId === CHILD)).toMatchObject({
      archived: true,
      archivedAt: expect.any(Number),
    });

    await h.provider.restoreSession(CHILD);
    await settle(h.provider);
    expect(h.api.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      `/v0/sessions/${CHILD}/archive`,
      `/v0/sessions/${CHILD}/unarchive`,
    ]);
    expect(h.sink.adopted.has(CHILD)).toBe(true);
    expect(h.provider.listSessions().find((s) => s.sessionId === CHILD)?.archived).toBeUndefined();
    await h.provider.stop();
  });

  it('sends messages with a fresh message id and stops sessions; failures read as short messages', async () => {
    const h = await boot({ prepare: orchestration });
    await h.provider.sendMessage(ORCH, ' continue ');
    await h.provider.stopSession(ORCH);
    const posts = h.api.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.path)).toEqual([
      `/v0/sessions/${ORCH}/messages`,
      `/v0/sessions/${ORCH}/cancel`,
    ]);
    expect(posts[0].body).toEqual({
      message: 'continue',
      messageId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    await expect(h.provider.sendMessage(uuid(0xdead), 'hi')).rejects.toThrow('Session not found');
    await h.provider.stop();
  });

  it('serves the Pokédex detail: prompt, peers with labels, and a cold tail on demand', async () => {
    const cold = uuid(0xc01);
    const h = await boot({
      prepare: (api) => {
        orchestration(api);
        api.addWorkspace({
          id: uuid(0xc02),
          state: 'sleeping',
          lastActivityAt: new Date(NOW - 3 * 3_600_000).toISOString(),
        });
        api.addSession({
          id: cold,
          workspaceId: uuid(0xc02),
          name: 'Cold one',
          items: idleFeed(cold, NOW - 3 * 3_600_000),
        });
      },
    });
    const detail = await h.provider.getSessionDetail(ORCH);
    expect(detail?.prompt).toBe('Split the review across two workers and report back.');
    expect(detail?.entries).toContainEqual(
      expect.objectContaining({
        role: 'peerIn',
        peerSessionId: CHILD,
        peerLabel: 'Worker A',
        text: 'Worker A report: review finished, 2 findings.',
      }),
    );
    expect(detail?.entries).toContainEqual(
      expect.objectContaining({
        role: 'peerOut',
        peerSessionId: CHILD,
        text: 'Also check the migration file.',
      }),
    );

    const messageCallsBefore = h.api.callsTo(`/sessions/${cold}/messages`).length;
    const coldDetail = await h.provider.getSessionDetail(cold);
    expect(h.api.callsTo(`/sessions/${cold}/messages`).length).toBeGreaterThan(messageCallsBefore);
    expect(coldDetail?.prompt).toBe('Rename the helper in example.ts and run the tests.');
    expect(coldDetail?.entries.map((e) => e.role)).toContain('assistant');
    await h.provider.stop();
  });

  it('ignores a named session that never started', async () => {
    const id = uuid(0xe01);
    const h = await boot({
      prepare: (api) => {
        api.addWorkspace({ id: uuid(0xe02) });
        api.addSession({
          id,
          workspaceId: uuid(0xe02),
          name: 'Never started',
          model: null,
          resolvedModel: null,
        });
      },
    });
    expect(h.sink.adopted.has(id)).toBe(false);
    expect(h.provider.listSessions()).toEqual([]);
    await h.provider.stop();
  });
});
