/**
 * Conductor poller: discovery, per-session onboarding and tail polling, scope
 * filtering and the cap, all pushed through the AgentEventSink.
 *
 * Lifecycle of a session (DESIGN §B):
 * 1. Discovery lists in-scope workspaces every 15 s and their sessions when a
 *    workspace's lastActivityAt advanced or its list went stale.
 * 2. Onboarding: `/status`, then item #1 (`offset=0&limit=1`) for the spawn
 *    edge and the queued-first-message check, then, for Hot/Warm sessions, the
 *    tail of the feed (exponential + binary search on `offset`, starting at
 *    128), replayed through the normalizer silently.
 * 3. Visible sessions (scope, hidden/pinned, cap with hysteresis, at most 12
 *    children per Lead) are adopted with one consolidated state.
 * 4. Steady state: `messages?after=<cursor>` per tier (Focus and Hot every
 *    2-3 s, Warm every 15-30 s, Cold never), stretched to fit the budget, and
 *    `/status` every 30-60 s to reconcile turns the feed never closed.
 *
 * Only items from a steady tail poll and received within the last 30 s are
 * `live` (they animate links and notices); backfills, re-probes and catch-ups
 * replay silently and then emit the difference against what the office was
 * last told.
 */

import type {
  ConductorScope,
  ConductorSessionStatus as SummaryStatus,
  ConductorSessionSummary,
} from '../../../../../core/src/messages.js';
import type {
  AgentEvent,
  AgentEventSink,
  StreamSessionInfo,
} from '../../../../../core/src/provider.js';
import { ConductorApiError, type ConductorClient } from './client.js';
import {
  ARCHIVE_INTEREST_MS,
  ARCHIVED_LIST_INTERVAL_MS,
  BUDGET_PLANNING_FRACTION,
  CAP_HYSTERESIS,
  DETAILS_THROTTLE_MS,
  DISCOVERY_INTERVAL_MS,
  FOCUS_POLL_MAX_MS,
  FOCUS_POLL_MS,
  FULL_LIST_INTERVAL_MS,
  HOT_POLL_MS,
  HOT_RECENT_MS,
  LIVE_WINDOW_MS,
  MAX_CHILDREN_PER_LEAD,
  MAX_CONCURRENT_UNITS,
  MAX_DRAIN_PAGES,
  MESSAGES_PAGE_LIMIT,
  OFFSCREEN_POLL_MS,
  PINNED_RESOLVE_INTERVAL_MS,
  POLL_STRETCH_MAX_MS,
  PRIORITY_BACKGROUND,
  PRIORITY_DISCOVERY,
  PRIORITY_FOCUS,
  PRIORITY_HOT,
  PRIORITY_USER,
  PRIORITY_WARM,
  PROMOTION_MS,
  QUIET_RECONCILE_MS,
  SESSION_LIST_MAX_AGE_MS,
  SESSION_LIST_MIN_GAP_MS,
  SESSIONS_CHANGED_DEBOUNCE_MS,
  STARTING_GRACE_MS,
  STATUS_POLL_MAX_MS,
  STATUS_POLL_MS,
  STEADY_POLL_GAP_MS,
  TAIL_HINT_FRACTION,
  TAIL_PROBE_START,
  TAIL_WINDOW,
  TICK_MS,
  WARM_POLL_MAX_MS,
  WARM_POLL_MS,
  WARM_READY_WORKSPACE_MS,
  WARM_RECENT_MS,
  WORKSPACES_PAGE_LIMIT,
} from './constants.js';
import { harnessFromModel, isHarness } from './harness.js';
import type { LinkObservation, LinkTracker } from './links.js';
import { repoShortName, repoSlug, sessionLabel } from './naming.js';
import { normalizeItem } from './normalize/index.js';
import {
  asString,
  clipError,
  createNormState,
  endTurn,
  itemTime,
  type NormState,
  parseTime,
  type ProviderEvent,
  startTurn,
  survivesTurnEnd,
} from './normalize/shared.js';
import type { SessionLogStore } from './sessionLog.js';
import type { ConductorStateStore } from './state.js';
import { formatConductorToolStatus } from './tools.js';
import type {
  ConductorItem,
  ConductorMe,
  ConductorRunStatus,
  ConductorSession,
  ConductorSessionStatus,
  ConductorWorkspace,
} from './types.js';

type Tier = 'focus' | 'hot' | 'warm' | 'cold';
type TurnEndEvent = Extract<AgentEvent, { kind: 'turnEnd' }>;
type ToolStartEvent = Extract<AgentEvent, { kind: 'toolStart' }>;
type ContextUsageEvent = Extract<AgentEvent, { kind: 'contextUsage' }>;
type SeedStatus = NonNullable<StreamSessionInfo['initialStatus']>;
type ConnectionState = 'connecting' | 'connected' | 'unauthorized' | 'unreachable' | 'rateLimited';

export interface PollerClock {
  now(): number;
}

export interface PollerOptions {
  client: ConductorClient;
  sink: AgentEventSink;
  state: ConductorStateStore;
  logs: SessionLogStore;
  links: LinkTracker;
  me: ConductorMe;
  clock?: PollerClock;
  log?: (message: string) => void;
  /** Run the scheduling loop on a timer (off in tests, which call tick()). */
  autoTick?: boolean;
}

interface WorkspaceRecord {
  ws: ConductorWorkspace;
  lastActivityMs: number;
  /** Returned by the latest discovery (inside the scope window and creator filter). */
  discovered: boolean;
  listedAt: number;
  listedActivityMs: number;
  archivedListedAt: number;
}

/** What the office was last told about a session (mirrors the runtime's rules). */
interface SinkMirror {
  status: SeedStatus;
  awaiting: boolean;
  permission: boolean;
  tools: Map<string, { name: string; runInBackground: boolean }>;
  subTools: Map<string, string>;
  usage?: { tokens: number; window?: number };
}

interface SessionRecord {
  id: string;
  workspaceId: string;
  api: ConductorSession;
  firstSeen: number;
  norm: NormState;
  runStatus?: ConductorRunStatus;
  statusAt?: number;
  statusMessage?: string;
  lastErrorAt?: string;
  cursor?: { lastId: string; lastIndex: number };
  /** Normalizer state reconstructed from the feed tail. */
  tailed: boolean;
  /** Item #1 read (or its sender cached in state). */
  probed: boolean;
  onboarded: boolean;
  firstSender?: string | null;
  /** Item #1 is a user message and nothing else exists yet. */
  loneFirstMessage: boolean;
  lastPollAt?: number;
  /** Poll at the next tick regardless of the interval (focus, promotion). */
  pollSoon: boolean;
  /** Interval the scheduler last planned for this session. */
  plannedIntervalMs: number;
  promotedUntil?: number;
  /** The spawn edge from item #1 was reported this run. */
  spawnLinkEmitted: boolean;
  /** Item #1 probe found no items at all. */
  feedEmpty: boolean;
  /** Item #1 was fetched for the Pokédex prompt this run. */
  promptFetched: boolean;
  busy: boolean;
  neverStarted: boolean;
  adopted: boolean;
  mirror?: SinkMirror;
  infoSig?: string;
  detailsSig?: string;
  detailsAt?: number;
}

interface Unit {
  priority: number;
  order: number;
  run: () => Promise<void>;
}

export interface PollIntervals {
  focusMs: number;
  hotMs: number;
  warmMs: number;
  statusMs: number;
  offscreenMs: number;
}

/**
 * Nominal cadence (Focus 2 s, Hot 2.5 s, Warm 15 s, status 30 s), stretched in
 * steps until the planned requests per minute fit the budget.
 */
export function planIntervals(
  budgetPerMinute: number,
  counts: { focus: number; hot: number; warm: number; offscreen: number; activeWorkspaces: number },
): PollIntervals {
  const available = budgetPerMinute * BUDGET_PLANNING_FRACTION;
  const fixed =
    60_000 / DISCOVERY_INTERVAL_MS + counts.activeWorkspaces * (60_000 / SESSION_LIST_MAX_AGE_MS);
  const plan: PollIntervals = {
    focusMs: FOCUS_POLL_MS,
    hotMs: HOT_POLL_MS,
    warmMs: WARM_POLL_MS,
    statusMs: STATUS_POLL_MS,
    offscreenMs: OFFSCREEN_POLL_MS,
  };
  const rate = (ms: number, n: number) => (n > 0 ? (n * 60_000) / ms : 0);
  const others = () =>
    fixed +
    rate(plan.focusMs, counts.focus) +
    rate(plan.statusMs, counts.focus + counts.hot) +
    rate(plan.warmMs, counts.warm) +
    rate(plan.offscreenMs, counts.offscreen);
  const demand = () => others() + rate(plan.hotMs, counts.hot);
  if (demand() <= available) return plan;
  plan.warmMs = WARM_POLL_MAX_MS;
  plan.statusMs = STATUS_POLL_MAX_MS;
  plan.offscreenMs = Math.max(plan.offscreenMs, STATUS_POLL_MAX_MS);
  if (demand() <= available) return plan;
  plan.focusMs = FOCUS_POLL_MAX_MS;
  if (demand() <= available) return plan;
  const remaining = available - others();
  plan.hotMs =
    remaining > 0
      ? Math.min(POLL_STRETCH_MAX_MS, Math.max(HOT_POLL_MS, (counts.hot * 60_000) / remaining))
      : POLL_STRETCH_MAX_MS;
  if (demand() <= available) return plan;
  plan.warmMs = POLL_STRETCH_MAX_MS;
  plan.offscreenMs = POLL_STRETCH_MAX_MS;
  const left = available - fixed - rate(plan.statusMs, counts.focus + counts.hot);
  const hotAndFocus = counts.hot + counts.focus;
  if (left > 0 && hotAndFocus > 0) {
    const each = Math.min(
      POLL_STRETCH_MAX_MS,
      Math.max(FOCUS_POLL_MAX_MS, (hotAndFocus * 60_000) / left),
    );
    plan.focusMs = Math.max(plan.focusMs, each);
    plan.hotMs = Math.max(HOT_POLL_MS, each);
  }
  return plan;
}

function emptyMirror(status: SeedStatus): SinkMirror {
  return { status, awaiting: false, permission: false, tools: new Map(), subTools: new Map() };
}

export class ConductorPoller {
  private readonly client: ConductorClient;
  private readonly sink: AgentEventSink;
  private readonly state: ConductorStateStore;
  private readonly logs: SessionLogStore;
  private readonly links: LinkTracker;
  private readonly me: ConductorMe;
  private readonly clock: PollerClock;
  private readonly log: (message: string) => void;
  private readonly autoTick: boolean;

  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly records = new Map<string, SessionRecord>();
  private readonly archived = new Map<string, { session: ConductorSession; workspaceId: string }>();
  private focusIds = new Set<string>();
  private firstSeenCounter = 0;
  private unitOrder = 0;
  private running = 0;
  private discoveryBusy = false;
  private nextDiscoveryAt = 0;
  private lastFullListAt = 0;
  private lastPinnedResolveAt = 0;
  private archiveInterestUntil = 0;
  private discoveredOnce = false;
  private connection: ConnectionState = 'connecting';
  private connectionMessage: string | undefined;
  private lastSyncAt: number | undefined;
  private halted = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sessionsTimer: ReturnType<typeof setTimeout> | undefined;
  private lastStatusSig = '';
  private lastSessionsSig = '';
  private lastSessionsCoreSig = '';
  private lastSessionsAt = 0;
  /** An explicit scope change applies at once, without cap hysteresis. */
  private capReset = false;

  constructor(opts: PollerOptions) {
    this.client = opts.client;
    this.sink = opts.sink;
    this.state = opts.state;
    this.logs = opts.logs;
    this.links = opts.links;
    this.me = opts.me;
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.log = opts.log ?? (() => {});
    this.autoTick = opts.autoTick ?? true;
  }

  // ── Lifecycle ──

  /** First discovery pass (workspaces and their session lists); then the loop. */
  async start(): Promise<void> {
    await this.discover();
    this.refreshVisibility();
    this.emitStatus();
    this.flushSessionsChanged();
    if (this.autoTick && !this.stopped) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
    this.timer = undefined;
    this.sessionsTimer = undefined;
  }

  /** One scheduling round. Resolves when the work it started has finished. */
  async tick(): Promise<void> {
    if (this.stopped || this.halted) return;
    const now = this.clock.now();
    this.links.prune(now);
    const units = this.collectUnits(now);
    units.sort((a, b) => a.priority - b.priority || a.order - b.order);
    const slots = Math.max(0, MAX_CONCURRENT_UNITS - this.running);
    await Promise.all(units.slice(0, slots).map((unit) => this.runUnit(unit)));
    this.emitStatus();
  }

  // ── Controls ──

  getScope(): ConductorScope {
    return this.state.scope;
  }

  setScope(scope: ConductorScope): void {
    const before = this.state.scope;
    this.state.setScope(scope);
    const after = this.state.scope;
    if (before.creator !== after.creator || before.activeWithinHours !== after.activeWithinHours) {
      this.nextDiscoveryAt = 0;
      if (this.autoTick) void this.tick();
    }
    this.capReset = true;
    this.refreshVisibility();
    this.emitStatus();
  }

  setHidden(sessionId: string, hidden: boolean): void {
    this.state.patchSession(sessionId, { hidden });
    this.refreshVisibility();
  }

  setPinned(sessionId: string, pinned: boolean): void {
    this.state.patchSession(sessionId, { pinned });
    if (pinned && !this.records.has(sessionId)) this.lastPinnedResolveAt = 0;
    this.refreshVisibility();
  }

  setFocus(sessionIds: string[]): void {
    this.focusIds = new Set(sessionIds);
    for (const id of this.focusSet()) {
      const rec = this.records.get(id);
      if (rec) rec.pollSoon = true;
    }
    if (this.autoTick) void this.tick();
  }

  /**
   * Poll a session soon: a link targets it, its workspace showed activity, or
   * the user acted on it (`checkStatus` then also reconciles with /status).
   */
  promote(sessionId: string, checkStatus = false): void {
    const rec = this.records.get(sessionId);
    if (!rec) return;
    rec.promotedUntil = this.clock.now() + PROMOTION_MS;
    rec.pollSoon = true;
    if (checkStatus && rec.statusAt !== undefined) rec.statusAt = 0;
  }

  listSessions(): ConductorSessionSummary[] {
    this.archiveInterestUntil = this.clock.now() + ARCHIVE_INTEREST_MS;
    return this.summaries();
  }

  async getSessionDetail(sessionId: string) {
    const rec = this.records.get(sessionId);
    if (!rec) return null;
    if (!rec.tailed && !rec.busy) {
      rec.busy = true;
      try {
        await this.syncTail(rec, PRIORITY_USER);
      } catch (err) {
        this.noteSessionError(rec, err);
      } finally {
        rec.busy = false;
      }
    }
    if (!this.logs.get(sessionId).prompt && !rec.promptFetched && !rec.feedEmpty) {
      rec.promptFetched = true;
      await this.fetchPrompt(rec);
    }
    return this.logs.get(sessionId, (peer) => this.labelFor(peer));
  }

  /** After a successful archive: despawn and list it in the PC Box. */
  markArchived(sessionId: string): void {
    const rec = this.records.get(sessionId);
    if (rec) {
      this.archived.set(sessionId, {
        session: { ...rec.api, archivedAt: new Date(this.clock.now()).toISOString() },
        workspaceId: rec.workspaceId,
      });
      this.dropRecord(rec, 'archived');
    }
    this.refreshVisibility();
    this.scheduleSessionsChanged();
  }

  /** After a successful restore: forget the archived entry and re-adopt it. */
  async markRestored(sessionId: string): Promise<void> {
    const entry = this.archived.get(sessionId);
    this.archived.delete(sessionId);
    const workspaceId = entry?.workspaceId ?? this.records.get(sessionId)?.workspaceId;
    const ws = workspaceId ? this.workspaces.get(workspaceId) : undefined;
    if (ws) {
      try {
        await this.listWorkspaceSessions(ws, false, PRIORITY_USER);
      } catch (err) {
        this.noteDiscoveryError(err);
      }
    } else if (entry) {
      this.upsertSessionRecord({ ...entry.session, archivedAt: null }, entry.workspaceId);
    }
    this.promote(sessionId);
    this.refreshVisibility();
    this.scheduleSessionsChanged();
    if (this.autoTick) void this.tick();
  }

  // ── Scheduling ──

  private focusSet(): Set<string> {
    const set = new Set(this.focusIds);
    for (const id of this.focusIds) for (const peer of this.links.neighbors(id)) set.add(peer);
    return set;
  }

  private collectUnits(now: number): Unit[] {
    const units: Unit[] = [];
    const add = (priority: number, run: () => Promise<void>) =>
      units.push({ priority, order: this.unitOrder++, run });

    if (!this.discoveryBusy && now >= this.nextDiscoveryAt) add(1, () => this.discover());
    if (now - this.lastPinnedResolveAt >= PINNED_RESOLVE_INTERVAL_MS) {
      this.lastPinnedResolveAt = now;
      const missing = this.state
        .sessionIds()
        .filter((id) => this.state.session(id)?.pinned && !this.records.has(id));
      if (missing.length > 0) add(8, () => this.resolvePinned(missing));
    }

    const focus = this.focusSet();
    const counts = { focus: 0, hot: 0, warm: 0, offscreen: 0, activeWorkspaces: 0 };
    const tiers = new Map<string, Tier>();
    for (const rec of this.records.values()) {
      if (!this.isCandidate(rec, now)) continue;
      const tier = this.tierOf(rec, now, focus);
      tiers.set(rec.id, tier);
      if (tier === 'cold') continue;
      if (!rec.adopted) counts.offscreen++;
      else counts[tier]++;
    }
    for (const ws of this.workspaces.values()) {
      if (ws.discovered && now - ws.lastActivityMs < WARM_RECENT_MS) counts.activeWorkspaces++;
    }
    const plan = planIntervals(this.client.effectiveBudget, counts);

    const onboarding: SessionRecord[] = [];
    for (const rec of this.records.values()) {
      const tier = tiers.get(rec.id);
      if (!tier || rec.busy) continue;
      if (!rec.onboarded) {
        onboarding.push(rec);
        continue;
      }
      if (!rec.tailed) {
        if (tier !== 'cold')
          add(5, () => this.withSession(rec, () => this.syncTail(rec, PRIORITY_HOT)));
        continue;
      }
      if (tier === 'cold') continue;
      let interval = tier === 'focus' ? plan.focusMs : tier === 'hot' ? plan.hotMs : plan.warmMs;
      if (!rec.adopted) interval = Math.max(interval, plan.offscreenMs);
      rec.plannedIntervalMs = interval;
      const priority = tier === 'focus' ? 2 : tier === 'hot' ? 4 : 6;
      const clientPriority =
        tier === 'focus' ? PRIORITY_FOCUS : tier === 'hot' ? PRIORITY_HOT : PRIORITY_WARM;
      if (rec.pollSoon || now >= (rec.lastPollAt ?? 0) + interval) {
        add(rec.adopted ? priority : 7, () =>
          this.withSession(rec, () => this.pollMessages(rec, clientPriority)),
        );
        continue;
      }
      if (
        rec.adopted &&
        (tier === 'focus' || tier === 'hot') &&
        this.statusDue(rec, now, plan.statusMs)
      ) {
        add(5, () => this.withSession(rec, () => this.pollStatus(rec, clientPriority)));
      }
    }

    // Onboarding order: pinned, working, recently active (stable by first seen).
    onboarding.sort((a, b) => this.onboardingRank(a, b));
    for (const rec of onboarding) {
      add(3, () => this.withSession(rec, () => this.onboard(rec)));
    }

    if (now < this.archiveInterestUntil) {
      for (const ws of this.workspaces.values()) {
        if (!ws.discovered || now - ws.archivedListedAt < ARCHIVED_LIST_INTERVAL_MS) continue;
        ws.archivedListedAt = now;
        add(8, () => this.listWorkspaceSessions(ws, true, PRIORITY_BACKGROUND));
      }
    }
    return units;
  }

  private onboardingRank(a: SessionRecord, b: SessionRecord): number {
    const pin = (r: SessionRecord) => (this.state.session(r.id)?.pinned ? 0 : 1);
    const working = (r: SessionRecord) => (r.runStatus === 'working' ? 0 : 1);
    const statusKnown = (r: SessionRecord) => (r.statusAt === undefined ? 0 : 1);
    return (
      pin(a) - pin(b) ||
      // Everyone's status first (cheap), then feeds for the working ones.
      statusKnown(a) - statusKnown(b) ||
      working(a) - working(b) ||
      this.activityOf(b) - this.activityOf(a) ||
      a.firstSeen - b.firstSeen
    );
  }

  private statusDue(rec: SessionRecord, now: number, statusMs: number): boolean {
    if (rec.statusAt === undefined) return true;
    if (now >= rec.statusAt + statusMs) return true;
    const quietSince = rec.norm.lastItemAt ?? 0;
    return (
      this.believesActive(rec.norm) &&
      now - quietSince > QUIET_RECONCILE_MS &&
      now - rec.statusAt > QUIET_RECONCILE_MS
    );
  }

  private async runUnit(unit: Unit): Promise<void> {
    this.running++;
    try {
      await unit.run();
    } catch (err) {
      this.log(`unit failed: ${(err as Error).message}`);
    } finally {
      this.running--;
      this.refreshVisibility();
    }
  }

  private async withSession(rec: SessionRecord, fn: () => Promise<void>): Promise<void> {
    if (rec.busy) return;
    rec.busy = true;
    try {
      await fn();
    } catch (err) {
      this.noteSessionError(rec, err);
    } finally {
      rec.busy = false;
    }
  }

  // ── Discovery ──

  private async discover(): Promise<void> {
    if (this.discoveryBusy || this.halted) return;
    this.discoveryBusy = true;
    const now = this.clock.now();
    this.nextDiscoveryAt = now + DISCOVERY_INTERVAL_MS;
    try {
      const scope = this.state.scope;
      const since = new Date(now - scope.activeWithinHours * 3_600_000).toISOString();
      const creator = scope.creator === 'me' ? this.me.userId : undefined;
      const seen = new Set<string>();
      let offset = 0;
      for (;;) {
        const page = await this.client.listWorkspaces(
          { since, creator, limit: WORKSPACES_PAGE_LIMIT, offset },
          PRIORITY_DISCOVERY,
        );
        const data = Array.isArray(page?.data) ? page.data : [];
        for (const ws of data) {
          if (!ws?.id) continue;
          seen.add(ws.id);
          this.upsertWorkspace(ws, true);
        }
        offset += data.length;
        if (!page?.hasMore || data.length === 0) break;
      }
      for (const ws of this.workspaces.values()) {
        if (!seen.has(ws.ws.id)) ws.discovered = false;
      }
      const full = now - this.lastFullListAt >= FULL_LIST_INTERVAL_MS;
      if (full) this.lastFullListAt = now;
      const toList = [...this.workspaces.values()].filter(
        (ws) => ws.discovered && this.needsList(ws, now, full),
      );
      toList.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
      await this.mapLimit(toList, 4, (ws) =>
        this.listWorkspaceSessions(ws, false, PRIORITY_DISCOVERY),
      );
      this.lastSyncAt = this.clock.now();
      this.discoveredOnce = true;
      this.setConnection(this.client.isRateLimited() ? 'rateLimited' : 'connected');
    } catch (err) {
      this.noteDiscoveryError(err);
    } finally {
      this.discoveryBusy = false;
      this.scheduleSessionsChanged();
    }
  }

  private needsList(ws: WorkspaceRecord, now: number, full: boolean): boolean {
    if (ws.listedAt === 0 || full) return true;
    const age = now - ws.listedAt;
    if (ws.lastActivityMs > ws.listedActivityMs && age >= SESSION_LIST_MIN_GAP_MS) return true;
    return age >= SESSION_LIST_MAX_AGE_MS && now - ws.lastActivityMs < WARM_RECENT_MS;
  }

  private upsertWorkspace(ws: ConductorWorkspace, discovered: boolean): WorkspaceRecord {
    const activity = parseTime(ws.lastActivityAt) ?? parseTime(ws.createdAt) ?? 0;
    let rec = this.workspaces.get(ws.id);
    if (!rec) {
      rec = {
        ws,
        lastActivityMs: activity,
        discovered,
        listedAt: 0,
        listedActivityMs: 0,
        archivedListedAt: 0,
      };
      this.workspaces.set(ws.id, rec);
      return rec;
    }
    const advanced = activity > rec.lastActivityMs;
    rec.ws = ws;
    rec.lastActivityMs = Math.max(rec.lastActivityMs, activity);
    rec.discovered = rec.discovered || discovered;
    if (advanced && this.discoveredOnce) {
      // Something happened: Cold sessions of this workspace get polled again.
      for (const session of this.records.values()) {
        if (session.workspaceId === ws.id) this.promote(session.id);
      }
    }
    return rec;
  }

  private async listWorkspaceSessions(
    ws: WorkspaceRecord,
    includeArchived: boolean,
    priority: number,
  ): Promise<void> {
    const sessions: ConductorSession[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.client.listWorkspaceSessions(ws.ws.id, { includeArchived }, priority);
      const data = Array.isArray(page?.data) ? page.data : [];
      sessions.push(...data);
      offset += data.length;
      if (!page?.hasMore || data.length === 0 || offset > 1_000) break;
    }
    const now = this.clock.now();
    if (includeArchived) ws.archivedListedAt = now;
    else {
      ws.listedAt = now;
      ws.listedActivityMs = ws.lastActivityMs;
    }
    const live = new Set<string>();
    for (const session of sessions) {
      if (!session?.id) continue;
      if (session.archivedAt) {
        this.archived.set(session.id, { session, workspaceId: ws.ws.id });
        const rec = this.records.get(session.id);
        if (rec) this.dropRecord(rec, 'archived');
        continue;
      }
      this.archived.delete(session.id);
      live.add(session.id);
      this.upsertSessionRecord(session, ws.ws.id);
    }
    if (!includeArchived) {
      for (const rec of [...this.records.values()]) {
        if (rec.workspaceId === ws.ws.id && !live.has(rec.id)) this.dropRecord(rec, 'gone');
      }
    }
    this.scheduleSessionsChanged();
  }

  private upsertSessionRecord(session: ConductorSession, workspaceId: string): SessionRecord {
    let rec = this.records.get(session.id);
    const persisted = this.state.session(session.id);
    const resolvedModel = session.resolvedModel ?? undefined;
    if (!rec) {
      const harness = isHarness(persisted?.harness)
        ? persisted.harness
        : harnessFromModel(resolvedModel ?? session.model ?? undefined);
      rec = {
        id: session.id,
        workspaceId,
        api: session,
        firstSeen: this.firstSeenCounter++,
        norm: createNormState({ harness, resolvedModel }),
        cursor: persisted?.cursor,
        tailed: false,
        probed: persisted?.firstSender !== undefined,
        onboarded: false,
        firstSender: persisted?.firstSender,
        loneFirstMessage: false,
        pollSoon: false,
        plannedIntervalMs: HOT_POLL_MS,
        spawnLinkEmitted: false,
        feedEmpty: false,
        promptFetched: false,
        busy: false,
        neverStarted: false,
        adopted: false,
      };
      this.records.set(session.id, rec);
    } else {
      rec.api = session;
      rec.workspaceId = workspaceId;
      if (resolvedModel) rec.norm.resolvedModel = resolvedModel;
    }
    rec.neverStarted =
      !session.model && !session.resolvedModel && (!session.name || rec.neverStarted);
    if (rec.adopted) this.upsertInfo(rec);
    return rec;
  }

  private async resolvePinned(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (this.records.has(id)) continue;
      try {
        const session = await this.client.getSession(id, PRIORITY_BACKGROUND);
        const workspaceId = /[?&]id=([0-9a-f-]{36})/i.exec(session.deepLink ?? '')?.[1];
        if (!workspaceId) continue;
        if (!this.workspaces.has(workspaceId)) {
          const ws = await this.client.getWorkspace(workspaceId, PRIORITY_BACKGROUND);
          this.upsertWorkspace(ws, false);
        }
        if (session.archivedAt) {
          this.archived.set(id, { session, workspaceId });
          continue;
        }
        this.upsertSessionRecord(session, workspaceId);
      } catch (err) {
        if (err instanceof ConductorApiError && err.kind === 'unauthorized') this.halt(err);
      }
    }
    this.scheduleSessionsChanged();
  }

  private noteDiscoveryError(err: unknown): void {
    if (!(err instanceof ConductorApiError)) {
      this.log(`discovery failed: ${(err as Error).message}`);
      return;
    }
    switch (err.kind) {
      case 'unauthorized':
        this.halt(err);
        return;
      case 'rateLimited':
        this.setConnection('rateLimited', 'Conductor is rate limiting requests; slowing down.');
        return;
      case 'network':
        this.nextDiscoveryAt = Math.max(this.nextDiscoveryAt, this.client.pausedUntil);
        this.setConnection('unreachable', "Can't reach Conductor. Retrying.");
        return;
      default:
        this.log(`discovery failed: ${err.message}`);
    }
  }

  /** 401/403 on account-level calls: stop polling until the user fixes the key. */
  private halt(err: ConductorApiError): void {
    this.halted = true;
    this.setConnection(
      'unauthorized',
      'Conductor rejected the API key. Sign in again with `conductor auth login` or set CONDUCTOR_API_KEY, then restart.',
    );
    this.log(`halted after ${err.message}`);
    for (const rec of this.records.values()) {
      if (rec.adopted) this.unadopt(rec, 'unauthorized');
    }
  }

  private noteSessionError(rec: SessionRecord, err: unknown): void {
    if (!(err instanceof ConductorApiError)) {
      this.log(`session ${rec.id.slice(0, 8)} failed: ${(err as Error).message}`);
      return;
    }
    if (err.kind === 'notFound') {
      this.dropRecord(rec, 'gone');
    } else if (err.kind === 'unauthorized' && err.status === 401) {
      this.halt(err);
    } else if (err.kind === 'rateLimited' && err.scope === 'global') {
      this.setConnection('rateLimited', 'Conductor is rate limiting requests; slowing down.');
    } else if (err.kind === 'network') {
      this.setConnection('unreachable', "Can't reach Conductor. Retrying.");
    }
  }

  // ── Onboarding ──

  private async onboard(rec: SessionRecord): Promise<void> {
    if (rec.statusAt === undefined) {
      await this.fetchStatus(rec, PRIORITY_DISCOVERY);
      if (!this.records.has(rec.id)) return;
      // The feed phase runs in a later unit so working sessions go first.
      if (rec.runStatus !== undefined) return;
    }
    if (!rec.probed) await this.probeFirstItem(rec);
    if (rec.neverStarted || !this.records.has(rec.id)) return;
    if (rec.feedEmpty) {
      // Nothing to replay; steady polls read the feed from its start.
      rec.tailed = true;
      rec.lastPollAt = this.clock.now();
    } else if (this.tierOf(rec, this.clock.now(), this.focusSet()) !== 'cold') {
      await this.syncTail(rec, PRIORITY_HOT);
    }
    this.emitCachedSpawnLink(rec);
    rec.onboarded = true;
  }

  private async fetchStatus(
    rec: SessionRecord,
    priority: number,
  ): Promise<ConductorSessionStatus | undefined> {
    try {
      const status = await this.client.getSessionStatus(rec.id, priority);
      rec.statusAt = this.clock.now();
      rec.runStatus = status?.status ?? 'idle';
      rec.statusMessage = clipError(status?.errorMessage ?? status?.lastError ?? undefined);
      return status;
    } catch (err) {
      if (
        err instanceof ConductorApiError &&
        err.kind === 'rateLimited' &&
        err.scope === 'status'
      ) {
        rec.statusAt = this.clock.now();
        return undefined;
      }
      throw err;
    }
  }

  private async probeFirstItem(rec: SessionRecord): Promise<void> {
    const page = await this.client.listMessages(
      rec.id,
      { offset: 0, limit: 1 },
      PRIORITY_DISCOVERY,
    );
    const item = page?.data?.[0];
    rec.probed = true;
    if (!item) {
      rec.feedEmpty = true;
      if (!rec.api.model && !rec.api.resolvedModel) rec.neverStarted = true;
      return;
    }
    const sender = item.type === 'userMessage' ? asString(item.content.senderSessionId) : undefined;
    rec.firstSender = sender && sender !== rec.id ? sender : null;
    rec.loneFirstMessage = item.type === 'userMessage' && !page.hasMore;
    this.state.patchSession(rec.id, { firstSender: rec.firstSender });
    if (item.type === 'userMessage') {
      const text = asString(item.content.message);
      if (text) this.logs.setPrompt(rec.id, text);
    }
    this.applyLinks(this.links.observe(rec.id, item, { live: false }), false);
    rec.spawnLinkEmitted = true;
    // A just-created session: its only item (the first message) is its activity.
    if (rec.loneFirstMessage) this.noteActivity(rec, itemTime(item));
  }

  /** item #1's sender was cached by a previous run: restate the spawn edge. */
  private emitCachedSpawnLink(rec: SessionRecord): void {
    if (!rec.firstSender || rec.spawnLinkEmitted) return;
    rec.spawnLinkEmitted = true;
    this.sink.link({
      fromSessionId: rec.firstSender,
      toSessionId: rec.id,
      kind: 'spawned',
      at: this.state.session(rec.id)?.lastActivityAt ?? this.clock.now(),
      live: false,
    });
  }

  private async fetchPrompt(rec: SessionRecord): Promise<void> {
    try {
      const page = await this.client.listMessages(rec.id, { offset: 0, limit: 1 }, PRIORITY_USER);
      const item = page?.data?.[0];
      if (item?.type === 'userMessage') {
        const text = asString(item.content.message);
        if (text) this.logs.setPrompt(rec.id, text);
      }
    } catch (err) {
      this.noteSessionError(rec, err);
    }
  }

  /**
   * Find the end of the feed with `limit=1` probes, fetch the last page, and
   * replay it into a fresh normalizer state without emitting anything; then
   * tell the office the resulting state in one go.
   */
  private async syncTail(rec: SessionRecord, priority: number): Promise<void> {
    const probe = async (offset: number) =>
      ((await this.client.listMessages(rec.id, { offset, limit: 1 }, priority))?.data?.length ??
        0) > 0;
    let lo = 0;
    let hi: number | undefined;
    const hint = rec.cursor?.lastIndex ?? 0;
    if (rec.probed && rec.loneFirstMessage && !rec.cursor) {
      hi = 1;
    } else if (hint > TAIL_PROBE_START) {
      // Resume near the cached cursor and gallop forward from it.
      const start = Math.floor(hint * TAIL_HINT_FRACTION);
      if (await probe(start)) {
        lo = start;
        let step = TAIL_PROBE_START;
        while (await probe(lo + step)) {
          lo += step;
          step *= 2;
        }
        hi = lo + step;
      } else hi = start;
    } else {
      let p = TAIL_PROBE_START;
      while (await probe(p)) {
        lo = p;
        p *= 2;
      }
      hi = p;
    }
    if (hi > 1) {
      while (hi - lo > TAIL_WINDOW && hi > MESSAGES_PAGE_LIMIT) {
        const mid = Math.floor((lo + hi) / 2);
        if (await probe(mid)) lo = mid;
        else hi = mid;
      }
    }
    const start = Math.max(0, hi - MESSAGES_PAGE_LIMIT);
    const page = await this.client.listMessages(
      rec.id,
      { offset: start, limit: MESSAGES_PAGE_LIMIT },
      priority,
    );
    const items = [...(page?.data ?? [])];
    let more = !!page?.hasMore;
    for (let i = 0; more && items.length > 0 && i < MAX_DRAIN_PAGES; i++) {
      const next = await this.client.listMessages(
        rec.id,
        { after: items[items.length - 1].id, limit: MESSAGES_PAGE_LIMIT },
        priority,
      );
      items.push(...(next?.data ?? []));
      more = !!next?.hasMore && (next?.data?.length ?? 0) > 0;
    }

    rec.norm = createNormState({
      harness: rec.norm.harness,
      resolvedModel: rec.api.resolvedModel ?? undefined,
    });
    if (start > 0) this.logs.markTruncated(rec.id);
    this.processItems(rec, items, false);
    rec.tailed = true;
    rec.pollSoon = false;
    rec.lastPollAt = this.clock.now();
    if (items.length === 0 && !rec.api.model && !rec.api.resolvedModel) rec.neverStarted = true;
    this.consolidate(rec);
    this.upsertInfo(rec);
  }

  // ── Steady polling ──

  private async pollMessages(rec: SessionRecord, priority: number): Promise<void> {
    if (!rec.cursor && !rec.tailed) {
      await this.syncTail(rec, priority);
      return;
    }
    const now = this.clock.now();
    const allowedGap = Math.max(STEADY_POLL_GAP_MS, rec.plannedIntervalMs * 2);
    const steady = rec.lastPollAt !== undefined && now - rec.lastPollAt <= allowedGap;
    const items: ConductorItem[] = [];
    // No cursor after a tail sync means the feed was empty: read it from the start.
    let after = rec.cursor?.lastId;
    let more = false;
    for (let pages = 0; pages < MAX_DRAIN_PAGES; pages++) {
      let page;
      try {
        page = await this.client.listMessages(
          rec.id,
          after === undefined
            ? { offset: 0, limit: MESSAGES_PAGE_LIMIT }
            : { after, limit: MESSAGES_PAGE_LIMIT },
          priority,
        );
      } catch (err) {
        if (
          err instanceof ConductorApiError &&
          err.kind === 'notFound' &&
          /cursor/i.test(err.apiMessage ?? '')
        ) {
          // The cursor item is gone from this feed: find the tail again.
          this.log(`cursor lost for ${rec.id.slice(0, 8)}; re-probing the tail`);
          rec.cursor = undefined;
          await this.syncTail(rec, priority);
          return;
        }
        throw err;
      }
      const data = page?.data ?? [];
      if (steady) this.processItems(rec, data, true);
      else items.push(...data);
      if (data.length > 0) after = data[data.length - 1].id;
      more = !!page?.hasMore && data.length > 0;
      if (!more) break;
    }
    if (more) {
      await this.syncTail(rec, priority);
      return;
    }
    if (!steady && items.length > 0) this.processItems(rec, items, false);
    this.consolidate(rec);
    rec.pollSoon = false;
    rec.lastPollAt = this.clock.now();
    this.upsertInfo(rec);
  }

  private async pollStatus(rec: SessionRecord, priority: number): Promise<void> {
    const status = await this.fetchStatus(rec, priority);
    if (!status || !rec.adopted) return;
    await this.reconcile(rec, status, priority);
  }

  /**
   * `/status` is a reconciler, not the source: it closes turns the feed never
   * closed (cancelled Codex turns, missed idles) and flags errors.
   */
  private async reconcile(
    rec: SessionRecord,
    status: ConductorSessionStatus,
    priority: number,
  ): Promise<void> {
    const norm = rec.norm;
    const now = this.clock.now();
    const newError =
      !!status.lastErrorAt &&
      status.lastErrorAt !== rec.lastErrorAt &&
      (parseTime(status.lastErrorAt) ?? 0) > (norm.turnStartedAt ?? 0);
    const hadErrorAt = rec.lastErrorAt !== undefined;
    rec.lastErrorAt = status.lastErrorAt ?? rec.lastErrorAt;

    const mismatch =
      (status.status === 'idle' && this.believesActive(norm)) ||
      (status.status === 'working' && !norm.turnOpen);
    if (mismatch && (rec.lastPollAt ?? 0) < now - FOCUS_POLL_MS) {
      // The feed may simply be a poll behind.
      await this.pollMessages(rec, priority);
    }
    const out: ProviderEvent[] = [];
    if (status.status === 'error' || (newError && hadErrorAt && status.status !== 'working')) {
      if (rec.mirror?.status !== 'error') {
        endTurn(norm, 'error', status.errorMessage ?? status.lastError ?? 'Session error', out);
      }
    } else if (status.status === 'idle' && this.believesActive(norm)) {
      const starting =
        norm.lastItemType === 'userMessage' && now - (norm.lastItemAt ?? 0) < STARTING_GRACE_MS;
      const planPending = norm.harness === 'claude' && norm.permissionPending;
      if (!starting && !planPending) endTurn(norm, 'done', undefined, out);
    } else if (status.status === 'working' && !norm.turnOpen) {
      startTurn(norm, now, out);
    }
    this.route(rec, out, now, true);
    this.consolidate(rec);
  }

  // ── Feed processing ──

  /** Normalize items in order; `live` routes events to the office as they come. */
  private processItems(rec: SessionRecord, items: ConductorItem[], live: boolean): void {
    const now = this.clock.now();
    for (const item of items) {
      if (!item?.id) continue;
      const at = itemTime(item);
      const isLive = live && now - at <= LIVE_WINDOW_MS;
      const events = normalizeItem(item, rec.norm);
      this.route(rec, events, at, live, isLive);
      this.applyLinks(this.links.observe(rec.id, item, { live: isLive }), isLive);
      rec.cursor = {
        lastId: item.id,
        lastIndex: Math.max(item.sessionIndex ?? 0, rec.cursor?.lastIndex ?? 0),
      };
      if (item.sessionIndex === 1 && item.type === 'userMessage') {
        const sender = asString(item.content.senderSessionId);
        rec.firstSender = sender && sender !== rec.id ? sender : null;
        rec.probed = true;
        rec.spawnLinkEmitted = true;
      }
    }
    if (items.length > 0) {
      this.state.patchSession(rec.id, {
        cursor: rec.cursor,
        harness: rec.norm.harness,
        firstSender: rec.firstSender,
        lastActivityAt: rec.norm.lastItemAt,
      });
    }
  }

  /**
   * Log entries always go to the Pokédex. Agent events reach the office only
   * when `emit` is set (steady polls, reconciliation); notices only when live.
   */
  private route(
    rec: SessionRecord,
    events: ProviderEvent[],
    at: number,
    emit: boolean,
    live = true,
  ): void {
    for (const event of events) {
      if (event.kind === 'log') {
        if (event.sessionIndex === 1 && event.role === 'user')
          this.logs.setPrompt(rec.id, event.text);
        if (event.role === 'user' && event.senderSessionId) {
          this.logs.addPeer(
            rec.id,
            'peerIn',
            event.senderSessionId,
            event.text,
            event.at,
            event.itemId,
          );
        } else if (event.role === 'user') {
          this.logs.addUser(rec.id, event.text, event.at, event.itemId);
        } else if (event.role === 'assistant') {
          this.logs.addAssistant(rec.id, event.text, event.at, event.itemId);
        }
        continue;
      }
      if (event.kind === 'toolStart') {
        this.logs.addTool(
          rec.id,
          formatConductorToolStatus(event.toolName, event.input),
          at,
          `tool:${event.toolId}`,
        );
      }
      if (!emit) continue;
      if (event.kind === 'notice' && !live) continue;
      this.emitToSink(rec, event);
    }
  }

  private applyLinks(obs: LinkObservation, live: boolean): void {
    for (const { event, edge } of obs.emit) {
      this.sink.link(event);
      if (event.kind !== 'watched') {
        this.logs.addPeer(
          event.fromSessionId,
          'peerOut',
          event.toSessionId,
          event.preview ?? '',
          event.at,
          edge.messageId ?? edge.key,
        );
        if (live) this.promote(event.toSessionId);
      }
    }
    for (const edge of obs.previewUpdates) {
      if (edge.to && edge.preview) {
        this.logs.addPeer(
          edge.from,
          'peerOut',
          edge.to,
          edge.preview,
          edge.at,
          edge.messageId ?? edge.key,
        );
      }
    }
  }

  private noteActivity(rec: SessionRecord, at: number): void {
    if (!at) return;
    if (!rec.norm.lastItemAt || at > rec.norm.lastItemAt) rec.norm.lastItemAt = at;
  }

  // ── Office state ──

  private emitToSink(rec: SessionRecord, event: AgentEvent): void {
    if (!rec.adopted || !rec.mirror) return;
    const m = rec.mirror;
    switch (event.kind) {
      case 'turnStart':
        if (m.status === 'active' && !m.awaiting) return;
        this.clearForeground(m);
        m.status = 'active';
        m.awaiting = false;
        m.permission = false;
        break;
      case 'turnEnd': {
        const target: SeedStatus = event.outcome === 'error' ? 'error' : 'waiting';
        const hasForeground = [...m.tools.values()].some((t) => !survivesTurnEnd(t));
        if (m.status === target && !m.awaiting && !m.permission && !hasForeground) return;
        this.clearForeground(m);
        m.status = target;
        m.awaiting = false;
        m.permission = false;
        break;
      }
      case 'toolStart':
        m.tools.set(event.toolId, {
          name: event.toolName,
          runInBackground: !!event.runInBackground,
        });
        break;
      case 'toolEnd':
        if (!m.tools.has(event.toolId)) return;
        m.tools.delete(event.toolId);
        for (const [sub, parent] of [...m.subTools])
          if (parent === event.toolId) m.subTools.delete(sub);
        break;
      case 'subagentStart':
        m.subTools.set(event.toolId, event.parentToolId);
        break;
      case 'subagentEnd':
        if (!m.subTools.has(event.toolId)) return;
        m.subTools.delete(event.toolId);
        break;
      case 'awaitingInput':
        if (m.awaiting) return;
        m.awaiting = true;
        break;
      case 'permissionRequest':
        if (m.permission) return;
        m.permission = true;
        break;
      case 'permissionClear':
        if (!m.permission) return;
        m.permission = false;
        break;
      case 'contextUsage':
        m.usage = { tokens: event.tokens, window: event.window };
        break;
      default:
        break;
    }
    this.sink.emit(rec.id, event);
  }

  private clearForeground(m: SinkMirror): void {
    for (const [id, tool] of [...m.tools]) {
      if (survivesTurnEnd(tool)) continue;
      m.tools.delete(id);
      for (const [sub, parent] of [...m.subTools]) if (parent === id) m.subTools.delete(sub);
    }
  }

  /** Emit whatever separates the office's view from the reconstructed state. */
  private consolidate(rec: SessionRecord): void {
    if (!rec.adopted || !rec.mirror) return;
    const n = rec.norm;
    const m = rec.mirror;
    if (n.turnOpen) {
      if (m.status !== 'active' || (m.awaiting && !n.awaiting))
        this.emitToSink(rec, { kind: 'turnStart' });
    } else {
      const outcome = n.lastOutcome?.outcome ?? 'done';
      const target: SeedStatus = outcome === 'error' ? 'error' : 'waiting';
      const hasForeground = [...m.tools.values()].some((t) => !survivesTurnEnd(t));
      if (m.status !== target || m.awaiting || m.permission || hasForeground) {
        const event: TurnEndEvent = { kind: 'turnEnd', outcome };
        if (outcome === 'error' && n.lastOutcome?.errorMessage)
          event.errorMessage = n.lastOutcome.errorMessage;
        this.emitToSink(rec, event);
      }
    }
    for (const toolId of [...m.tools.keys()]) {
      if (!n.openTools.has(toolId)) this.emitToSink(rec, { kind: 'toolEnd', toolId });
    }
    for (const [toolId, tool] of n.openTools) {
      const shown = m.tools.get(toolId);
      if (shown && shown.runInBackground === !!tool.runInBackground) continue;
      const event: ToolStartEvent = {
        kind: 'toolStart',
        toolId,
        toolName: tool.name,
        input: tool.input,
      };
      if (tool.runInBackground) event.runInBackground = true;
      this.emitToSink(rec, event);
    }
    for (const [subId, parent] of [...m.subTools]) {
      if (!n.openSubTools.has(subId))
        this.emitToSink(rec, { kind: 'subagentEnd', parentToolId: parent, toolId: subId });
    }
    for (const [subId, sub] of n.openSubTools) {
      if (m.subTools.has(subId) || !m.tools.has(sub.parentToolId)) continue;
      this.emitToSink(rec, {
        kind: 'subagentStart',
        parentToolId: sub.parentToolId,
        toolId: subId,
        toolName: sub.name,
        input: sub.input,
      });
    }
    if (n.awaiting && !m.awaiting) this.emitToSink(rec, { kind: 'awaitingInput' });
    if (n.permissionPending && !m.permission) this.emitToSink(rec, { kind: 'permissionRequest' });
    if (!n.permissionPending && m.permission) this.emitToSink(rec, { kind: 'permissionClear' });
    const usage = n.lastUsage;
    if (usage && (m.usage?.tokens !== usage.tokens || m.usage?.window !== usage.window)) {
      const event: ContextUsageEvent = { kind: 'contextUsage', tokens: usage.tokens };
      if (usage.model) event.model = usage.model;
      if (usage.window) event.window = usage.window;
      this.emitToSink(rec, event);
    }
  }

  private believesActive(norm: NormState): boolean {
    return norm.turnOpen || norm.awaiting || norm.permissionPending;
  }

  /** Status used for seeding, ranking and the Sessions modal. */
  private seedStatus(rec: SessionRecord): { status: SeedStatus; errorMessage?: string } {
    if (rec.tailed) {
      if (rec.norm.turnOpen) return { status: 'active' };
      if (rec.norm.lastOutcome?.outcome === 'error') {
        return { status: 'error', errorMessage: rec.norm.lastOutcome.errorMessage };
      }
      return { status: 'waiting' };
    }
    if (rec.runStatus === 'error') return { status: 'error', errorMessage: rec.statusMessage };
    if (rec.runStatus === 'working' || rec.loneFirstMessage) return { status: 'active' };
    return { status: 'waiting' };
  }

  private summaryStatus(rec: SessionRecord): SummaryStatus {
    const seed = this.seedStatus(rec);
    return seed.status === 'active' ? 'working' : seed.status === 'error' ? 'error' : 'idle';
  }

  private activityOf(rec: SessionRecord): number {
    return (
      rec.norm.lastItemAt ??
      this.state.session(rec.id)?.lastActivityAt ??
      this.workspaces.get(rec.workspaceId)?.lastActivityMs ??
      0
    );
  }

  private tierOf(rec: SessionRecord, now: number, focus: Set<string>): Tier {
    if (focus.has(rec.id)) return 'focus';
    const active = rec.tailed
      ? this.believesActive(rec.norm)
      : this.seedStatus(rec).status === 'active';
    const activity = this.activityOf(rec);
    if (active || now - activity < HOT_RECENT_MS || (rec.promotedUntil ?? 0) > now) return 'hot';
    if (now - activity < WARM_RECENT_MS) return 'warm';
    const ws = this.workspaces.get(rec.workspaceId);
    if (ws?.ws.state === 'ready' && now - activity < WARM_READY_WORKSPACE_MS) return 'warm';
    return 'cold';
  }

  // ── Scope, cap and adoption ──

  /** In scope and not hidden/never-started (tiers and polling apply). */
  private isCandidate(rec: SessionRecord, now: number): boolean {
    return this.inScope(rec, now) && !this.state.session(rec.id)?.hidden;
  }

  private inScope(rec: SessionRecord, now: number): boolean {
    if (rec.neverStarted) return false;
    if (this.state.session(rec.id)?.pinned) return true;
    const ws = this.workspaces.get(rec.workspaceId);
    if (!ws?.discovered) return false;
    const scope = this.state.scope;
    if (scope.creator === 'me' && ws.ws.creatorId && ws.ws.creatorId !== this.me.userId)
      return false;
    const windowStart = now - scope.activeWithinHours * 3_600_000;
    if (ws.lastActivityMs && ws.lastActivityMs < windowStart) return false;
    const own = rec.norm.lastItemAt ?? this.state.session(rec.id)?.lastActivityAt;
    return own === undefined || own >= windowStart;
  }

  private refreshVisibility(): void {
    if (this.stopped) return;
    const now = this.clock.now();
    const scope = this.state.scope;
    const hysteresis = this.capReset ? 0 : CAP_HYSTERESIS;
    this.capReset = false;
    const candidates = [...this.records.values()].filter(
      (rec) => rec.onboarded && this.isCandidate(rec, now),
    );
    const pinned = (rec: SessionRecord) => !!this.state.session(rec.id)?.pinned;
    const seeds = new Map(candidates.map((rec) => [rec.id, this.seedStatus(rec).status]));
    const isActiveChild = (rec: SessionRecord) => {
      const seed = seeds.get(rec.id);
      return seed === 'active' || rec.norm.awaiting || rec.norm.permissionPending;
    };
    const childrenOf = new Map<string, SessionRecord[]>();
    for (const rec of candidates) {
      if (!rec.firstSender) continue;
      const list = childrenOf.get(rec.firstSender) ?? [];
      list.push(rec);
      childrenOf.set(rec.firstSender, list);
    }
    const bucket = (rec: SessionRecord): number => {
      if (pinned(rec)) return 0;
      if (rec.norm.awaiting || rec.norm.permissionPending) return 1;
      const seed = seeds.get(rec.id);
      if (seed === 'active') return 2;
      if (seed === 'error') return 3;
      if ((childrenOf.get(rec.id) ?? []).some(isActiveChild)) return 4;
      return 5;
    };
    let eligible = candidates;
    if (!scope.showIdle) eligible = eligible.filter((rec) => pinned(rec) || bucket(rec) <= 4);
    const ranked = [...eligible].sort(
      (a, b) =>
        bucket(a) - bucket(b) ||
        this.activityOf(b) - this.activityOf(a) ||
        a.firstSeen - b.firstSeen,
    );
    // At most 12 children per Lead are shown; the rest stay in the Sessions modal.
    const perLead = new Map<string, number>();
    const capped = ranked.filter((rec) => {
      if (!rec.firstSender || pinned(rec) || !this.records.has(rec.firstSender)) return true;
      const n = perLead.get(rec.firstSender) ?? 0;
      perLead.set(rec.firstSender, n + 1);
      return n < MAX_CHILDREN_PER_LEAD;
    });
    // Pinned sessions are always shown; the rest fill the cap in rank order. A
    // shown session keeps its place until it falls CAP_HYSTERESIS past the cap.
    const visible = new Set<string>();
    const pinnedShown = capped.filter(pinned);
    for (const rec of pinnedShown) visible.add(rec.id);
    const slots = Math.max(0, scope.maxSessions - pinnedShown.length);
    let rank = 0;
    for (const rec of capped) {
      if (pinned(rec)) continue;
      if (rank < slots || (rec.adopted && rank < slots + hysteresis)) visible.add(rec.id);
      rank++;
    }

    for (const rec of this.records.values()) {
      if (rec.adopted && !visible.has(rec.id)) {
        this.unadopt(rec, this.state.session(rec.id)?.hidden ? 'hidden' : 'scope');
      }
    }
    for (const rec of capped) {
      if (visible.has(rec.id) && !rec.adopted) this.adopt(rec);
    }
    this.scheduleSessionsChanged();
  }

  private adopt(rec: SessionRecord): void {
    const seed = this.seedStatus(rec);
    const info = this.buildInfo(rec);
    info.initialStatus = seed.status;
    if (seed.status === 'error' && seed.errorMessage) info.errorMessage = seed.errorMessage;
    rec.adopted = true;
    rec.mirror = emptyMirror(seed.status);
    this.sink.upsertSession(info);
    rec.infoSig = this.infoSignature(info);
    rec.detailsSig = this.detailsSignature(info);
    rec.detailsAt = this.clock.now();
    this.consolidate(rec);
    // Children adopted before their Lead learn it now.
    for (const child of this.records.values()) {
      if (child.adopted && child.firstSender === rec.id) this.upsertInfo(child);
    }
  }

  private unadopt(rec: SessionRecord, reason: string): void {
    if (!rec.adopted) return;
    rec.adopted = false;
    rec.mirror = undefined;
    rec.infoSig = undefined;
    rec.detailsSig = undefined;
    this.sink.removeSession(rec.id, reason);
    for (const child of this.records.values()) {
      if (child.adopted && child.firstSender === rec.id) this.upsertInfo(child);
    }
  }

  private dropRecord(rec: SessionRecord, reason: string): void {
    this.unadopt(rec, reason);
    this.records.delete(rec.id);
  }

  private buildInfo(rec: SessionRecord): StreamSessionInfo {
    const wsRec = this.workspaces.get(rec.workspaceId);
    const ws = wsRec?.ws;
    const lead = rec.firstSender ? this.records.get(rec.firstSender) : undefined;
    const details: StreamSessionInfo['details'] = {};
    if (rec.api.deepLink) details.externalUrl = rec.api.deepLink;
    const model = rec.api.resolvedModel ?? rec.api.model ?? rec.norm.model;
    if (model) details.model = model;
    if (rec.norm.harness) details.harness = rec.norm.harness;
    details.workspaceId = rec.workspaceId;
    if (ws?.name) details.workspaceName = ws.name;
    if (typeof ws?.number === 'number') details.workspaceNumber = ws.number;
    const slug = repoSlug(ws?.repoUrl);
    if (slug) details.repo = slug;
    if (ws?.creatorName) details.creatorName = ws.creatorName;
    const count = rec.norm.lastIndex ?? rec.cursor?.lastIndex;
    if (count) details.messageCount = count;
    const activity = rec.norm.lastItemAt ?? this.state.session(rec.id)?.lastActivityAt;
    if (activity) details.lastActivityAt = activity;
    const info: StreamSessionInfo = {
      sessionId: rec.id,
      label: sessionLabel(rec.api, ws),
      details,
    };
    const dir = repoShortName(ws?.repoUrl);
    if (dir) info.directoryName = dir;
    if (lead?.adopted) info.leadSessionId = lead.id;
    return info;
  }

  /** Everything but the activity counters, which are throttled separately. */
  private infoSignature(info: StreamSessionInfo): string {
    const details = { ...info.details };
    delete details.messageCount;
    delete details.lastActivityAt;
    return JSON.stringify([info.label, info.directoryName, info.leadSessionId, details]);
  }

  private detailsSignature(info: StreamSessionInfo): string {
    return JSON.stringify([info.details?.messageCount, info.details?.lastActivityAt]);
  }

  /** Re-send session facts when they changed (activity counters at most every 10 s). */
  private upsertInfo(rec: SessionRecord, forceDetails = false): void {
    if (!rec.adopted) return;
    const info = this.buildInfo(rec);
    const sig = this.infoSignature(info);
    const detailsSig = this.detailsSignature(info);
    const now = this.clock.now();
    const detailsDue =
      detailsSig !== rec.detailsSig &&
      (forceDetails || now - (rec.detailsAt ?? 0) >= DETAILS_THROTTLE_MS);
    if (sig === rec.infoSig && !detailsDue) return;
    this.sink.upsertSession(info);
    rec.infoSig = sig;
    rec.detailsSig = detailsSig;
    rec.detailsAt = now;
  }

  private labelFor(sessionId: string): string | undefined {
    const rec = this.records.get(sessionId);
    if (!rec) return undefined;
    return sessionLabel(rec.api, this.workspaces.get(rec.workspaceId)?.ws);
  }

  // ── Status and the Sessions modal ──

  private setConnection(state: ConnectionState, message?: string): void {
    if (this.halted && state !== 'unauthorized') return;
    this.connection = state;
    this.connectionMessage = message;
    this.emitStatus();
  }

  private emitStatus(): void {
    if (this.connection === 'rateLimited' && !this.client.isRateLimited() && this.discoveredOnce) {
      this.connection = 'connected';
      this.connectionMessage = undefined;
    }
    const now = this.clock.now();
    let workspaceCount = 0;
    for (const ws of this.workspaces.values()) if (ws.discovered) workspaceCount++;
    let sessionCount = 0;
    let visibleCount = 0;
    for (const rec of this.records.values()) {
      if (this.inScope(rec, now)) sessionCount++;
      if (rec.adopted) visibleCount++;
    }
    const status = {
      state: this.connection,
      message: this.connectionMessage,
      account: this.me.email,
      workspaceCount,
      sessionCount,
      visibleCount,
      lastSyncAt: this.lastSyncAt,
      scope: this.state.scope,
    };
    const sig = JSON.stringify(status);
    if (sig === this.lastStatusSig) return;
    this.lastStatusSig = sig;
    const clean = Object.fromEntries(
      Object.entries(status).filter(([, value]) => value !== undefined),
    ) as typeof status;
    this.sink.setStatus(clean);
  }

  private summaries(): ConductorSessionSummary[] {
    const now = this.clock.now();
    const out: ConductorSessionSummary[] = [];
    for (const rec of this.records.values()) {
      if (!this.inScope(rec, now)) continue;
      out.push(this.summaryFor(rec.id, rec.api, rec.workspaceId, rec));
    }
    for (const [id, entry] of this.archived) {
      if (this.records.has(id)) continue;
      const ws = this.workspaces.get(entry.workspaceId);
      if (!ws?.discovered && !this.state.session(id)?.pinned) continue;
      out.push(this.summaryFor(id, entry.session, entry.workspaceId));
    }
    out.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    return out;
  }

  private summaryFor(
    id: string,
    session: ConductorSession,
    workspaceId: string,
    rec?: SessionRecord,
  ): ConductorSessionSummary {
    const ws = this.workspaces.get(workspaceId)?.ws;
    const persisted = this.state.session(id);
    const summary: ConductorSessionSummary = {
      sessionId: id,
      label: sessionLabel(session, ws),
      workspaceId,
      workspaceName: ws?.name ?? '',
      status: rec ? this.summaryStatus(rec) : 'idle',
      hidden: !!persisted?.hidden,
    };
    if (typeof ws?.number === 'number') summary.workspaceNumber = ws.number;
    const slug = repoSlug(ws?.repoUrl);
    if (slug) summary.repo = slug;
    const model = session.resolvedModel ?? session.model ?? rec?.norm.model;
    if (model) summary.model = model;
    const harness = rec?.norm.harness ?? harnessFromModel(model);
    if (harness) summary.harness = harness;
    const activity = rec ? this.activityOf(rec) : persisted?.lastActivityAt;
    if (activity) summary.lastActivityAt = activity;
    if (persisted?.pinned) summary.pinned = true;
    if (session.archivedAt) {
      summary.archived = true;
      const archivedAt = parseTime(session.archivedAt);
      if (archivedAt) summary.archivedAt = archivedAt;
    }
    if (persisted?.agentId) summary.agentId = persisted.agentId;
    const lead = rec?.firstSender ?? persisted?.firstSender;
    if (lead) summary.leadSessionId = lead;
    if (session.deepLink) summary.externalUrl = session.deepLink;
    if (ws?.creatorName) summary.creatorName = ws.creatorName;
    return summary;
  }

  private scheduleSessionsChanged(): void {
    if (this.sessionsTimer || this.stopped) return;
    if (!this.autoTick) {
      this.flushSessionsChanged();
      return;
    }
    this.sessionsTimer = setTimeout(() => {
      this.sessionsTimer = undefined;
      this.flushSessionsChanged();
    }, SESSIONS_CHANGED_DEBOUNCE_MS);
    this.sessionsTimer.unref?.();
  }

  /** Membership and flags go out at once; activity times alone at most every 10 s. */
  private flushSessionsChanged(): void {
    const sessions = this.summaries();
    const sig = JSON.stringify(sessions);
    if (sig === this.lastSessionsSig) return;
    const core = JSON.stringify(sessions.map((s) => ({ ...s, lastActivityAt: undefined })));
    const now = this.clock.now();
    if (core === this.lastSessionsCoreSig && now - this.lastSessionsAt < DETAILS_THROTTLE_MS)
      return;
    this.lastSessionsSig = sig;
    this.lastSessionsCoreSig = core;
    this.lastSessionsAt = now;
    this.sink.sessionsChanged(sessions);
  }

  // ── Helpers ──

  private async mapLimit<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const item = items[next++];
        await fn(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }
}
