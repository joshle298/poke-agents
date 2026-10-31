/**
 * Conductor stream provider: polls the Conductor public API and pushes each
 * cloud session into the office as an agent, through the AgentEventSink only.
 *
 * Composition: credentials (auth.ts) → budgeted client (client.ts) → poller
 * (discovery, tiers, backfill, links, scope) with the normalizers, the link
 * tracker, the Pokédex log and conductor-state.json. Polling is GET-only;
 * the write endpoints run only for the explicit user actions below.
 */

import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';

import type { ConductorScope, ConductorSessionSummary } from '../../../../../core/src/messages.js';
import type {
  AgentEventSink,
  StreamProvider,
  StreamProviderStatus,
  StreamSessionDetail,
} from '../../../../../core/src/provider.js';
import { SERVER_JSON_DIR } from '../../../constants.js';
import { contextWindowForModel as claudeContextWindow } from '../../hook/claude/claude.js';
import { defaultExecFile, type ExecFileFn, resolveConductorAuth } from './auth.js';
import {
  type ClientClock,
  ConductorApiError,
  ConductorClient,
  systemClock,
  userFacingMessage,
} from './client.js';
import {
  AUTH_REQUIRED_MESSAGE,
  BACKOFF_MAX_MS,
  CLAUDE_MODEL_PREFIX,
  CONDUCTOR_DISPLAY_NAME,
  CONDUCTOR_PROVIDER_ID,
  DEFAULT_BUDGET_PER_MINUTE,
  DISCOVERY_INTERVAL_MS,
  ENV_BUDGET,
  GPT_CONTEXT_WINDOW,
  GPT_MODEL_PREFIX,
  LOG_PREFIX,
  STATE_FILE_NAME,
} from './constants.js';
import { LinkTracker } from './links.js';
import { ConductorPoller } from './poller.js';
import { SessionLogStore } from './sessionLog.js';
import { ConductorStateStore, sanitizeScope } from './state.js';
import {
  CONDUCTOR_PERMISSION_EXEMPT_TOOLS,
  CONDUCTOR_READING_TOOLS,
  CONDUCTOR_SUBAGENT_TOOLS,
  formatConductorToolStatus,
} from './tools.js';

export interface ConductorProviderOptions {
  /** Directory for conductor-state.json. Defaults to ~/.pixel-agents. */
  stateDir?: string;
  /** Client-side request budget per minute (default 120, or POKE_AGENTS_CONDUCTOR_BUDGET). */
  budgetPerMinute?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests: environment used for token and base URL resolution. */
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  /** Injected for tests: platform deciding whether the Keychain is consulted. */
  platform?: NodeJS.Platform;
  /** Injected for tests: runs /usr/bin/security (never a shell). */
  execFile?: ExecFileFn;
  /** Injected for tests: time source for the client and the poller. */
  clock?: ClientClock;
  /** Tests drive the poller with tick(); production runs it on a timer. */
  autoTick?: boolean;
}

/** Pokémon identity persisted per Conductor session (conductor-state.json). */
export interface ConductorSessionPersona {
  pokemonLine?: string;
  shiny?: boolean;
}

/** Every optional StreamProvider control, all of which this provider implements. */
type ConductorControls = Required<
  Pick<
    StreamProvider,
    | 'contextWindowForModel'
    | 'onDismiss'
    | 'setSessionHidden'
    | 'setSessionPinned'
    | 'getScope'
    | 'setScope'
    | 'listSessions'
    | 'getSessionDetail'
    | 'sendMessage'
    | 'stopSession'
    | 'archiveSession'
    | 'restoreSession'
    | 'setFocus'
  >
>;

/**
 * The provider plus the hooks the runtime uses to keep ids and Pokémon stable
 * across restarts (all optional to call; none touch the network).
 */
export type ConductorProvider = StreamProvider &
  ConductorControls & {
    /** Agent id this session had last time, if any. */
    agentIdFor(sessionId: string): number | undefined;
    /** Remember the agent id the runtime gave this session. */
    rememberAgentId(sessionId: string, agentId: number): void;
    /** Highest reserved agent id; the runtime allocates new ids above it. */
    maxReservedAgentId(): number;
    sessionPersona(sessionId: string): ConductorSessionPersona | undefined;
    setSessionPersona(sessionId: string, persona: ConductorSessionPersona): void;
    /** Test hook: one scheduling round (no-op before start or after stop). */
    tick(): Promise<void>;
  };

export function conductorContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  if (model.startsWith(CLAUDE_MODEL_PREFIX)) return claudeContextWindow(model);
  if (model.startsWith(GPT_MODEL_PREFIX)) return GPT_CONTEXT_WINDOW;
  return undefined;
}

function resolveBudget(opts: ConductorProviderOptions, env: NodeJS.ProcessEnv): number {
  if (typeof opts.budgetPerMinute === 'number' && opts.budgetPerMinute > 0) {
    return opts.budgetPerMinute;
  }
  const fromEnv = Number(env[ENV_BUDGET]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_BUDGET_PER_MINUTE;
}

export function createConductorProvider(opts: ConductorProviderOptions = {}): ConductorProvider {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((msg: string) => console.log(`${LOG_PREFIX} ${msg}`));
  const stateDir = opts.stateDir ?? path.join(os.homedir(), SERVER_JSON_DIR);
  const state = new ConductorStateStore(path.join(stateDir, STATE_FILE_NAME), log);
  const logs = new SessionLogStore();
  const links = new LinkTracker();
  const clock = opts.clock ?? systemClock;
  const budget = resolveBudget(opts, env);

  let sink: AgentEventSink | undefined;
  let client: ConductorClient | undefined;
  let poller: ConductorPoller | undefined;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let connectFailures = 0;

  const setStatus = (status: Omit<StreamProviderStatus, 'scope'>) => {
    sink?.setStatus({ ...status, scope: state.scope });
  };

  /** /me, then the poller's first discovery. Network failures retry with backoff. */
  const connect = async (): Promise<void> => {
    if (stopped || !client || !sink) return;
    let me;
    try {
      me = await client.me();
    } catch (err) {
      if (err instanceof ConductorApiError && err.kind === 'unauthorized') {
        setStatus({
          state: 'unauthorized',
          message:
            'Conductor rejected the API key. Sign in again with `conductor auth login` or set CONDUCTOR_API_KEY, then restart.',
        });
        return;
      }
      const limited = err instanceof ConductorApiError && err.kind === 'rateLimited';
      setStatus({
        state: limited ? 'rateLimited' : 'unreachable',
        message: limited
          ? 'Conductor is rate limiting requests. Retrying.'
          : "Can't reach Conductor. Retrying.",
      });
      connectFailures += 1;
      const delay = Math.min(BACKOFF_MAX_MS, DISCOVERY_INTERVAL_MS * connectFailures);
      retryTimer = setTimeout(() => void connect(), delay);
      retryTimer.unref?.();
      return;
    }
    if (stopped) return;
    if (!me?.userId) {
      setStatus({
        state: 'unreachable',
        message: 'Conductor returned an unexpected account response.',
      });
      return;
    }
    poller = new ConductorPoller({
      client,
      sink,
      state,
      logs,
      links,
      me,
      clock,
      log,
      autoTick: opts.autoTick ?? true,
    });
    await poller.start();
  };

  const requirePoller = (): ConductorPoller => {
    if (!poller) throw new Error('Conductor is not connected');
    return poller;
  };

  /** Run a user action; failures become short, user-facing rejections. */
  const action = async (sessionId: string, run: (c: ConductorClient) => Promise<unknown>) => {
    if (!client || !poller) throw new Error('Conductor is not connected');
    try {
      await run(client);
    } catch (err) {
      throw new Error(userFacingMessage(err));
    }
    poller.promote(sessionId, true);
  };

  return {
    kind: 'stream',
    id: CONDUCTOR_PROVIDER_ID,
    displayName: CONDUCTOR_DISPLAY_NAME,
    protocolVersion: 1,

    formatToolStatus: formatConductorToolStatus,
    permissionExemptTools: CONDUCTOR_PERMISSION_EXEMPT_TOOLS,
    subagentToolNames: CONDUCTOR_SUBAGENT_TOOLS,
    readingTools: CONDUCTOR_READING_TOOLS,
    contextWindowForModel: conductorContextWindow,

    async start(s: AgentEventSink): Promise<void> {
      sink = s;
      stopped = false;
      try {
        setStatus({ state: 'connecting' });
        const auth = await resolveConductorAuth({
          env,
          platform: opts.platform ?? process.platform,
          execFile: opts.execFile ?? defaultExecFile,
        });
        if (stopped) return;
        if (!auth.token) {
          setStatus({ state: 'authRequired', message: AUTH_REQUIRED_MESSAGE });
          return;
        }
        log(`using token from ${auth.source}; budget ${budget}/min`);
        client = new ConductorClient({
          baseUrl: auth.baseUrl,
          token: auth.token,
          fetchImpl: opts.fetchImpl ?? fetch,
          budgetPerMinute: budget,
          clock,
        });
        await connect();
      } catch (err) {
        log(`start failed: ${(err as Error).message}`);
        setStatus({ state: 'unreachable', message: "Can't reach Conductor." });
      }
    },

    async stop(): Promise<void> {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      poller?.stop();
      client?.close();
      state.flush();
    },

    onDismiss(sessionId: string): void {
      if (poller) poller.setHidden(sessionId, true);
      else state.patchSession(sessionId, { hidden: true });
    },

    setSessionHidden(sessionId: string, hidden: boolean): void {
      if (poller) poller.setHidden(sessionId, hidden);
      else state.patchSession(sessionId, { hidden });
    },

    setSessionPinned(sessionId: string, pinned: boolean): void {
      if (poller) poller.setPinned(sessionId, pinned);
      else state.patchSession(sessionId, { pinned });
    },

    getScope(): ConductorScope {
      return state.scope;
    },

    setScope(scope: ConductorScope): void {
      const clean = sanitizeScope(scope, state.scope);
      if (poller) poller.setScope(clean);
      else {
        state.setScope(clean);
        sink?.setStatus({ state: 'connecting', scope: state.scope });
      }
    },

    listSessions(): ConductorSessionSummary[] {
      return poller ? poller.listSessions() : [];
    },

    async getSessionDetail(sessionId: string): Promise<StreamSessionDetail | null> {
      return poller ? poller.getSessionDetail(sessionId) : null;
    },

    async sendMessage(sessionId: string, text: string): Promise<void> {
      const message = text.trim();
      if (!message) throw new Error('Message is empty');
      await action(sessionId, (c) => c.sendMessage(sessionId, message, randomUUID()));
    },

    async stopSession(sessionId: string): Promise<void> {
      await action(sessionId, (c) => c.cancelSession(sessionId));
    },

    async archiveSession(sessionId: string): Promise<void> {
      await action(sessionId, (c) => c.archiveSession(sessionId));
      requirePoller().markArchived(sessionId);
    },

    async restoreSession(sessionId: string): Promise<void> {
      await action(sessionId, (c) => c.unarchiveSession(sessionId));
      await requirePoller().markRestored(sessionId);
    },

    setFocus(sessionIds: string[]): void {
      poller?.setFocus(sessionIds);
    },

    agentIdFor(sessionId: string): number | undefined {
      return state.session(sessionId)?.agentId;
    },

    rememberAgentId(sessionId: string, agentId: number): void {
      if (Number.isInteger(agentId) && agentId > 0) state.patchSession(sessionId, { agentId });
    },

    maxReservedAgentId(): number {
      return state.maxAgentId();
    },

    sessionPersona(sessionId: string): ConductorSessionPersona | undefined {
      const entry = state.session(sessionId);
      if (!entry || (entry.pokemonLine === undefined && entry.shiny === undefined))
        return undefined;
      return { pokemonLine: entry.pokemonLine, shiny: entry.shiny };
    },

    setSessionPersona(sessionId: string, persona: ConductorSessionPersona): void {
      state.patchSession(sessionId, { pokemonLine: persona.pokemonLine, shiny: persona.shiny });
    },

    async tick(): Promise<void> {
      await poller?.tick();
    },
  };
}
