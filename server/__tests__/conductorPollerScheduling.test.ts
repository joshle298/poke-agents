/**
 * What the Conductor poller spends its request budget on, and when sessions
 * walk in: focus, workspace activity, deferred units, ranking by a session's
 * own activity, restores from Archived sessions, levels, and catch-up batches.
 * Every scenario runs against the fake API with a manual clock.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { STREAM_TURN_MIN_ACTIVE_MS } from '../src/constants.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { createConductorProvider } from '../src/providers/stream/conductor/conductor.js';
import { planIntervals } from '../src/providers/stream/conductor/poller.js';
import type { ConductorItem } from '../src/providers/stream/conductor/types.js';
import { FakeConductorApi } from './fixtures/conductor/fakeConductorApi.js';
import {
  boot,
  fixture,
  type Harness,
  idleFeed,
  KEY,
  manualClock,
  NOW,
  RecordingSink,
  retime,
  settle,
  tmpStateDir,
  uuid,
  workingFeed,
  writeState,
} from './fixtures/conductor/pollerHarness.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function scope(maxSessions = 24) {
  return { creator: 'me', activeWithinHours: 6, showIdle: true, maxSessions };
}

/** `turns` copies of the Claude turn fixture (18 items, sessionIndex step 19),
 *  one minute apart, the last one ending at `endMs`. */
function longFeed(id: string, turns: number, endMs: number): ConductorItem[] {
  const turn = fixture('claude-turn.json');
  const items: ConductorItem[] = [];
  for (let k = 0; k < turns; k++) {
    const end = endMs - (turns - 1 - k) * MINUTE;
    for (const item of retime(turn, id, end)) {
      items.push({ ...item, id: `${item.id}-t${k}`, sessionIndex: k * 19 + item.sessionIndex });
    }
  }
  return items;
}

/** Advance the clock in ticks, calling `each` before every tick. */
async function run(
  h: Harness,
  ms: number,
  each: (t: number) => void = () => {},
  step = 500,
): Promise<void> {
  const until = h.clock.t + ms;
  while (h.clock.t < until) {
    h.clock.t += step;
    each(h.clock.t);
    await h.provider.tick();
  }
}

function messagePolls(api: FakeConductorApi, id: string, from = 0): number {
  return api.callsTo(`/sessions/${id}/messages`).filter((c) => c.at >= from && c.query.after)
    .length;
}

/** A sink that records which events arrived inside a silent seed. */
class SeedAwareSink extends RecordingSink {
  seeding = new Set<string>();
  seeded: Array<[string, AgentEvent]> = [];
  seedSilently(sessionId: string, runSeed: () => void): void {
    this.seeding.add(sessionId);
    try {
      runSeed();
    } finally {
      this.seeding.delete(sessionId);
    }
  }
  emit(sessionId: string, event: AgentEvent): void {
    super.emit(sessionId, event);
    if (this.seeding.has(sessionId)) this.seeded.push([sessionId, event]);
  }
}

describe('Conductor poller: focus (an open Pokédex)', () => {
  it('lapses about 10 s after the last request, instead of lasting until restart', async () => {
    const id = uuid(0x1001);
    const h = await boot({
      prepare: (api) => {
        api.addWorkspace({
          id: uuid(0x1002),
          state: 'sleeping',
          lastActivityAt: new Date(NOW - 2 * HOUR).toISOString(),
        });
        api.addSession({ id, workspaceId: uuid(0x1002), items: idleFeed(id, NOW - 2 * HOUR) });
      },
    });
    expect(h.sink.adopted.has(id)).toBe(true);

    // The Pokédex asks once and is closed.
    const opened = h.clock.t;
    h.provider.setFocus([id]);
    await run(h, 60_000);
    expect(messagePolls(h.api, id, opened)).toBeGreaterThan(0);
    // Cold again once the focus lapsed: no polls at all after it.
    expect(messagePolls(h.api, id, opened + 12_000)).toBe(0);
    await h.provider.stop();
  });

  it('keeps a focused Lead fast and never tails its old children for it', async () => {
    const lead = uuid(0x1101);
    const children = Array.from({ length: 20 }, (_, i) => uuid(0x1200 + i));
    const stateDir = tmpStateDir();
    writeState(stateDir, { version: 1, scope: scope(3), sessions: {} });
    const h = await boot({
      stateDir,
      budget: 120,
      prepare: (api) => {
        api.addWorkspace({ id: uuid(0x1102), lastActivityAt: new Date(NOW).toISOString() });
        api.addSession({
          id: lead,
          workspaceId: uuid(0x1102),
          items: workingFeed(lead, NOW - 1_000),
          status: { status: 'working' },
        });
        children.forEach((child, i) => {
          const items = idleFeed(child, NOW - 2 * HOUR - i * MINUTE);
          items[0].content.senderSessionId = lead;
          api.addWorkspace({
            id: uuid(0x1300 + i),
            state: 'sleeping',
            lastActivityAt: items.at(-1)?.receivedAt,
          });
          api.addSession({ id: child, workspaceId: uuid(0x1300 + i), items });
        });
      },
    });
    // Settle onboarding at 120/min.
    await run(h, 3 * MINUTE);

    const before = h.clock.t;
    await run(h, MINUTE);
    const unfocused = messagePolls(h.api, lead, before);

    const childCallsBefore = children.map((c) => h.api.callsTo(`/sessions/${c}/messages`).length);
    const focusedFrom = h.clock.t;
    await run(h, MINUTE, (t) => {
      if ((t - focusedFrom) % 5_000 === 0) h.provider.setFocus([lead]);
    });
    const focused = messagePolls(h.api, lead, focusedFrom);
    expect(unfocused).toBeGreaterThan(10);
    expect(focused).toBeGreaterThanOrEqual(unfocused);
    // Its old children are not dragged into Focus: none was read for it.
    const childCallsAfter = children.map((c) => h.api.callsTo(`/sessions/${c}/messages`).length);
    expect(childCallsAfter).toEqual(childCallsBefore);
    await h.provider.stop();
  });

  it('never plans a focused session slower than Hot', () => {
    for (const hot of [0, 2, 4, 10, 20, 40]) {
      for (const focus of [1, 2, 3]) {
        const plan = planIntervals(120, {
          focus,
          hot,
          warm: 6,
          offscreen: 0,
          activeWorkspaces: 6,
        });
        expect(plan.focusMs).toBeLessThanOrEqual(plan.hotMs);
      }
    }
  });
});

describe('Conductor poller: workspace activity', () => {
  it("polls a busy workspace's idle chats once a minute at most, without making them Hot", async () => {
    const ws = uuid(0x2001);
    const live = uuid(0x2002);
    const siblings = Array.from({ length: 9 }, (_, i) => uuid(0x2100 + i));
    const h = await boot({
      budget: 120,
      prepare: (api) => {
        api.addWorkspace({ id: ws, lastActivityAt: new Date(NOW).toISOString() });
        api.addSession({
          id: live,
          workspaceId: ws,
          items: workingFeed(live, NOW - 1_000),
          status: { status: 'working' },
        });
        for (const [i, sibling] of siblings.entries()) {
          api.addSession({
            id: sibling,
            workspaceId: ws,
            items: idleFeed(sibling, NOW - 2 * HOUR - i * MINUTE),
          });
        }
      },
    });
    await run(h, MINUTE);
    const from = h.clock.t;
    const workspace = h.api.workspaces.find((w) => w.id === ws);
    // The live session keeps working: the workspace's activity advances on
    // every discovery pass.
    await run(h, 2 * MINUTE, (t) => {
      if (workspace) workspace.lastActivityAt = new Date(t).toISOString();
    });
    const siblingPolls = siblings.reduce((n, s) => n + messagePolls(h.api, s, from), 0);
    expect(siblingPolls).toBeLessThanOrEqual(siblings.length * 3);
    // ...and the working session keeps its Hot cadence (about every 2.5-3 s).
    expect(messagePolls(h.api, live, from)).toBeGreaterThan(30);
    const lists = h.api.callsTo(`/workspaces/${ws}/sessions`).filter((c) => c.at >= from);
    expect(lists.length).toBeLessThanOrEqual(5);
    await h.provider.stop();
  });
});

describe('Conductor poller: workspace activity wakes a session known from a cursor', () => {
  it("reads the tail of an idle session that walked in on an earlier run's cursor", async () => {
    const id = uuid(0x2201);
    const ws = uuid(0x2202);
    const stateDir = tmpStateDir();
    writeState(stateDir, {
      version: 1,
      scope: scope(),
      sessions: { [id]: { cursor: { lastId: 'gone', lastIndex: 19 }, firstSender: null } },
    });
    const h = await boot({
      stateDir,
      prepare: (api) => {
        api.addWorkspace({
          id: ws,
          state: 'sleeping',
          lastActivityAt: new Date(NOW - 2 * HOUR).toISOString(),
        });
        api.addSession({ id, workspaceId: ws, items: idleFeed(id, NOW - 2 * HOUR) });
      },
    });
    expect(h.sink.adopted.has(id)).toBe(true);
    await run(h, 2 * MINUTE, () => {}, 5_000);
    const pagesBefore = h.api
      .callsTo(`/sessions/${id}/messages`)
      .filter((c) => c.query.limit === '100').length;

    // It wakes up: a new turn starts, and its workspace shows activity.
    const turn = retime(fixture('claude-turn.json').slice(0, 8), id, h.clock.t - 1_000).map(
      (item, i) => ({ ...item, id: `${item.id}-wake`, sessionIndex: 100 + i }),
    );
    h.api.sessions.get(id)?.items.push(...turn);
    const workspace = h.api.workspaces.find((w) => w.id === ws);
    if (workspace) workspace.lastActivityAt = new Date(h.clock.t).toISOString();
    await run(h, 20_000);

    const pagesAfter = h.api
      .callsTo(`/sessions/${id}/messages`)
      .filter((c) => c.query.limit === '100').length;
    expect(pagesAfter).toBeGreaterThan(pagesBefore);
    expect(h.sink.eventsFor(id)).toContainEqual({ kind: 'turnStart' });
    await h.provider.stop();
  });
});

describe('Conductor poller: units that wait for a free slot', () => {
  it('resolves a pinned session from outside the discovery window within seconds of startup', async () => {
    const pinned = uuid(0x3001);
    const stateDir = tmpStateDir();
    writeState(stateDir, {
      version: 1,
      scope: scope(24),
      sessions: { [pinned]: { pinned: true } },
    });
    const h = await boot({
      stateDir,
      budget: 120,
      prepare: (api) => {
        api.addWorkspace({
          id: uuid(0x3002),
          lastActivityAt: new Date(NOW - 8 * HOUR).toISOString(),
        });
        api.addSession({
          id: pinned,
          workspaceId: uuid(0x3002),
          items: idleFeed(pinned, NOW - 8 * HOUR),
        });
        // More in-scope sessions than the cap keeps background slots busy.
        for (let i = 0; i < 40; i++) {
          const id = uuid(0x3100 + i);
          api.addWorkspace({
            id: uuid(0x3200 + i),
            lastActivityAt: new Date(NOW - (i + 1) * MINUTE).toISOString(),
          });
          api.addSession({
            id,
            workspaceId: uuid(0x3200 + i),
            items: idleFeed(id, NOW - i * MINUTE),
          });
        }
      },
    });
    await run(h, MINUTE);
    expect(h.sink.adopted.has(pinned)).toBe(true);
    await h.provider.stop();
  });

  it('lists archived sessions for an Archived sessions modal opened during startup within seconds', async () => {
    const archived = uuid(0x3301);
    const clock = manualClock(NOW);
    const api = new FakeConductorApi(() => clock.t);
    for (let i = 0; i < 60; i++) {
      const id = uuid(0x3400 + i);
      api.addWorkspace({
        id: uuid(0x3500 + i),
        lastActivityAt: new Date(NOW - (i + 1) * MINUTE).toISOString(),
      });
      api.addSession({ id, workspaceId: uuid(0x3500 + i), items: idleFeed(id, NOW - i * MINUTE) });
    }
    api.addSession({
      id: archived,
      workspaceId: uuid(0x3500),
      archivedAt: new Date(NOW - HOUR).toISOString(),
      items: idleFeed(archived, NOW - 2 * HOUR),
    });
    const provider = createConductorProvider({
      fetchImpl: api.fetch,
      env: { CONDUCTOR_API_KEY: KEY },
      stateDir: tmpStateDir(),
      clock,
      autoTick: false,
      platform: 'linux',
      budgetPerMinute: 120,
    });
    await provider.start(new RecordingSink());
    // Archived sessions opens while dozens of sessions are still onboarding.
    provider.listSessions();
    const until = clock.t + 30_000;
    while (clock.t < until) {
      clock.t += 500;
      await provider.tick();
    }
    expect(provider.listSessions().find((s) => s.sessionId === archived)?.archived).toBe(true);
    await provider.stop();
  });
});

describe('Conductor poller: Archived sessions on a saturated budget', () => {
  it("lists the most recent workspaces' archived sessions within seconds of opening", async () => {
    const archived = uuid(0x3601);
    const clock = manualClock(NOW);
    const api = new FakeConductorApi(() => clock.t);
    // Every session is working, so steady polls alone fill a small budget.
    for (let i = 0; i < 40; i++) {
      const id = uuid(0x3700 + i);
      api.addWorkspace({
        id: uuid(0x3800 + i),
        lastActivityAt: new Date(NOW - (i + 1) * 1000).toISOString(),
      });
      api.addSession({ id, workspaceId: uuid(0x3800 + i), items: workingFeed(id, NOW - i * 1000) });
    }
    // Deposited in one of the most recently active workspaces.
    api.addSession({
      id: archived,
      workspaceId: uuid(0x3801),
      archivedAt: new Date(NOW - HOUR).toISOString(),
      items: idleFeed(archived, NOW - 2 * HOUR),
    });
    const provider = createConductorProvider({
      fetchImpl: api.fetch,
      env: { CONDUCTOR_API_KEY: KEY },
      stateDir: tmpStateDir(),
      clock,
      autoTick: false,
      platform: 'linux',
      budgetPerMinute: 24,
    });
    await provider.start(new RecordingSink());
    const advance = async (ms: number) => {
      const until = clock.t + ms;
      while (clock.t < until) {
        clock.t += 500;
        await provider.tick();
      }
    };
    await advance(3 * MINUTE);
    provider.listSessions();
    await advance(20_000);
    expect(provider.listSessions().find((s) => s.sessionId === archived)?.archived).toBe(true);
    await provider.stop();
  });
});

describe('Conductor poller: ranking by a session own activity', () => {
  it("never shows a busy workspace's old chats ahead of recently active sessions", async () => {
    const stateDir = tmpStateDir();
    writeState(stateDir, { version: 1, scope: scope(4), sessions: {} });
    const busy = uuid(0x4001);
    const live = uuid(0x4002);
    const oldChats = Array.from({ length: 6 }, (_, i) => uuid(0x4100 + i));
    const recent = Array.from({ length: 3 }, (_, i) => uuid(0x4200 + i));
    const h = await boot({
      stateDir,
      prepare: (api) => {
        api.addWorkspace({ id: busy, lastActivityAt: new Date(NOW).toISOString() });
        api.addSession({
          id: live,
          workspaceId: busy,
          items: workingFeed(live, NOW - 1_000),
          status: { status: 'working' },
        });
        for (const [i, id] of oldChats.entries()) {
          api.addSession({
            id,
            workspaceId: busy,
            items: idleFeed(id, NOW - 3 * HOUR - i * MINUTE),
          });
        }
        for (const [i, id] of recent.entries()) {
          const at = NOW - 20 * MINUTE - i * MINUTE;
          api.addWorkspace({ id: uuid(0x4300 + i), lastActivityAt: new Date(at).toISOString() });
          api.addSession({ id, workspaceId: uuid(0x4300 + i), items: idleFeed(id, at) });
        }
      },
    });
    await settle(h.provider, 40);
    expect([...h.sink.adopted].sort()).toEqual([live, ...recent].sort());
    // No old chat walked in and was recalled moments later.
    const everAdopted = new Set(h.sink.upserts.map((u) => u.sessionId));
    expect(oldChats.filter((id) => everAdopted.has(id))).toEqual([]);
    expect(h.sink.removed).toEqual([]);
    // The Sessions list shows each chat's own time, not its workspace's.
    const listed = h.provider.listSessions().find((s) => s.sessionId === oldChats[0]);
    expect(listed?.lastActivityAt).toBeLessThan(NOW - 3 * HOUR + 1_000);
    await h.provider.stop();
  });
});

describe('Conductor poller: the "All" activity window', () => {
  it('keeps 0 as asked and serves it as the longest supported window', async () => {
    const old = uuid(0x4501);
    const h = await boot({
      prepare: (api) => {
        api.addWorkspace({
          id: uuid(0x4502),
          lastActivityAt: new Date(NOW - 3 * 24 * HOUR).toISOString(),
        });
        api.addSession({
          id: old,
          workspaceId: uuid(0x4502),
          items: idleFeed(old, NOW - 3 * 24 * HOUR),
        });
      },
    });
    expect(h.sink.adopted.has(old)).toBe(false);
    h.provider.setScope({ creator: 'me', activeWithinHours: 0, showIdle: true, maxSessions: 24 });
    expect(h.provider.getScope().activeWithinHours).toBe(0);
    expect(h.sink.lastStatus()?.scope.activeWithinHours).toBe(0);
    await settle(h.provider, 30);
    expect(h.sink.adopted.has(old)).toBe(true);
    const discovery = h.api.calls.filter((c) => c.path === '/v0/workspaces').at(-1);
    expect(Date.parse(discovery?.query.since ?? '')).toBe(NOW - 30 * 24 * HOUR);
    await h.provider.stop();
  });
});

describe('Conductor poller: a turn longer than the scope window', () => {
  it('keeps a session that has been working for hours in scope', async () => {
    const id = uuid(0x4401);
    const h = await boot({
      prepare: (api) => {
        api.addWorkspace({ id: uuid(0x4402), lastActivityAt: new Date(NOW).toISOString() });
        api.addSession({
          id,
          workspaceId: uuid(0x4402),
          items: workingFeed(id, NOW - 30_000),
          // The status changed to working when the turn began, 7 h ago.
          status: { status: 'working', updatedAt: new Date(NOW - 7 * HOUR).toISOString() },
        });
      },
    });
    expect(h.sink.adopted.has(id)).toBe(true);
    await h.provider.stop();
  });
});

describe('Conductor poller: restoring from Archived sessions', () => {
  it('keeps a restored session that finished hours ago in the office and the lists', async () => {
    const ws = uuid(0x5001);
    const old = uuid(0x5002);
    const h = await boot({
      prepare: (api) => {
        api.addWorkspace({ id: ws, lastActivityAt: new Date(NOW).toISOString() });
        api.addSession({
          id: uuid(0x5003),
          workspaceId: ws,
          items: workingFeed(uuid(0x5003), NOW - 1_000),
          status: { status: 'working' },
        });
        api.addSession({
          id: old,
          workspaceId: ws,
          archivedAt: new Date(NOW - HOUR).toISOString(),
          items: idleFeed(old, NOW - 7 * HOUR),
        });
      },
    });
    h.provider.listSessions();
    await run(h, 5_000);
    expect(h.provider.listSessions().find((s) => s.sessionId === old)?.archived).toBe(true);

    await h.provider.restoreSession(old);
    await run(h, 15_000);
    expect(h.sink.adopted.has(old)).toBe(true);
    expect(h.sink.removed.filter(([id]) => id === old)).toEqual([]);
    const listed = h.provider.listSessions().find((s) => s.sessionId === old);
    expect(listed).toBeDefined();
    expect(listed?.archived).toBeUndefined();

    // Past the pin, the restore still counts as activity in the window.
    await run(h, 15 * MINUTE, () => {}, 5_000);
    expect(h.sink.adopted.has(old)).toBe(true);
    await h.provider.stop();
  });
});

describe('Conductor poller: levels', () => {
  it('lets a cold session walk in at its real level, with its activity time', async () => {
    const cold = uuid(0x6001);
    const h = await boot({
      prepare: (api) => {
        api.addWorkspace({
          id: uuid(0x6002),
          state: 'sleeping',
          lastActivityAt: new Date(NOW - 2 * HOUR).toISOString(),
        });
        api.addSession({
          id: cold,
          workspaceId: uuid(0x6002),
          items: longFeed(cold, 80, NOW - 2 * HOUR),
        });
      },
    });
    await settle(h.provider, 20);
    const first = h.sink.firstUpsert(cold);
    expect(first?.details).toMatchObject({
      messageCount: 80 * 19,
      lastActivityAt: NOW - 2 * HOUR,
    });
    // Its count never changed afterwards: nothing "evolved" from loading.
    const counts = h.sink.upserts
      .filter((u) => u.sessionId === cold)
      .map((u) => u.details?.messageCount);
    expect(new Set(counts)).toEqual(new Set([80 * 19]));
    await h.provider.stop();
  });
});

describe('Conductor poller: levels when the tail cannot be read', () => {
  it('lets a shown session walk in without a level rather than never', async () => {
    const id = uuid(0x6101);
    const h = await boot({
      prepare: (api) => {
        api.addWorkspace({
          id: uuid(0x6102),
          state: 'sleeping',
          lastActivityAt: new Date(NOW - 2 * HOUR).toISOString(),
        });
        api.addSession({ id, workspaceId: uuid(0x6102), items: longFeed(id, 20, NOW - 2 * HOUR) });
        // Item #1 reads fine; every probe past it fails.
        api.override(
          (c) => c.path === `/v0/sessions/${id}/messages` && c.query.offset !== '0',
          () => new Response('{"userMessage":"boom"}', { status: 500 }),
          1_000,
        );
      },
    });
    await run(h, 10_000);
    expect(h.sink.adopted.has(id)).toBe(true);
    expect(h.sink.firstUpsert(id)?.details?.messageCount).toBeUndefined();
    await h.provider.stop();
  });
});

describe('Conductor poller: catch-up batches', () => {
  it('shows a whole short turn that started and finished between two polls', async () => {
    const ws = uuid(0x7001);
    const side = uuid(0x7002);
    const h = await boot({
      prepare: (api) => {
        api.addWorkspace({
          id: ws,
          state: 'sleeping',
          lastActivityAt: new Date(NOW - 2 * HOUR).toISOString(),
        });
        api.addSession({ id: side, workspaceId: ws, items: idleFeed(side, NOW - 2 * HOUR) });
      },
    });
    expect(h.sink.adopted.has(side)).toBe(true);
    // Quiet for a while: nothing polls a cold session.
    await run(h, 2 * MINUTE, () => {}, 5_000);
    const eventsBefore = h.sink.eventsFor(side).length;

    // A message arrives and a 2.5 s turn runs to completion before any poll.
    const turn = retime(fixture('claude-turn.json'), side, h.clock.t - 1_000).map((item, i) => ({
      ...item,
      id: `${item.id}-live`,
      sessionIndex: 100 + i,
    }));
    h.api.sessions.get(side)?.items.push(...turn);
    const workspace = h.api.workspaces.find((w) => w.id === ws);
    if (workspace) workspace.lastActivityAt = new Date(h.clock.t).toISOString();
    await run(h, 16_000);

    const kinds = h.sink
      .eventsFor(side)
      .slice(eventsBefore)
      .map((e) => e.kind)
      .filter((k) => k === 'turnStart' || k === 'turnEnd');
    expect(kinds).toEqual(['turnStart', 'turnEnd']);
    await h.provider.stop();
  });
});

describe('Conductor poller + driver: a short turn between polls (L1)', () => {
  it('broadcasts a working burst and then the turn end', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    const side = uuid(0x7101);
    const ws = uuid(0x7102);
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeProvider);
    const broadcasts: Array<Record<string, unknown> & { at: number }> = [];
    store.on('broadcast', (m: Record<string, unknown>) =>
      broadcasts.push({ ...m, at: Date.now() }),
    );
    const clock = manualClock(NOW);
    const api = new FakeConductorApi(() => clock.t);
    api.addWorkspace({
      id: ws,
      state: 'sleeping',
      lastActivityAt: new Date(NOW - 2 * HOUR).toISOString(),
    });
    api.addSession({ id: side, workspaceId: ws, items: idleFeed(side, NOW - 2 * HOUR) });
    const provider = createConductorProvider({
      fetchImpl: api.fetch,
      env: { CONDUCTOR_API_KEY: KEY },
      stateDir: tmpStateDir(),
      clock,
      autoTick: false,
      platform: 'linux',
      budgetPerMinute: 60_000,
    });
    const advance = async (ms: number) => {
      const until = clock.t + ms;
      while (clock.t < until) {
        clock.t += 500;
        vi.advanceTimersByTime(500);
        await provider.tick();
      }
    };
    try {
      await provider.start(runtime.attachStreamProvider(provider));
      await settle(provider, 20);
      await advance(2 * MINUTE);
      const id = runtime.streamDriver('conductor')?.agentIdFor(side);
      expect(id).toBeDefined();
      const from = broadcasts.length;

      // The side session gets a message and runs a 2.5 s turn between polls.
      const turn = retime(fixture('claude-turn.json'), side, clock.t - 1_000).map((item, i) => ({
        ...item,
        id: `${item.id}-live`,
        sessionIndex: 100 + i,
      }));
      api.sessions.get(side)?.items.push(...turn);
      const workspace = api.workspaces.find((w) => w.id === ws);
      if (workspace) workspace.lastActivityAt = new Date(clock.t).toISOString();
      await advance(20_000);

      const statuses = broadcasts
        .slice(from)
        .filter((m) => m.type === 'agentStatus' && m.id === id);
      expect(statuses.map((m) => m.status)).toEqual(['active', 'waiting']);
      // Long enough to be seen working before the turn-end hop.
      expect(statuses[1].at - statuses[0].at).toBeGreaterThanOrEqual(STREAM_TURN_MIN_ACTIVE_MS);
    } finally {
      await provider.stop();
      runtime.dispose();
      vi.useRealTimers();
    }
  });
});

describe('Conductor poller: adoption is a silent seed', () => {
  it('with the runtime driver, a session already waiting walks in without a chime', async () => {
    const waiting = uuid(0x8101);
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeProvider);
    const broadcasts: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m: Record<string, unknown>) => broadcasts.push(m));
    const clock = manualClock(NOW);
    const api = new FakeConductorApi(() => clock.t);
    api.addWorkspace({ id: uuid(0x8102), lastActivityAt: new Date(NOW - MINUTE).toISOString() });
    api.addSession({
      id: waiting,
      workspaceId: uuid(0x8102),
      items: retime(fixture('wait-ask-user-question-pending.json'), waiting, NOW - MINUTE),
      status: { status: 'working' },
    });
    const provider = createConductorProvider({
      fetchImpl: api.fetch,
      env: { CONDUCTOR_API_KEY: KEY },
      stateDir: tmpStateDir(),
      clock,
      autoTick: false,
      platform: 'linux',
      budgetPerMinute: 60_000,
    });
    try {
      await provider.start(runtime.attachStreamProvider(provider));
      await settle(provider, 20);
      const statuses = broadcasts.filter((m) => m.type === 'agentStatus');
      expect(statuses).toContainEqual(
        expect.objectContaining({ status: 'waiting', awaitingInput: true, silent: true }),
      );
      expect(statuses.filter((m) => m.silent !== true)).toEqual([]);
    } finally {
      await provider.stop();
      runtime.dispose();
    }
  });

  it('adopts a session already waiting on the user inside a silent seed', async () => {
    const waiting = uuid(0x8001);
    const sink = new SeedAwareSink();
    const h = await boot({
      sink,
      prepare: (api) => {
        api.addWorkspace({
          id: uuid(0x8002),
          lastActivityAt: new Date(NOW - MINUTE).toISOString(),
        });
        api.addSession({
          id: waiting,
          workspaceId: uuid(0x8002),
          items: retime(fixture('wait-ask-user-question-pending.json'), waiting, NOW - MINUTE),
          status: { status: 'working' },
        });
      },
    });
    expect(h.sink.adopted.has(waiting)).toBe(true);
    expect(sink.seeded).toContainEqual([waiting, { kind: 'awaitingInput' }]);
    await h.provider.stop();
  });
});
