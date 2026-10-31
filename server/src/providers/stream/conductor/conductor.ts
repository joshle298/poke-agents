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
  ModelChoice,
  StreamModelCatalog,
  StreamProvider,
  StreamProviderStatus,
  StreamSessionDetail,
} from '../../../../../core/src/provider.js';
import { SERVER_JSON_DIR } from '../../../constants.js';
import { contextWindowForModel as claudeContextWindow } from '../../hook/claude/claude.js';
import { buildModelCatalog, continuationName, parseModelChoice } from '../modelCatalog.js';
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
  CONTINUE_RETRY_BASE_MS,
  CONTINUE_RETRY_MAX,
  DEFAULT_BUDGET_PER_MINUTE,
  DISCOVERY_INTERVAL_MS,
  ENV_BUDGET,
  FAVORITES_TTL_MS,
  GPT_CONTEXT_WINDOW,
  GPT_MODEL_PREFIX,
  LOG_PREFIX,
  STATE_FILE_NAME,
} from './constants.js';
import type { Harness } from './harness.js';
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
    | 'getSessionHistory'
    | 'sendMessage'
    | 'stopSession'
    | 'archiveSession'
    | 'restoreSession'
    | 'setFocus'
    | 'getModelCatalog'
    | 'continueWithModel'
  >
>;

/**
 * The provider with every control. Agent ids and Pokémon are not its business:
 * the runtime's stream memory keeps them (StreamAgentMemory).
 */
export type ConductorProvider = StreamProvider &
  ConductorControls & {
    /** Test hook: one scheduling round (no-op before start or after stop). */
    tick(): Promise<void>;
  };

export function conductorContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  if (model.startsWith(CLAUDE_MODEL_PREFIX)) return claudeContextWindow(model);
  if (model.startsWith(GPT_MODEL_PREFIX)) return GPT_CONTEXT_WINDOW;
  return undefined;
}

/** Why a create-session failed, for the office (a 404 there is the workspace). */
function continueFailureMessage(err: unknown): string {
  if (err instanceof ConductorApiError && err.kind === 'notFound') {
    return "Conductor couldn't find this session's workspace.";
  }
  return userFacingMessage(err);
}

/** Network failures and 5xx may have created the session anyway: retry with
 *  the same ids and let Conductor deduplicate. */
function retryableCreate(err: unknown): boolean {
  return err instanceof ConductorApiError && (err.kind === 'network' || err.kind === 'server');
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
  const clock = opts.clock ?? systemClock;
  const state = new ConductorStateStore(path.join(stateDir, STATE_FILE_NAME), log, () =>
    clock.now(),
  );
  const logs = new SessionLogStore();
  const links = new LinkTracker();
  const budget = resolveBudget(opts, env);

  let sink: AgentEventSink | undefined;
  let client: ConductorClient | undefined;
  let poller: ConductorPoller | undefined;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let connectFailures = 0;
  /** The favorites last read (GET /v0/favorite-models) and when. */
  let favorites: { raw: unknown; at: number } | undefined;
  /** Sessions with a Switch model create in flight: one at a time each. */
  const continuing = new Set<string>();

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
          // The office shows the sign-in steps; say it in the terminal too,
          // where a first run is usually watched.
          log(`no sign-in found. ${AUTH_REQUIRED_MESSAGE}`);
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

    async getSessionHistory(sessionId: string, before?: string) {
      return requirePoller().getSessionHistory(sessionId, before);
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

    async getModelCatalog(): Promise<StreamModelCatalog> {
      const now = clock.now();
      if (client && (!favorites || now - favorites.at >= FAVORITES_TTL_MS)) {
        try {
          favorites = { raw: await client.listFavoriteModels(), at: now };
        } catch (err) {
          // The catalog still works without them; keep the last ones read.
          log(`favorite models unavailable: ${(err as Error).message}`);
        }
      }
      return buildModelCatalog(favorites?.raw);
    },

    async continueWithModel(
      sessionId: string,
      request: ModelChoice,
    ): Promise<{ sessionId: string }> {
      if (!client || !poller) throw new Error('Conductor is not connected');
      const parsed = parseModelChoice({ ...request }, buildModelCatalog(undefined));
      if (!parsed.ok) throw new Error(parsed.message);
      const choice = parsed.choice;
      const facts = poller.sessionFacts(sessionId);
      if (!facts) throw new Error('Session not found');
      if (continuing.has(sessionId)) throw new Error('A new session is already starting.');
      continuing.add(sessionId);
      try {
        // Both ids are ours, so a retry after a lost response names the same
        // session and message, and Conductor creates (and sends) them once.
        const body = {
          workspaceId: facts.workspaceId,
          sessionId: randomUUID(),
          agent: choice.agent,
          model: choice.model,
          ...(choice.effort ? { effort: choice.effort } : {}),
          ...(choice.fastMode ? { fastMode: true } : {}),
          name: continuationName(facts.name, choice.model),
          message: choice.message,
          messageId: randomUUID(),
        };
        let created;
        for (let attempt = 0; ; attempt++) {
          try {
            created = await client.createSession(body);
            break;
          } catch (err) {
            // A retry that finds its session already made means the lost
            // first attempt went through.
            if (attempt > 0 && err instanceof ConductorApiError && err.status === 409) {
              created = { id: body.sessionId, name: body.name, model: body.model };
              break;
            }
            if (attempt < CONTINUE_RETRY_MAX && retryableCreate(err) && !stopped) {
              await clock.sleep(CONTINUE_RETRY_BASE_MS * 2 ** attempt);
              continue;
            }
            throw new Error(continueFailureMessage(err));
          }
        }
        const id = typeof created?.id === 'string' && created.id ? created.id : body.sessionId;
        poller.addContinuation(
          {
            ...created,
            id,
            name: created?.name ?? body.name,
            model: created?.model ?? body.model,
            effort: created?.effort ?? body.effort,
            fastMode: created?.fastMode ?? body.fastMode,
          },
          facts.workspaceId,
          sessionId,
          { agent: choice.agent as Harness, message: choice.message },
        );
        return { sessionId: id };
      } finally {
        continuing.delete(sessionId);
      }
    },

    async tick(): Promise<void> {
      await poller?.tick();
    },
  };
}
