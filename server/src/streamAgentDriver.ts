/**
 * StreamAgentDriver: the runtime side of a stream provider (Conductor).
 *
 * A stream provider polls or listens to an external service and pushes what it
 * learns through the AgentEventSink it was started with. This class is that
 * sink: it turns sessions into agents, canonical AgentEvents into store
 * mutations, and links between sessions into team info and link broadcasts.
 * It mirrors the broadcast shapes the transcript and hook paths already send,
 * so the office renders a stream agent exactly like any other.
 *
 * Stream agents are hooks-only external agents: no transcript file, no
 * heuristic timers, no scanners. Their session key is namespaced
 * (`<providerId>:<sessionId>`), so no Claude hook event can ever resolve to one.
 */

import type { AgentLink, ConductorSessionSummary } from '../../core/src/messages.js';
import type {
  AgentEvent,
  AgentEventSink,
  AgentLinkEvent,
  StreamProvider,
  StreamProviderStatus,
  StreamSessionDetails,
  StreamSessionInfo,
} from '../../core/src/provider.js';
import { agentDetailsMessage } from './agentMessages.js';
import { createAgentState } from './agentState.js';
import type { AgentStateStore } from './agentStateStore.js';
import { endAgentTurn, markAgentWaiting, type TransitionDeps } from './agentTransitions.js';
import {
  AGENT_ERROR_MESSAGE_MAX_LENGTH,
  AGENT_MESSAGE_MAX_PER_SECOND,
  AGENT_MESSAGE_PAIR_INTERVAL_MS,
  STREAM_AGENT_MEMORY_MAX,
  STREAM_LINKS_MAX,
  STREAM_SNAPSHOT_DEBOUNCE_MS,
  STREAM_SPECIES_LOAD_TIMEOUT_MS,
  STREAM_TEXT_MAX_LENGTH,
  STREAM_TURN_MIN_ACTIVE_MS,
  TOOL_DONE_DELAY_MS,
} from './constants.js';
import { reportContextUsage, widenContextWindow } from './contextUsage.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import { ensureSpeciesLoaded } from './pokemon/pokemonAssets.js';
import {
  assignSpeciesIfNeeded,
  choosePokemon,
  type PokemonChoice,
  promoteToOrchestrator,
  restoredPokemonFields,
  updateLevel,
} from './pokemon/speciesAssigner.js';
import type { SilentSeedSink } from './providers/stream/silentSeed.js';
import { clearAgentActivity } from './timerManager.js';
import type { AgentState } from './types.js';

type Send = (message: Record<string, unknown>) => void;

/** What the driver remembers about a session across restarts, so it comes back
 *  as the same agent (same seat) and the same Pokémon. */
export interface StreamAgentRecord {
  agentId: number;
  pokemonLine?: string;
  species?: number;
  shiny?: boolean;
  /** The user chose this Pokémon (Change Pokémon). */
  pokemonChosen?: boolean;
  /** The automatic line and shiny flag the choice replaced (for the reset). */
  pokemonAutoLine?: string;
  pokemonAutoShiny?: boolean;
}

/** Durable home for StreamAgentRecords, keyed by the namespaced session key
 *  (`conductor:<uuid>`). FileStateAdapter implements it. */
export interface StreamAgentMemory {
  loadStreamAgents(): ReadonlyMap<string, StreamAgentRecord>;
  saveStreamAgent(key: string, record: StreamAgentRecord): void;
}

/** The slice of AgentRuntime the driver drives. */
export interface StreamDriverRuntime {
  readonly waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  readonly permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  registerAgent(sessionKey: string, agentId: number): void;
  unregisterAgent(sessionKey: string): void;
  removeAgent(agentId: number): void;
}

export interface StreamAgentDriverOptions {
  store: AgentStateStore;
  runtime: StreamDriverRuntime;
  provider: StreamProvider;
  /** Remembers agent ids and Pokémon per session. Without it, ids are only
   *  stable for the life of the process. */
  memory?: StreamAgentMemory;
}

/** Last status broadcast for an agent, for dedupe. Errors key on their message. */
type StatusKey = 'active' | 'waiting' | 'input' | `error:${string}`;

interface LinkRecord {
  fromSessionId: string;
  toSessionId: string;
  kind: AgentLink['kind'];
  count: number;
  lastAt: number;
  preview?: string;
}

const LINK_KINDS: ReadonlySet<string> = new Set(['spawned', 'messaged', 'watched']);
const NO_TEAM_KEY = '{}';
const ONE_SECOND_MS = 1_000;

export class StreamAgentDriver implements AgentEventSink, SilentSeedSink {
  private readonly store: AgentStateStore;
  private readonly runtime: StreamDriverRuntime;
  readonly provider: StreamProvider;
  private readonly memoryStore: StreamAgentMemory | undefined;
  private readonly remembered: Map<string, StreamAgentRecord>;

  private readonly agentIdBySession = new Map<string, number>();
  private readonly sessionByAgent = new Map<number, string>();
  /** Lead named by upsertSession, per session (absent = not stated). */
  private readonly statedLead = new Map<string, string>();
  /** Lead from the first `spawned` link into a session. */
  private readonly spawnedBy = new Map<string, string>();
  /** Sessions whose spawned link is a handoff (Switch model): linked to the
   *  session they continue and thrown out of it, but they don't make it a
   *  Lead (it did not delegate, the user continued its work). */
  private readonly handoffs = new Set<string>();
  private readonly statusOf = new Map<number, StatusKey>();
  private readonly teamKeyOf = new Map<number, string>();
  private readonly detailsJsonOf = new Map<number, string>();
  /** Agents whose new species is still loading: their agentDetails waits for it. */
  private readonly speciesLoading = new Set<number>();
  /** Sessions being seeded (seedSilently): their statuses are not news. */
  private readonly seeding = new Set<string>();
  /** When each agent last went active (for the minimum visible burst). */
  private readonly activeSince = new Map<number, number>();
  /** A turn end held back until the agent has been seen working. */
  private readonly pendingTurnEnd = new Map<
    number,
    { event: Extract<AgentEvent, { kind: 'turnEnd' }>; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly links = new Map<string, LinkRecord>();
  private readonly lastMessageAt = new Map<string, number>();
  private recentMessageTimes: number[] = [];

  private status: Record<string, unknown> | null = null;
  private statusJson: string | null = null;
  private sessions: ConductorSessionSummary[] | null = null;
  private sessionsJson: string | null = null;
  private linksJson: string | null = null;

  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly onAgentRemoved = (id: number): void => this.forgetAgent(id);

  constructor(options: StreamAgentDriverOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.provider = options.provider;
    this.memoryStore = options.memory;
    this.remembered = new Map(options.memory?.loadStreamAgents() ?? []);
    // Reserved ids stay reserved: a new Claude agent must never take the id a
    // session had last run (seats are keyed by agent id).
    let maxReserved = 0;
    for (const record of this.remembered.values()) {
      if (Number.isSafeInteger(record.agentId) && record.agentId > maxReserved) {
        maxReserved = record.agentId;
      }
    }
    if (maxReserved >= this.store.nextAgentId.current) {
      this.store.nextAgentId.current = maxReserved + 1;
    }
    this.store.on('agentRemoved', this.onAgentRemoved);
  }

  // ── Lookups (client messages, runtime) ──────────────────────

  /** Whether this driver created the agent. */
  owns(agentId: number): boolean {
    return this.sessionByAgent.has(agentId);
  }

  /** Provider session id behind an agent this driver owns. */
  sessionIdFor(agentId: number): string | undefined {
    return this.sessionByAgent.get(agentId);
  }

  /** Agent id of a session currently in the office. */
  agentIdFor(sessionId: string): number | undefined {
    return this.agentIdBySession.get(sessionId);
  }

  /** The user dismissed the agent: tell the provider so it hides the session
   *  instead of re-adopting it on the next poll. */
  dismiss(agentId: number): void {
    const sessionId = this.sessionByAgent.get(agentId);
    if (sessionId === undefined) return;
    try {
      this.provider.onDismiss?.(sessionId);
    } catch (err) {
      this.logFailure('onDismiss', err);
    }
  }

  /**
   * Change Pokémon for an agent this driver owns (the choice was validated by
   * the caller): apply it, remember it with the session (so it survives a
   * restart), and announce the new species once its sprites load, which plays
   * the evolution flash. Returns false when nothing changed.
   */
  setAgentPokemon(agentId: number, choice: PokemonChoice): boolean {
    const sessionId = this.sessionByAgent.get(agentId);
    const agent = this.store.get(agentId);
    if (sessionId === undefined || !agent) return false;
    const changed = choosePokemon(agent, this.store, choice, {
      stableKey: sessionId,
      orchestrator: agent.isTeamLead === true,
    });
    if (changed) this.speciesChanged(agentId, agent);
    return changed;
  }

  /** Agent ids of every session this driver remembers, in the office or not:
   *  their saved seats outlive their absence (hidden, out of scope, archived,
   *  not adopted yet after a restart) and go when the memory forgets them. */
  rememberedAgentIds(): Set<number> {
    return new Set([...this.remembered.values()].map((record) => record.agentId));
  }

  /** The last conductorStatus broadcast, for a client that needs the truth again. */
  statusMessage(): Record<string, unknown> | null {
    return this.status;
  }

  /** The session list as last pushed by the provider, without asking it again:
   *  for answers that must not change what the provider polls (a refused
   *  read-only toggle). */
  cachedSessionsSnapshot(): ConductorSessionSummary[] {
    return this.withAgentIds(this.sessions ?? []);
  }

  /** Every session in scope, with agent ids filled in for those in the office. */
  sessionsSnapshot(): ConductorSessionSummary[] {
    let list: ConductorSessionSummary[] | null = null;
    try {
      list = this.provider.listSessions?.() ?? null;
    } catch (err) {
      this.logFailure('listSessions', err);
    }
    return this.withAgentIds(list ?? this.sessions ?? []);
  }

  /** Replay cached provider state to one connecting client, after the agents
   *  themselves were announced (resendAgentActivity). */
  replayTo(send: Send): void {
    if (this.status) send(this.status);
    if (this.sessions) {
      send({ type: 'conductorSessions', sessions: this.withAgentIds(this.sessions) });
    }
    send({ type: 'agentLinks', links: this.linksSnapshot() });
    for (const [id, key] of this.statusOf) {
      // resendAgentActivity replays waiting/error; only the awaiting-input
      // flavour and an open permission are this driver's to add.
      if (key === 'input') {
        send({ type: 'agentStatus', id, status: 'waiting', awaitingInput: true, silent: true });
      }
      if (this.store.get(id)?.permissionSent) send({ type: 'agentToolPermission', id });
    }
  }

  // ── AgentEventSink ──────────────────────────────────────────

  upsertSession(info: StreamSessionInfo): void {
    this.guard('upsertSession', () => {
      if (!isSessionId(info?.sessionId)) return;
      const sessionId = info.sessionId;
      const previousLead = this.leadSessionOf(sessionId);
      if (isSessionId(info.leadSessionId) && info.leadSessionId !== sessionId) {
        this.statedLead.set(sessionId, info.leadSessionId);
        // The provider said who spawned this session: that is a spawned link,
        // whether or not it also reports one.
        if (!this.hasLink(info.leadSessionId, sessionId, 'spawned')) {
          this.recordLink(info.leadSessionId, sessionId, 'spawned', Date.now(), undefined);
        }
      }
      const id = this.agentIdBySession.get(sessionId);
      if (id === undefined) {
        this.adopt(info);
      } else {
        this.update(id, info, previousLead !== this.leadSessionOf(sessionId));
      }
    });
  }

  emit(sessionId: string, event: AgentEvent): void {
    this.guard('emit', () => {
      const id = this.agentIdBySession.get(sessionId);
      if (id === undefined) return;
      const agent = this.store.get(id);
      if (!agent || !event) return;
      agent.lastDataAt = Date.now();
      this.settlePendingTurnEnd(id, agent, event.kind);
      switch (event.kind) {
        case 'turnStart':
          return this.turnStart(id, agent);
        case 'toolStart':
          return this.toolStart(id, agent, event);
        case 'toolEnd':
          return this.toolEnd(id, agent, event.toolId);
        case 'subagentStart':
          return this.subagentStart(id, agent, event);
        case 'subagentEnd':
          return this.subagentEnd(id, agent, event.parentToolId, event.toolId);
        case 'permissionRequest':
          return this.permissionRequest(id, agent);
        case 'permissionClear':
          return this.permissionClear(id, agent);
        case 'awaitingInput':
          return this.awaitingInput(id, agent);
        case 'turnEnd':
          return this.turnEnd(id, agent, event);
        case 'contextUsage':
          return this.contextUsage(id, agent, event);
        case 'notice':
          return this.notice(id, event.text, event.tone);
        case 'sessionEnd':
          return this.removeSession(sessionId, event.reason);
        // progress, sessionStart, subagentTurnEnd: adoption is explicit
        // (upsertSession), and the rest carries nothing the office shows.
      }
    });
  }

  link(event: AgentLinkEvent): void {
    this.guard('link', () => {
      const { fromSessionId: from, toSessionId: to, kind } = event ?? ({} as AgentLinkEvent);
      if (!isSessionId(from) || !isSessionId(to) || from === to || !LINK_KINDS.has(kind)) return;
      const at = Number.isFinite(event.at) ? event.at : Date.now();
      const preview = cleanText(event.preview);
      // Before the link: recordLink recomputes teams, which reads it.
      if (kind === 'spawned' && event.handoff === true && !this.spawnedBy.has(to)) {
        this.handoffs.add(to);
      }
      this.recordLink(from, to, kind, at, preview);
      if (event.live) this.animateMessage(from, to, kind, preview, at);
    });
  }

  removeSession(sessionId: string, _reason?: string): void {
    this.guard('removeSession', () => {
      const id = this.agentIdBySession.get(sessionId);
      if (id === undefined) return;
      this.runtime.unregisterAgent(this.key(sessionId));
      if (this.store.has(id)) {
        this.runtime.removeAgent(id); // agentRemoved -> forgetAgent
      } else {
        this.forgetAgent(id);
      }
    });
  }

  setStatus(status: StreamProviderStatus): void {
    this.guard('setStatus', () => {
      const message = { type: 'conductorStatus', ...status };
      const json = JSON.stringify(message);
      if (json === this.statusJson) return;
      this.status = message;
      this.statusJson = json;
      this.store.broadcast(message);
    });
  }

  sessionsChanged(sessions: ConductorSessionSummary[]): void {
    this.guard('sessionsChanged', () => {
      if (!Array.isArray(sessions)) return;
      this.sessions = sessions.slice();
      this.broadcastSessionsIfChanged();
    });
  }

  /**
   * Run a provider's adoption of a session (upsertSession plus what its
   * replayed state adds) with every status it causes broadcast silently: the
   * seed describes the past, so the office neither chimes nor plays turn-end
   * effects for it (SilentSeedSink).
   */
  seedSilently(sessionId: string, run: () => void): void {
    this.seeding.add(sessionId);
    try {
      run();
    } finally {
      this.seeding.delete(sessionId);
    }
  }

  /** Take every session this driver put in the office out of it (its
   *  provider is detaching). Stream memory keeps their ids and Pokémon. */
  removeAllSessions(): void {
    for (const sessionId of [...this.agentIdBySession.keys()]) this.removeSession(sessionId);
  }

  /** Stop timers and listeners. Agents stay in the store (the runtime removes them). */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    this.store.off('agentRemoved', this.onAgentRemoved);
  }

  // ── Sessions → agents ───────────────────────────────────────

  private adopt(info: StreamSessionInfo): void {
    const sessionId = info.sessionId;
    const key = this.key(sessionId);
    const id = this.reserveId(key);
    const remembered = this.remembered.get(key);
    const agent = createAgentState({
      id,
      sessionId: key,
      isExternal: true,
      projectDir: '',
      jsonlFile: '',
      hookDelivered: true,
      hooksOnly: true,
      providerId: this.provider.id,
      directoryName: info.directoryName,
      label: info.label,
      details: mergeDetails(undefined, info.details),
      lastDataAt: Date.now(),
      toolCallCount: 0,
      // Only what the catalog still backs; assignSpeciesIfNeeded fills the rest.
      ...(remembered ? restoredPokemonFields(remembered) : {}),
    });
    this.agentIdBySession.set(sessionId, id);
    this.sessionByAgent.set(id, sessionId);

    // Team fields go on BEFORE store.set: agentCreated is built from the agent
    // at that moment, and isTeammate there is what seats a child by its Lead.
    const team = this.desiredTeam(sessionId, agent.label);
    agent.isTeamLead = team.isTeamLead;
    agent.leadAgentId = team.leadAgentId;
    agent.agentName = team.agentName;
    agent.teamUsesTmux = team.teamUsesTmux;

    // Species first, with the stable key, so the call at the end of
    // assignPaletteIfNeeded finds it already assigned.
    assignSpeciesIfNeeded(agent, this.store, { stableKey: sessionId });
    assignPaletteIfNeeded(agent, this.store);
    if (agent.isTeamLead) promoteToOrchestrator(agent, this.store);
    updateLevel(agent, {
      messageCount: agent.details?.messageCount,
      toolCalls: agent.toolCallCount,
    });

    this.store.set(id, agent); // -> agentCreated on every client
    this.runtime.registerAgent(key, id);
    this.remember(key, agent);
    this.broadcastDetails(id, agent);
    this.seedStatus(id, agent, info);
    this.recomputeTeams();
    this.store.persist();
    this.scheduleSnapshot();
  }

  private update(id: number, info: StreamSessionInfo, leadChanged: boolean): void {
    const agent = this.store.get(id);
    if (!agent) return;
    let detailsChanged = false;
    let teamDirty = leadChanged;
    let persist = false;

    if (info.label !== undefined && info.label !== agent.label) {
      agent.label = info.label;
      detailsChanged = true;
      teamDirty = true; // a child's agentName is its label
      persist = true;
    }
    if (info.directoryName !== undefined && info.directoryName !== agent.directoryName) {
      agent.directoryName = info.directoryName;
      persist = true;
    }
    const details = mergeDetails(agent.details, info.details);
    if (!sameDetails(details, agent.details)) {
      const countChanged = details?.messageCount !== agent.details?.messageCount;
      agent.details = details;
      detailsChanged = true;
      if (countChanged) this.refreshLevel(id, agent);
    }

    if (detailsChanged) this.broadcastDetails(id, agent);
    if (teamDirty) this.recomputeTeams();
    if (persist) this.store.persist();
  }

  /** Remembered id for the session when free, else the next free one. */
  private reserveId(key: string): number {
    let id = this.remembered.get(key)?.agentId;
    if (id === undefined || !Number.isSafeInteger(id) || id < 1 || this.isTaken(id)) {
      do {
        id = this.store.nextAgentId.current++;
      } while (this.isTaken(id));
    }
    if (id >= this.store.nextAgentId.current) this.store.nextAgentId.current = id + 1;
    return id;
  }

  private isTaken(id: number): boolean {
    return this.store.has(id) || this.sessionByAgent.has(id);
  }

  private remember(key: string, agent: AgentState): void {
    const record: StreamAgentRecord = {
      agentId: agent.id,
      pokemonLine: agent.pokemonLine,
      species: agent.species,
      shiny: agent.shiny,
    };
    if (agent.pokemonChosen) record.pokemonChosen = true;
    if (agent.pokemonAutoLine !== undefined) record.pokemonAutoLine = agent.pokemonAutoLine;
    if (agent.pokemonAutoShiny !== undefined) record.pokemonAutoShiny = agent.pokemonAutoShiny;
    const previous = this.remembered.get(key);
    if (
      previous &&
      previous.agentId === record.agentId &&
      previous.pokemonLine === record.pokemonLine &&
      previous.species === record.species &&
      previous.shiny === record.shiny &&
      previous.pokemonChosen === record.pokemonChosen &&
      previous.pokemonAutoLine === record.pokemonAutoLine &&
      previous.pokemonAutoShiny === record.pokemonAutoShiny
    ) {
      return;
    }
    // Same order and cap as the durable memory, so both forget the same sessions.
    this.remembered.delete(key);
    this.remembered.set(key, record);
    for (const old of [...this.remembered.keys()].slice(
      0,
      Math.max(0, this.remembered.size - STREAM_AGENT_MEMORY_MAX),
    )) {
      this.remembered.delete(old);
    }
    try {
      this.memoryStore?.saveStreamAgent(key, record);
    } catch (err) {
      this.logFailure('saveStreamAgent', err);
    }
  }

  /** The agent's entry left the store (removeSession, dismissal, shutdown). */
  private forgetAgent(id: number): void {
    const sessionId = this.sessionByAgent.get(id);
    if (sessionId === undefined) return;
    this.sessionByAgent.delete(id);
    this.agentIdBySession.delete(sessionId);
    this.statusOf.delete(id);
    this.teamKeyOf.delete(id);
    this.detailsJsonOf.delete(id);
    this.speciesLoading.delete(id);
    this.activeSince.delete(id);
    const pending = this.pendingTurnEnd.get(id);
    if (pending) clearTimeout(pending.timer);
    this.pendingTurnEnd.delete(id);
    this.runtime.unregisterAgent(this.key(sessionId));
    if (this.disposed) return;
    // A departing Lead releases its children; a departing child may demote
    // its Lead. Both come back linked when the agent returns.
    this.recomputeTeams();
    this.scheduleSnapshot();
  }

  private seedStatus(id: number, agent: AgentState, info: StreamSessionInfo): void {
    switch (info.initialStatus) {
      case 'active':
        agent.isWaiting = false;
        this.statusOf.set(id, 'active');
        this.store.broadcast({ type: 'agentStatus', id, status: 'active', silent: true });
        return;
      case 'error': {
        const errorMessage = clip(info.errorMessage, AGENT_ERROR_MESSAGE_MAX_LENGTH);
        agent.isWaiting = true;
        agent.isErrored = true;
        agent.errorMessage = errorMessage;
        this.statusOf.set(id, `error:${errorMessage ?? ''}`);
        this.store.broadcast({
          type: 'agentStatus',
          id,
          status: 'error',
          errorMessage,
          silent: true,
        });
        return;
      }
      default:
        // No stated status reads as Done: characters are created typing, and a
        // session nobody vouched for as running must not sit at its desk.
        agent.isWaiting = true;
        this.statusOf.set(id, 'waiting');
        this.store.broadcast({ type: 'agentStatus', id, status: 'waiting', silent: true });
    }
  }

  // ── Events ──────────────────────────────────────────────────

  private transitionDeps(): TransitionDeps {
    return {
      store: this.store,
      waitingTimers: this.runtime.waitingTimers,
      permissionTimers: this.runtime.permissionTimers,
      subagentToolNames: this.provider.subagentToolNames,
    };
  }

  private turnStart(id: number, agent: AgentState): void {
    if (this.statusOf.get(id) === 'active') return;
    clearError(agent);
    // agentToolsClear, background tool re-send, agentStatus active.
    clearAgentActivity(agent, id, this.store, this.runtime.permissionTimers, this.isSeeding(id));
    agent.hadToolsInTurn = false;
    this.statusOf.set(id, 'active');
    this.activeSince.set(id, Date.now());
  }

  /** Activity that only a running session produces (a tool starting) makes
   *  the agent active even when the provider sent no turnStart. */
  private ensureActive(id: number, agent: AgentState): void {
    if (this.statusOf.get(id) === 'active') return;
    clearError(agent);
    agent.isWaiting = false;
    this.statusOf.set(id, 'active');
    this.activeSince.set(id, Date.now());
    this.store.broadcast({ type: 'agentStatus', id, status: 'active', ...this.silentFlag(id) });
  }

  private isSeeding(id: number): boolean {
    const sessionId = this.sessionByAgent.get(id);
    return sessionId !== undefined && this.seeding.has(sessionId);
  }

  private silentFlag(id: number): { silent?: true } {
    return this.isSeeding(id) ? { silent: true } : {};
  }

  /**
   * A turn end held back for the minimum burst: further activity in the same
   * turn (a turn start, a tool) means it was not the end after all; anything
   * that changes the status (awaiting input, a permission request, another
   * turn end) applies it first, in order.
   */
  private settlePendingTurnEnd(id: number, agent: AgentState, next: AgentEvent['kind']): void {
    const pending = this.pendingTurnEnd.get(id);
    if (!pending) return;
    if (next === 'turnStart' || next === 'toolStart' || next === 'subagentStart') {
      clearTimeout(pending.timer);
      this.timers.delete(pending.timer);
      this.pendingTurnEnd.delete(id);
    } else if (next === 'awaitingInput' || next === 'permissionRequest' || next === 'turnEnd') {
      clearTimeout(pending.timer);
      this.timers.delete(pending.timer);
      this.pendingTurnEnd.delete(id);
      this.applyTurnEnd(id, agent, pending.event);
    }
  }

  private toolStart(
    id: number,
    agent: AgentState,
    event: Extract<AgentEvent, { kind: 'toolStart' }>,
  ): void {
    const { toolId, toolName } = event;
    if (typeof toolId !== 'string' || typeof toolName !== 'string') return;
    if (agent.activeToolIds.has(toolId)) {
      // A repeat for an open tool only says it turned out to run in the
      // background (an async Agent spawn): an update, not a second call.
      if (event.runInBackground === true && this.provider.subagentToolNames.has(toolName)) {
        agent.backgroundAgentToolIds.add(toolId);
      }
      return;
    }
    this.ensureActive(id, agent);
    if (agent.permissionSent) {
      // A new tool means the pending request was answered.
      agent.permissionSent = false;
      this.store.broadcast({ type: 'agentToolPermissionClear', id });
    }
    const status = this.provider.formatToolStatus(toolName, event.input);
    agent.activeToolIds.add(toolId);
    agent.activeToolStatuses.set(toolId, status);
    agent.activeToolNames.set(toolId, toolName);
    const background =
      event.runInBackground === true && this.provider.subagentToolNames.has(toolName);
    if (background) agent.backgroundAgentToolIds.add(toolId);
    agent.isWaiting = false;
    agent.hadToolsInTurn = true;
    this.store.broadcast({
      type: 'agentToolStart',
      id,
      toolId,
      status,
      toolName,
      runInBackground: background || undefined,
    });
    this.countToolCall(id, agent);
  }

  private toolEnd(id: number, agent: AgentState, toolId: string): void {
    if (!agent.activeToolIds.has(toolId)) return;
    const toolName = agent.activeToolNames.get(toolId);
    agent.activeToolIds.delete(toolId);
    agent.activeToolStatuses.delete(toolId);
    agent.activeToolNames.delete(toolId);
    agent.backgroundAgentToolIds.delete(toolId);
    if (toolName && this.provider.subagentToolNames.has(toolName)) {
      agent.activeSubagentToolIds.delete(toolId);
      agent.activeSubagentToolNames.delete(toolId);
      this.store.broadcast({ type: 'subagentClear', id, parentToolId: toolId });
    }
    // Delayed so a tool that starts and ends within one poll still shows.
    this.later(TOOL_DONE_DELAY_MS, () => {
      if (this.store.get(id) === agent) {
        this.store.broadcast({ type: 'agentToolDone', id, toolId });
      }
    });
  }

  private subagentStart(
    id: number,
    agent: AgentState,
    event: Extract<AgentEvent, { kind: 'subagentStart' }>,
  ): void {
    const { parentToolId, toolId, toolName } = event;
    if (typeof parentToolId !== 'string' || typeof toolId !== 'string') return;
    let ids = agent.activeSubagentToolIds.get(parentToolId);
    if (ids?.has(toolId)) return;
    this.ensureActive(id, agent);
    if (!ids) {
      ids = new Set();
      agent.activeSubagentToolIds.set(parentToolId, ids);
    }
    ids.add(toolId);
    let names = agent.activeSubagentToolNames.get(parentToolId);
    if (!names) {
      names = new Map();
      agent.activeSubagentToolNames.set(parentToolId, names);
    }
    names.set(toolId, toolName);
    this.store.broadcast({
      type: 'subagentToolStart',
      id,
      parentToolId,
      toolId,
      status: this.provider.formatToolStatus(toolName, event.input),
    });
    this.countToolCall(id, agent);
  }

  private subagentEnd(id: number, agent: AgentState, parentToolId: string, toolId: string): void {
    const ids = agent.activeSubagentToolIds.get(parentToolId);
    if (!ids?.has(toolId)) return;
    ids.delete(toolId);
    agent.activeSubagentToolNames.get(parentToolId)?.delete(toolId);
    this.later(TOOL_DONE_DELAY_MS, () => {
      if (this.store.get(id) === agent) {
        this.store.broadcast({ type: 'subagentToolDone', id, parentToolId, toolId });
      }
    });
  }

  private permissionRequest(id: number, agent: AgentState): void {
    if (agent.permissionSent) return;
    agent.permissionSent = true;
    this.store.broadcast({ type: 'agentToolPermission', id });
    for (const parentToolId of agent.activeSubagentToolNames.keys()) {
      this.store.broadcast({ type: 'subagentToolPermission', id, parentToolId });
    }
  }

  private permissionClear(id: number, agent: AgentState): void {
    if (!agent.permissionSent) return;
    agent.permissionSent = false;
    this.store.broadcast({ type: 'agentToolPermissionClear', id });
  }

  /** Blocked on the user's answer with tools still open: clears nothing. */
  private awaitingInput(id: number, agent: AgentState): void {
    if (this.statusOf.get(id) === 'input') return;
    clearError(agent);
    agent.isWaiting = true;
    this.statusOf.set(id, 'input');
    this.store.broadcast({
      type: 'agentStatus',
      id,
      status: 'waiting',
      awaitingInput: true,
      ...this.silentFlag(id),
    });
  }

  /**
   * A turn that ends moments after it started (a whole short turn in one
   * poll) would flip back before the office ever showed it working: its end
   * is held until the agent has been active STREAM_TURN_MIN_ACTIVE_MS. Seeds
   * apply at once.
   */
  private turnEnd(
    id: number,
    agent: AgentState,
    event: Extract<AgentEvent, { kind: 'turnEnd' }>,
  ): void {
    const since = this.activeSince.get(id);
    const shownFor = since === undefined ? Infinity : Date.now() - since;
    if (
      this.isSeeding(id) ||
      this.statusOf.get(id) !== 'active' ||
      shownFor >= STREAM_TURN_MIN_ACTIVE_MS
    ) {
      this.applyTurnEnd(id, agent, event);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.pendingTurnEnd.get(id)?.timer !== timer) return;
      this.pendingTurnEnd.delete(id);
      if (this.store.get(id) === agent)
        this.guard('turnEnd', () => this.applyTurnEnd(id, agent, event));
    }, STREAM_TURN_MIN_ACTIVE_MS - shownFor);
    this.timers.add(timer);
    this.pendingTurnEnd.set(id, { event, timer });
  }

  private applyTurnEnd(
    id: number,
    agent: AgentState,
    event: Extract<AgentEvent, { kind: 'turnEnd' }>,
  ): void {
    this.activeSince.delete(id);
    if (event.outcome === 'error') {
      const errorMessage = clip(event.errorMessage, AGENT_ERROR_MESSAGE_MAX_LENGTH);
      const key: StatusKey = `error:${errorMessage ?? ''}`;
      if (this.statusOf.get(id) === key) return;
      endAgentTurn(agent, id, this.transitionDeps());
      agent.isErrored = true;
      agent.errorMessage = errorMessage;
      this.statusOf.set(id, key);
      this.store.broadcast({
        type: 'agentStatus',
        id,
        status: 'error',
        errorMessage,
        ...this.silentFlag(id),
      });
      return;
    }
    // 'aborted' (interrupted, rejected) reads as Done.
    const awaitingInput = event.awaitingInput === true;
    const key: StatusKey = awaitingInput ? 'input' : 'waiting';
    if (this.statusOf.get(id) === key) return;
    clearError(agent);
    markAgentWaiting(agent, id, this.transitionDeps(), awaitingInput, this.isSeeding(id));
    this.statusOf.set(id, key);
  }

  private contextUsage(
    id: number,
    agent: AgentState,
    event: Extract<AgentEvent, { kind: 'contextUsage' }>,
  ): void {
    const tokens = event.tokens;
    if (!(tokens > 0) || !Number.isFinite(tokens)) return;
    const window = event.window ?? this.provider.contextWindowForModel?.(event.model);
    const nextMax = widenContextWindow(tokens, window ?? agent.maxContextTokens);
    if (tokens === agent.contextTokens && nextMax === agent.maxContextTokens) return;
    reportContextUsage(id, agent, this.store, tokens, window);
  }

  private notice(id: number, text: string, tone: 'info' | 'error' | undefined): void {
    const clean = cleanText(text);
    if (!clean) return;
    this.store.broadcast({ type: 'agentNotice', id, text: clean, at: Date.now(), tone });
  }

  private countToolCall(id: number, agent: AgentState): void {
    agent.toolCallCount = (agent.toolCallCount ?? 0) + 1;
    if (this.refreshLevel(id, agent)) this.broadcastDetails(id, agent);
  }

  /** Recompute level and stage; true when either changed. An evolution loads
   *  the new species before agentDetails announces it. */
  private refreshLevel(id: number, agent: AgentState): boolean {
    const change = updateLevel(agent, {
      messageCount: agent.details?.messageCount,
      toolCalls: agent.toolCallCount,
    });
    if (change.speciesChanged) this.speciesChanged(id, agent);
    return change.levelChanged || change.speciesChanged;
  }

  /** The agent's species changed (evolution, Lead promotion): remember it, and
   *  hold its agentDetails until the new species' sprites are loaded, so the
   *  office can play the evolution flash instead of dropping to the upstream
   *  character. */
  private speciesChanged(id: number, agent: AgentState): void {
    this.remember(agent.sessionId, agent);
    this.store.persist();
    this.scheduleSnapshot(); // the session list carries the species
    if (agent.species === undefined || this.speciesLoading.has(id)) return;
    this.speciesLoading.add(id);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, STREAM_SPECIES_LOAD_TIMEOUT_MS);
      timeout.unref?.();
    });
    void Promise.race([
      ensureSpeciesLoaded(agent.species, agent.shiny === true, this.store),
      timedOut,
    ])
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timeout);
        this.speciesLoading.delete(id);
        if (this.disposed || this.store.get(id) !== agent) return;
        this.guard('speciesChanged', () => this.broadcastDetails(id, agent));
      });
  }

  private broadcastDetails(id: number, agent: AgentState): void {
    // An evolution in flight sends the newest details once its species loads.
    if (this.speciesLoading.has(id)) return;
    const message = agentDetailsMessage(id, agent);
    if (!message) return;
    const json = JSON.stringify(message);
    if (json === this.detailsJsonOf.get(id)) return;
    this.detailsJsonOf.set(id, json);
    this.store.broadcast({ ...message });
  }

  // ── Teams (Lead + children from spawned links) ──────────────

  private leadSessionOf(sessionId: string): string | undefined {
    return this.statedLead.get(sessionId) ?? this.spawnedBy.get(sessionId);
  }

  /** Team fields a session should carry given who is in the office now. */
  private desiredTeam(
    sessionId: string,
    label: string | undefined,
  ): Pick<AgentState, 'isTeamLead' | 'leadAgentId' | 'agentName' | 'teamUsesTmux'> {
    const leadSessionId = this.leadSessionOf(sessionId);
    const leadAgentId =
      leadSessionId !== undefined && leadSessionId !== sessionId
        ? this.agentIdBySession.get(leadSessionId)
        : undefined;
    // Only a child it spawned itself makes a session a Lead (a legendary);
    // a handoff (Switch model) is linked to it and thrown out of it, no more.
    let isTeamLead = false;
    for (const child of this.agentIdBySession.keys()) {
      if (
        child !== sessionId &&
        !this.handoffs.has(child) &&
        this.leadSessionOf(child) === sessionId
      ) {
        isTeamLead = true;
        break;
      }
    }
    // Derived team: never a teamName (that would switch on Claude's team-config
    // polling and the webview's teamed-Lead rules).
    return {
      isTeamLead: isTeamLead || undefined,
      leadAgentId,
      agentName: leadAgentId !== undefined ? label : undefined,
      teamUsesTmux: leadAgentId !== undefined ? true : undefined,
    };
  }

  /** Bring every stream agent's team fields in line with the links and who is
   *  in the office, broadcasting agentTeamInfo only for agents that changed. */
  private recomputeTeams(): void {
    let changed = false;
    for (const [sessionId, id] of this.agentIdBySession) {
      const agent = this.store.get(id);
      if (!agent) continue;
      const team = this.desiredTeam(sessionId, agent.label);
      const becameLead = team.isTeamLead === true && agent.isTeamLead !== true;
      agent.isTeamLead = team.isTeamLead;
      agent.leadAgentId = team.leadAgentId;
      agent.agentName = team.agentName;
      agent.teamUsesTmux = team.teamUsesTmux;
      const key = JSON.stringify(team);
      if (key !== (this.teamKeyOf.get(id) ?? NO_TEAM_KEY)) {
        this.teamKeyOf.set(id, key);
        changed = true;
        this.store.broadcast({
          type: 'agentTeamInfo',
          id,
          agentName: agent.agentName,
          isTeamLead: agent.isTeamLead,
          leadAgentId: agent.leadAgentId,
          teamUsesTmux: agent.teamUsesTmux,
        });
      }
      if (becameLead && promoteToOrchestrator(agent, this.store)) {
        this.speciesChanged(id, agent);
      }
    }
    if (changed) this.store.persist();
  }

  // ── Links ───────────────────────────────────────────────────

  private hasLink(from: string, to: string, kind: AgentLink['kind']): boolean {
    return this.links.has(linkKey(from, to, kind));
  }

  private recordLink(
    from: string,
    to: string,
    kind: AgentLink['kind'],
    at: number,
    preview: string | undefined,
  ): void {
    const key = linkKey(from, to, kind);
    const record = this.links.get(key);
    if (record) {
      record.count++;
      if (at >= record.lastAt) {
        record.lastAt = at;
        if (preview) record.preview = preview;
      }
    } else {
      this.links.set(key, {
        fromSessionId: from,
        toSessionId: to,
        kind,
        count: 1,
        lastAt: at,
        preview,
      });
      this.pruneLinks();
    }
    if (kind === 'spawned' && !this.spawnedBy.has(to)) {
      this.spawnedBy.set(to, from);
      if (this.agentIdBySession.has(from) && this.agentIdBySession.has(to)) this.recomputeTeams();
    }
    this.scheduleSnapshot();
  }

  private pruneLinks(): void {
    if (this.links.size <= STREAM_LINKS_MAX) return;
    const oldest = [...this.links.entries()]
      .sort((a, b) => a[1].lastAt - b[1].lastAt)
      .slice(0, this.links.size - STREAM_LINKS_MAX);
    for (const [key] of oldest) this.links.delete(key);
  }

  /** One live message between two agents in the office: animate it, at most
   *  once per pair per AGENT_MESSAGE_PAIR_INTERVAL_MS and
   *  AGENT_MESSAGE_MAX_PER_SECOND overall (the link snapshot still counts all). */
  private animateMessage(
    from: string,
    to: string,
    kind: AgentLink['kind'],
    preview: string | undefined,
    at: number,
  ): void {
    const fromId = this.agentIdBySession.get(from);
    const toId = this.agentIdBySession.get(to);
    if (fromId === undefined || toId === undefined) return;
    const now = Date.now();
    const pair = `${from}\n${to}`;
    const last = this.lastMessageAt.get(pair);
    if (last !== undefined && now - last < AGENT_MESSAGE_PAIR_INTERVAL_MS) return;
    this.recentMessageTimes = this.recentMessageTimes.filter((t) => now - t < ONE_SECOND_MS);
    if (this.recentMessageTimes.length >= AGENT_MESSAGE_MAX_PER_SECOND) return;
    this.recentMessageTimes.push(now);
    this.lastMessageAt.set(pair, now);
    if (this.lastMessageAt.size > STREAM_LINKS_MAX) {
      for (const [p, t] of this.lastMessageAt) {
        if (now - t >= AGENT_MESSAGE_PAIR_INTERVAL_MS) this.lastMessageAt.delete(p);
      }
    }
    this.store.broadcast({ type: 'agentMessage', fromId, toId, kind, preview, at });
  }

  /** Links whose two ends are both agents in the office. */
  private linksSnapshot(): AgentLink[] {
    const out: AgentLink[] = [];
    for (const record of this.links.values()) {
      const fromId = this.agentIdBySession.get(record.fromSessionId);
      const toId = this.agentIdBySession.get(record.toSessionId);
      if (fromId === undefined || toId === undefined) continue;
      out.push({
        fromId,
        toId,
        kind: record.kind,
        count: record.count,
        lastAt: record.lastAt,
        preview: record.preview,
      });
    }
    return out;
  }

  // ── Snapshots (agentLinks, conductorSessions) ───────────────

  /** Flush the snapshots once, STREAM_SNAPSHOT_DEBOUNCE_MS after the first change. */
  private scheduleSnapshot(): void {
    if (this.snapshotTimer || this.disposed) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.guard('snapshot', () => this.flushSnapshots());
    }, STREAM_SNAPSHOT_DEBOUNCE_MS);
  }

  private flushSnapshots(): void {
    const links = this.linksSnapshot();
    const json = JSON.stringify(links);
    if (json !== this.linksJson) {
      this.linksJson = json;
      this.store.broadcast({ type: 'agentLinks', links });
    }
    // Agent ids in the session list follow adoption and removal.
    this.broadcastSessionsIfChanged();
  }

  private broadcastSessionsIfChanged(): void {
    if (!this.sessions) return;
    const sessions = this.withAgentIds(this.sessions);
    const json = JSON.stringify(sessions);
    if (json === this.sessionsJson) return;
    this.sessionsJson = json;
    this.store.broadcast({ type: 'conductorSessions', sessions });
  }

  /** Summaries with what only the runtime knows: the agent id of a session in
   *  the office, and the Pokémon it shows (or was last shown as, from the
   *  stream memory), so Archived sessions can draw sessions it never saw. */
  private withAgentIds(sessions: ConductorSessionSummary[]): ConductorSessionSummary[] {
    return sessions.map((session) => {
      const { agentId: _providerGuess, species: _s, shiny: _sh, ...rest } = session;
      const out: ConductorSessionSummary = rest;
      const agentId = this.agentIdBySession.get(session.sessionId);
      if (agentId !== undefined) out.agentId = agentId;
      const agent = agentId !== undefined ? this.store.get(agentId) : undefined;
      const record = this.remembered.get(this.key(session.sessionId));
      const species = agent?.species ?? record?.species;
      if (species !== undefined) {
        out.species = species;
        out.shiny = (agent ? agent.shiny : record?.shiny) === true;
      }
      return out;
    });
  }

  // ── Plumbing ────────────────────────────────────────────────

  private key(sessionId: string): string {
    return `${this.provider.id}:${sessionId}`;
  }

  private later(delayMs: number, fn: () => void): void {
    if (this.disposed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, delayMs);
    this.timers.add(timer);
  }

  /** The sink is the provider's boundary: a failure here must not take down
   *  its poll loop, and must not pass silently either. */
  private guard(method: string, fn: () => void): void {
    if (this.disposed) return;
    try {
      fn();
    } catch (err) {
      this.logFailure(method, err);
    }
  }

  private logFailure(method: string, err: unknown): void {
    console.error(
      `[Pixel Agents] Stream provider ${this.provider.id}: ${method} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function linkKey(from: string, to: string, kind: string): string {
  return `${from}\n${to}\n${kind}`;
}

function clearError(agent: AgentState): void {
  agent.isErrored = undefined;
  agent.errorMessage = undefined;
}

/** Cut to `max` characters, marking the cut. */
function clip(text: string | undefined, max: number): string | undefined {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Whitespace collapsed to single spaces, then clipped. */
function cleanText(text: string | undefined): string | undefined {
  return typeof text === 'string'
    ? clip(text.replace(/\s+/g, ' '), STREAM_TEXT_MAX_LENGTH)
    : undefined;
}

/** Details with `next`'s defined fields laid over `prev` (absent = unknown, not cleared). */
function mergeDetails(
  prev: StreamSessionDetails | undefined,
  next: StreamSessionDetails | undefined,
): StreamSessionDetails | undefined {
  if (!next || typeof next !== 'object') return prev;
  const out: Record<string, unknown> = { ...prev };
  for (const [field, value] of Object.entries(next)) {
    if (value !== undefined) out[field] = value;
  }
  return out as StreamSessionDetails;
}

function sameDetails(
  a: StreamSessionDetails | undefined,
  b: StreamSessionDetails | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const fields = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const field of fields) {
    if (ra[field] !== rb[field]) return false;
  }
  return true;
}
