/**
 * Conductor UI store: everything the chrome (party bar, Pokédex, Sessions and
 * PC Box modals, battle log, toasts, theme) knows about stream-provider agents
 * and the Conductor connection.
 *
 * DOM-free and transport-free so the Node test runner can drive it: a feed
 * hook (useConductorFeed) pipes ServerMessages into `apply`, React reads it
 * through `useConductor(selector)`. State is immutable — every change swaps in
 * new objects for the slices it touched, so a selector that picks a slice
 * returns the same reference until that slice changes.
 */

import { useSyncExternalStore } from 'react';

import type {
  AgentLink,
  AgentNoticeTone,
  ConductorAction,
  ConductorSessionSummary,
  ConductorStatus,
  ModelCatalog,
  PokemonCatalog,
  PokemonSpeciesLoaded,
  ServerMessage,
  SessionDetail,
  SessionDetailEntry,
} from '../../../core/src/messages.js';
import { BATTLE_LOG_CAPACITY, EVOLUTION_LEVELS, TOAST_MAX_VISIBLE } from '../constants.js';
import { extractToolName } from '../office/toolUtils.js';
import { mergeEntries } from './chat.js';

/** One tool the agent started this turn (agentToolStart → agentToolDone). */
export interface OpenTool {
  toolId: string;
  status: string;
  done: boolean;
}

export interface AgentNoticeInfo {
  text: string;
  at: number;
  tone: AgentNoticeTone;
}

/** What the chrome knows about one agent in the office. Every field the
 *  server may omit is optional: absent means unknown, never cleared. */
export interface ConductorAgent {
  id: number;
  providerId?: string;
  label?: string;
  species?: number;
  shiny?: boolean;
  /** The user chose this Pokémon (Change Pokémon). */
  pokemonChosen?: boolean;
  level?: number;
  /** The level when the current species was set (evolution detection). */
  speciesLevel?: number;
  externalUrl?: string;
  model?: string;
  harness?: string;
  effort?: string;
  fastMode?: boolean;
  conductorSessionId?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceNumber?: number;
  repo?: string;
  creatorName?: string;
  messageCount?: number;
  /** Epoch ms of the newest activity the provider observed. */
  lastActivityAt?: number;
  /** Epoch ms of the newest live activity this client saw (turn start, tool,
   *  turn end). Seeding and reconnect resends never move it. */
  lastActiveAt?: number;
  status?: 'active' | 'waiting' | 'error';
  awaitingInput: boolean;
  permission: boolean;
  errorMessage?: string;
  tools: readonly OpenTool[];
  contextTokens?: number;
  maxContextTokens?: number;
  isTeamLead?: boolean;
  leadAgentId?: number;
  notice?: AgentNoticeInfo;
}

export interface BattleLogEntry {
  seq: number;
  text: string;
  at: number;
}

export interface Toast {
  seq: number;
  text: string;
  tone: 'success' | 'error';
}

/** The newest Conductor action outcome for one agent (the Pokédex shows it). */
export interface ActionOutcome {
  action: ConductorAction;
  ok: boolean;
  message?: string;
  at: number;
}

export interface SpeciesRef {
  species: number;
  shiny: boolean;
}

/** Older conversation pages the chat view loaded for one agent
 *  (requestSessionHistory → sessionHistory). */
export interface ChatHistory {
  /** Every page so far, merged by entry key, oldest first. */
  entries: readonly SessionDetailEntry[];
  /** Cursor for the next older page. */
  cursor?: string;
  /** Older entries exist (and the cursor can fetch them). */
  hasMore: boolean;
  /** A reply has arrived. */
  loaded: boolean;
  /** When the request in flight was sent (store clock), if one is. */
  pendingSince?: number;
  /** The last reply's error, until the next request. */
  error?: string;
}

export interface ConductorState {
  /** Provider ids feeding the office. Absent on the wire means ['claude']. */
  activeProviders: readonly string[];
  /** Agents in the order the office learned about them. */
  agentIds: readonly number[];
  agents: Readonly<Record<number, ConductorAgent>>;
  links: readonly AgentLink[];
  sessionDetails: Readonly<Record<number, SessionDetail>>;
  chatHistories: Readonly<Record<number, ChatHistory>>;
  /** null until the server reports (no Conductor provider, or not yet). */
  status: ConductorStatus | null;
  /** null until the first conductorSessions arrives. */
  sessions: readonly ConductorSessionSummary[] | null;
  /** pokemonSpeciesLoaded payloads keyed by speciesKey(dex, shiny). */
  species: Readonly<Record<string, PokemonSpeciesLoaded>>;
  /** Last species seen per Conductor session id — lets the PC Box show a
   *  portrait for a session that left the office. */
  sessionSpecies: Readonly<Record<string, SpeciesRef>>;
  pokemonTheme: boolean;
  battleLog: readonly BattleLogEntry[];
  toasts: readonly Toast[];
  actionOutcomes: Readonly<Record<number, ActionOutcome>>;
  /** Switch model's picker data; null until requestModelCatalog is answered. */
  modelCatalog: ModelCatalog | null;
  /** Change Pokémon's picker data; null until requestPokemonCatalog is answered. */
  pokemonCatalog: PokemonCatalog | null;
  /** A session Switch model started: its Pokédex opens when it walks in. */
  follow: { sessionId: string; at: number } | null;
}

const DEFAULT_PROVIDERS: readonly string[] = ['claude'];

const EMPTY_HISTORY: ChatHistory = { entries: [], hasMore: false, loaded: false };

function initialConductorState(): ConductorState {
  return {
    activeProviders: DEFAULT_PROVIDERS,
    agentIds: [],
    agents: {},
    links: [],
    sessionDetails: {},
    chatHistories: {},
    status: null,
    sessions: null,
    species: {},
    sessionSpecies: {},
    pokemonTheme: true,
    battleLog: [],
    toasts: [],
    actionOutcomes: {},
    modelCatalog: null,
    pokemonCatalog: null,
    follow: null,
  };
}

function speciesKey(dex: number, shiny: boolean): string {
  return `${dex}:${shiny ? 1 : 0}`;
}

/** The loaded species for a dex, preferring the requested shininess. */
export function findSpecies(
  state: Pick<ConductorState, 'species'>,
  dex: number | undefined,
  shiny = false,
): PokemonSpeciesLoaded | undefined {
  if (dex === undefined) return undefined;
  return state.species[speciesKey(dex, shiny)] ?? state.species[speciesKey(dex, !shiny)];
}

/** The agent's nickname: its session label, else "Agent N". */
export function agentNickname(state: Pick<ConductorState, 'agents'>, id: number): string {
  return state.agents[id]?.label ?? `Agent ${id}`;
}

/** The name the battle log calls an agent by: its species, else its nickname. */
export function agentBattleName(
  state: Pick<ConductorState, 'agents' | 'species'>,
  id: number,
): string {
  const agent = state.agents[id];
  return findSpecies(state, agent?.species, agent?.shiny)?.name ?? agentNickname(state, id);
}

/** True for agents fed by a stream provider (Conductor): they have no
 *  terminal, so their character and card open the Pokédex. Claude Code
 *  agents may carry providerId 'claude' and stay terminal agents. */
export function isStreamProvider(providerId: string | undefined): boolean {
  return providerId !== undefined && providerId !== 'claude';
}

/** The status text of the newest tool still running, or null. */
export function currentActivity(agent: ConductorAgent | undefined): string | null {
  if (!agent) return null;
  for (let i = agent.tools.length - 1; i >= 0; i--) {
    if (!agent.tools[i].done) return agent.tools[i].status;
  }
  return null;
}

/** True when a species change from `before` to `after` crosses an evolution
 *  level. */
export function crossesEvolutionLevel(before: number | undefined, after: number | undefined) {
  if (before === undefined || after === undefined) return false;
  return EVOLUTION_LEVELS.some((level) => before < level && after >= level);
}

function newAgent(id: number): ConductorAgent {
  return { id, awaitingInput: false, permission: false, tools: [] };
}

function omit<T>(record: Readonly<Record<number, T>>, id: number): Readonly<Record<number, T>> {
  if (!(id in record)) return record;
  const next = { ...record };
  delete next[id];
  return next;
}

/** Copy the fields of `patch` that are defined (absent = unknown, not cleared). */
function definedFields<T extends object>(patch: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function actionWho(state: ConductorState, id: number | undefined): string {
  return id !== undefined && state.agents[id] ? agentNickname(state, id) : 'The session';
}

/** Toast text for an action outcome; null when a success needs no toast
 *  (visibility toggles answer with the updated list instead). */
function actionToastText(
  state: ConductorState,
  action: ConductorAction,
  ok: boolean,
  id: number | undefined,
  message: string | undefined,
): string | null {
  const who = actionWho(state, id);
  if (ok) {
    switch (action) {
      case 'sendSessionMessage':
        return `Message sent to ${who}`;
      case 'stopSession':
        return `Stopped ${who}`;
      case 'archiveSession':
        return `${who} was deposited in the PC`;
      case 'restoreSession':
        return `${who} was withdrawn from the PC`;
      case 'continueWithModel':
        return `Started a new session to continue ${who}`;
      default:
        return null;
    }
  }
  const failure: Record<ConductorAction, string> = {
    sendSessionMessage: "Couldn't send the message",
    stopSession: "Couldn't stop the session",
    openExternal: "Couldn't open Conductor",
    setSessionHidden: "Couldn't change who is shown",
    setSessionPinned: "Couldn't change the pin",
    setConductorScope: "Couldn't change the scope",
    archiveSession: "Couldn't deposit the session",
    restoreSession: "Couldn't withdraw the session",
    continueWithModel: "Couldn't start the new session",
    setAgentPokemon: "Couldn't change the Pokémon",
  };
  return message ? `${failure[action]}: ${message}` : failure[action];
}

type Listener = () => void;

export class ConductorStore {
  private state: ConductorState = initialConductorState();
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;
  private seq = 0;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  getState = (): ConductorState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(next: ConductorState): void {
    if (next === this.state) return;
    this.state = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private withAgent(
    state: ConductorState,
    id: number,
    update: (agent: ConductorAgent) => ConductorAgent,
  ): ConductorState {
    const prev = state.agents[id];
    const base = prev ?? newAgent(id);
    const next = update(base);
    if (prev && next === prev) return state;
    return {
      ...state,
      agents: { ...state.agents, [id]: next },
      agentIds: state.agentIds.includes(id) ? state.agentIds : [...state.agentIds, id],
    };
  }

  private log(state: ConductorState, text: string): ConductorState {
    const entry: BattleLogEntry = { seq: this.nextSeq(), text, at: this.now() };
    const battleLog = [...state.battleLog, entry].slice(-BATTLE_LOG_CAPACITY);
    return { ...state, battleLog };
  }

  private toast(state: ConductorState, text: string, tone: Toast['tone']): ConductorState {
    const toasts = [...state.toasts, { seq: this.nextSeq(), text, tone }].slice(-TOAST_MAX_VISIBLE);
    return { ...state, toasts };
  }

  /** Fold one ServerMessage into the state. Unrelated messages are ignored. */
  apply(msg: ServerMessage): void {
    this.set(this.reduce(this.state, msg));
  }

  private reduce(state: ConductorState, msg: ServerMessage): ConductorState {
    const now = this.now();
    switch (msg.type) {
      case 'providerCapabilities': {
        const providers = Array.isArray(msg.activeProviders)
          ? msg.activeProviders
          : DEFAULT_PROVIDERS;
        return { ...state, activeProviders: providers };
      }
      case 'agentCreated': {
        let next = this.withAgent(state, msg.id, (a) => ({
          ...a,
          ...definedFields({
            providerId: msg.providerId,
            label: msg.label,
            species: msg.species,
            shiny: msg.shiny,
            level: msg.level,
          }),
          speciesLevel:
            msg.species !== undefined && msg.species !== a.species
              ? (msg.level ?? a.level)
              : (a.speciesLevel ?? msg.level),
          leadAgentId:
            msg.isTeammate && msg.parentAgentId !== undefined ? msg.parentAgentId : a.leadAgentId,
        }));
        next = this.rememberSessionSpecies(next, msg.id);
        return next;
      }
      case 'existingAgents': {
        let next = state;
        const ids = Array.isArray(msg.agents) ? msg.agents : [];
        for (const id of ids) {
          const meta = msg.agentMeta?.[String(id)];
          next = this.withAgent(next, id, (a) =>
            meta ? { ...a, ...definedFields({ species: meta.species, shiny: meta.shiny }) } : a,
          );
        }
        return next;
      }
      case 'agentClosed': {
        if (!(msg.id in state.agents)) return state;
        return {
          ...state,
          agents: omit(state.agents, msg.id),
          agentIds: state.agentIds.filter((id) => id !== msg.id),
          sessionDetails: omit(state.sessionDetails, msg.id),
          chatHistories: omit(state.chatHistories, msg.id),
          actionOutcomes: omit(state.actionOutcomes, msg.id),
        };
      }
      case 'agentDetails': {
        const prev = state.agents[msg.id];
        const evolvedFrom =
          prev?.species !== undefined &&
          msg.species !== undefined &&
          msg.species !== prev.species &&
          crossesEvolutionLevel(prev.speciesLevel ?? prev.level, msg.level ?? prev.level)
            ? findSpecies(state, prev.species, prev.shiny)?.name
            : undefined;
        let next = this.withAgent(state, msg.id, (a) => ({
          ...a,
          ...definedFields({
            providerId: msg.providerId,
            label: msg.label,
            externalUrl: msg.externalUrl,
            model: msg.model,
            harness: msg.harness,
            effort: msg.effort,
            fastMode: msg.fastMode,
            conductorSessionId: msg.conductorSessionId,
            workspaceId: msg.conductorWorkspaceId,
            workspaceName: msg.conductorWorkspaceName,
            workspaceNumber: msg.conductorWorkspaceNumber,
            repo: msg.repo,
            creatorName: msg.creatorName,
            messageCount: msg.messageCount,
            lastActivityAt: msg.lastActivityAt,
            species: msg.species,
            shiny: msg.shiny,
            pokemonChosen: msg.pokemonChosen,
            level: msg.level,
          }),
          // A new species starts at the current level; otherwise keep the
          // level it was first seen at.
          speciesLevel:
            msg.species !== undefined && msg.species !== a.species
              ? (msg.level ?? a.level)
              : (a.speciesLevel ?? a.level ?? msg.level),
        }));
        next = this.rememberSessionSpecies(next, msg.id);
        if (evolvedFrom !== undefined) {
          const agent = next.agents[msg.id];
          const into = findSpecies(next, agent.species, agent.shiny)?.name;
          next = this.log(
            next,
            into ? `${evolvedFrom} evolved into ${into}!` : `${evolvedFrom} evolved!`,
          );
        }
        return next;
      }
      case 'agentStatus': {
        const prev = state.agents[msg.id];
        const live = msg.silent !== true;
        let next = this.withAgent(state, msg.id, (a) => ({
          ...a,
          status: msg.status,
          awaitingInput: msg.status === 'waiting' && msg.awaitingInput === true,
          errorMessage: msg.status === 'error' ? msg.errorMessage : undefined,
          permission: msg.status === 'active' ? a.permission : false,
          lastActiveAt: live && msg.status !== 'error' ? now : a.lastActiveAt,
        }));
        if (msg.status === 'error' && prev?.status !== 'error' && live) {
          next = this.log(next, `${agentBattleName(next, msg.id)} fainted!`);
        }
        return next;
      }
      case 'agentToolStart': {
        const prev = state.agents[msg.id];
        if (prev?.tools.some((t) => t.toolId === msg.toolId)) return state;
        let next = this.withAgent(state, msg.id, (a) => ({
          ...a,
          tools: [...a.tools, { toolId: msg.toolId, status: msg.status, done: false }],
          permission: msg.permissionActive === true ? true : a.permission,
          lastActiveAt: now,
        }));
        const tool = msg.toolName ?? extractToolName(msg.status);
        if (tool) next = this.log(next, `${agentBattleName(next, msg.id)} used ${tool}!`);
        return next;
      }
      case 'agentToolDone':
        return this.withAgent(state, msg.id, (a) =>
          a.tools.some((t) => t.toolId === msg.toolId && !t.done)
            ? {
                ...a,
                tools: a.tools.map((t) => (t.toolId === msg.toolId ? { ...t, done: true } : t)),
              }
            : a,
        );
      case 'agentToolsClear':
        return this.withAgent(state, msg.id, (a) =>
          a.tools.length === 0 && !a.permission ? a : { ...a, tools: [], permission: false },
        );
      case 'agentToolPermission':
        return this.withAgent(state, msg.id, (a) =>
          a.permission ? a : { ...a, permission: true },
        );
      case 'agentToolPermissionClear':
        return this.withAgent(state, msg.id, (a) =>
          a.permission ? { ...a, permission: false } : a,
        );
      case 'agentTeamInfo':
        return this.withAgent(state, msg.id, (a) => ({
          ...a,
          isTeamLead: msg.isTeamLead,
          leadAgentId: msg.leadAgentId,
        }));
      case 'agentContextUsage':
        return this.withAgent(state, msg.id, (a) => ({
          ...a,
          contextTokens: msg.contextTokens,
          maxContextTokens: msg.maxContextTokens,
        }));
      case 'agentNotice':
        return this.withAgent(state, msg.id, (a) => ({
          ...a,
          notice: { text: msg.text, at: msg.at, tone: msg.tone ?? 'info' },
        }));
      case 'agentLinks':
        return { ...state, links: Array.isArray(msg.links) ? msg.links : [] };
      case 'agentMessage': {
        if (msg.kind === 'watched') return state;
        const from = agentBattleName(state, msg.fromId);
        const to = agentBattleName(state, msg.toId);
        return this.log(
          state,
          msg.kind === 'spawned' ? `${from} sent out ${to}!` : `${from} sent ${to} a message!`,
        );
      }
      case 'sessionDetail':
        return { ...state, sessionDetails: { ...state.sessionDetails, [msg.id]: msg } };
      case 'sessionHistory': {
        const prev = state.chatHistories[msg.id] ?? EMPTY_HISTORY;
        const next: ChatHistory = msg.error
          ? { ...prev, pendingSince: undefined, error: msg.error }
          : {
              entries: mergeEntries(Array.isArray(msg.entries) ? msg.entries : [], prev.entries),
              // A late duplicate reply never moves the cursor of a page
              // already loaded.
              ...(prev.loaded && prev.pendingSince === undefined
                ? { cursor: prev.cursor, hasMore: prev.hasMore }
                : {
                    cursor: msg.before,
                    hasMore: msg.hasMore === true && typeof msg.before === 'string',
                  }),
              loaded: true,
            };
        return { ...state, chatHistories: { ...state.chatHistories, [msg.id]: next } };
      }
      case 'conductorStatus':
        return { ...state, status: msg };
      case 'conductorSessions':
        return { ...state, sessions: Array.isArray(msg.sessions) ? msg.sessions : [] };
      case 'conductorActionResult': {
        let next = state;
        if (msg.id !== undefined) {
          next = {
            ...next,
            actionOutcomes: {
              ...next.actionOutcomes,
              [msg.id]: { action: msg.action, ok: msg.ok, message: msg.message, at: now },
            },
          };
        }
        if (msg.action === 'continueWithModel' && msg.ok && msg.sessionId) {
          next = { ...next, follow: { sessionId: msg.sessionId, at: now } };
        }
        const text = actionToastText(state, msg.action, msg.ok, msg.id, msg.message);
        return text ? this.toast(next, text, msg.ok ? 'success' : 'error') : next;
      }
      case 'modelCatalog':
        return { ...state, modelCatalog: msg };
      case 'pokemonCatalog':
        return { ...state, pokemonCatalog: msg };
      case 'pokemonSpeciesLoaded':
        return {
          ...state,
          species: { ...state.species, [speciesKey(msg.dex, msg.shiny)]: msg },
        };
      case 'settingsLoaded':
        return { ...state, pokemonTheme: msg.pokemonTheme !== false };
      case 'pokemonThemeUpdated':
        return { ...state, pokemonTheme: msg.enabled === true };
      default:
        return state;
    }
  }

  private rememberSessionSpecies(state: ConductorState, id: number): ConductorState {
    const agent = state.agents[id];
    if (!agent?.conductorSessionId || agent.species === undefined) return state;
    const known = state.sessionSpecies[agent.conductorSessionId];
    const shiny = agent.shiny === true;
    if (known && known.species === agent.species && known.shiny === shiny) return state;
    return {
      ...state,
      sessionSpecies: {
        ...state.sessionSpecies,
        [agent.conductorSessionId]: { species: agent.species, shiny },
      },
    };
  }

  // ── Local (optimistic) changes ─────────────────────────────

  /** The Settings toggle: applied now, corrected by pokemonThemeUpdated or a
   *  re-sent settingsLoaded when the server refuses. */
  setPokemonTheme(enabled: boolean): void {
    if (this.state.pokemonTheme === enabled) return;
    this.set({ ...this.state, pokemonTheme: enabled });
  }

  /** Optimistic hide/pin in the Sessions modal; the next conductorSessions
   *  (sent on change, and re-sent on refusal) replaces it. */
  patchSession(
    sessionId: string,
    patch: Partial<Pick<ConductorSessionSummary, 'hidden' | 'pinned'>>,
  ): void {
    const sessions = this.state.sessions;
    if (!sessions?.some((s) => s.sessionId === sessionId)) return;
    this.set({
      ...this.state,
      sessions: sessions.map((s) => (s.sessionId === sessionId ? { ...s, ...patch } : s)),
    });
  }

  /** The chat view asked for a history page (the newest without a cursor). */
  noteHistoryRequest(id: number): void {
    const prev = this.state.chatHistories[id] ?? EMPTY_HISTORY;
    this.set({
      ...this.state,
      chatHistories: {
        ...this.state.chatHistories,
        [id]: { ...prev, pendingSince: this.now(), error: undefined },
      },
    });
  }

  /** The followed session opened (or the wait ran out). */
  clearFollow(): void {
    if (this.state.follow === null) return;
    this.set({ ...this.state, follow: null });
  }

  dismissToast(seq: number): void {
    if (!this.state.toasts.some((t) => t.seq === seq)) return;
    this.set({ ...this.state, toasts: this.state.toasts.filter((t) => t.seq !== seq) });
  }
}

/** The app's one store, fed by useConductorFeed. */
export const conductorStore = new ConductorStore();

/** Read a slice of the Conductor store. The selector must return a value that
 *  keeps its identity while the slice is unchanged (pick a slice or a
 *  primitive; derive arrays with useMemo in the component). */
export function useConductor<T>(selector: (state: ConductorState) => T): T {
  return useSyncExternalStore(conductorStore.subscribe, () => selector(conductorStore.getState()));
}
