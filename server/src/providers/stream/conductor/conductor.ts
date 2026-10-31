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

import type {
  ConductorAuthEnv,
  ConductorAuthSource,
  ConductorConnectionState,
  ConductorScope,
  ConductorSessionSummary,
} from '../../../../../core/src/messages.js';
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
import {
  type ConductorAuth,
  defaultExecFile,
  type ExecFileFn,
  resolveConductorAuth,
} from './auth.js';
import {
  type ClientClock,
  ConductorApiError,
  ConductorClient,
  systemClock,
  userFacingMessage,
} from './client.js';
import {
  API_KEYS_PAGE_URL,
  AUTH_REQUIRED_MESSAGE,
  BACKOFF_MAX_MS,
  CLAUDE_MODEL_PREFIX,
  CONDUCTOR_DISPLAY_NAME,
  CONDUCTOR_PROVIDER_ID,
  CONTINUE_RETRY_BASE_MS,
  CONTINUE_RETRY_MAX,
  CONTINUE_REUSE_MS,
  DEFAULT_BUDGET_PER_MINUTE,
  DISCOVERY_INTERVAL_MS,
  ENV_BUDGET,
  envUnauthorizedMessage,
  FAVORITES_RETRY_MS,
  FAVORITES_TTL_MS,
  GPT_CONTEXT_WINDOW,
  GPT_MODEL_PREFIX,
  LOG_PREFIX,
  PRIORITY_USER,
  SIGN_IN_RECHECK_MS,
  STATE_FILE_NAME,
  UNAUTHORIZED_MESSAGE,
} from './constants.js';
import type { Harness } from './harness.js';
import { type ConductorKeyStore, createConductorKeyStore } from './keyStore.js';
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
import type { ConductorCreatedSession, ConductorCreateSessionBody } from './types.js';

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
  /** Poke Agents' own store for a key connected in the office (keyStore.ts).
   *  The office passes the one it shares with its sign-in controller. */
  keyStore?: ConductorKeyStore;
  /** Called once per start, when the sign-in is settled: the source found
   *  (undefined: none, a failed start, or stopped first). Never the token. */
  onSignInSettled?: (source: ConductorAuthSource | undefined) => void;
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
    | 'recheckSignIn'
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

/** What the office's log says about where the key came from (never the key). */
function describeSource(auth: ConductorAuth): string {
  switch (auth.source) {
    case 'env':
      return `the key from ${auth.envName ?? 'the environment'}`;
    case 'app':
      return 'the key Poke Agents saved in the Keychain';
    case 'session':
      return 'the key connected in the office (kept in memory until the office stops)';
    case 'cli':
      return "the Conductor CLI's Keychain sign-in";
    default:
      return 'no key';
  }
}

/** Why a create-session failed, for the office (a 404 there is the workspace). */
function continueFailureMessage(err: unknown): string {
  if (err instanceof ConductorApiError && err.kind === 'notFound') {
    return "Conductor couldn't find this session's workspace.";
  }
  return userFacingMessage(err);
}

/** Conductor never confirmed the create, and couldn't say whether it exists. */
const CONTINUE_UNCONFIRMED_MESSAGE =
  "Conductor didn't confirm the new session. Start again with the same choice: it won't make a second one.";

/** Network failures and 5xx may have created the session anyway: retry with
 *  the same ids and let Conductor deduplicate. */
function retryableCreate(err: unknown): boolean {
  return err instanceof ConductorApiError && (err.kind === 'network' || err.kind === 'server');
}

/** A 409 isn't in the create's documented answers; it may mean the session
 *  (our id) already exists, which is checked before believing it. */
function isConflict(err: unknown): boolean {
  return err instanceof ConductorApiError && err.status === 409;
}

/** Identity of a Switch model request: the same one again reuses its ids. */
function choiceKey(choice: ModelChoice): string {
  return JSON.stringify([
    choice.agent,
    choice.model,
    choice.effort ?? '',
    choice.fastMode === true,
    choice.message,
  ]);
}

/** The last create-session from one source session (Switch model). */
interface RecentCreate {
  key: string;
  body: ConductorCreateSessionBody;
  at: number;
  /** Set once Conductor confirmed it (201, or found it afterwards). */
  createdId?: string;
}

/**
 * Whether the session a create named exists in its workspace: true or false
 * when Conductor says, undefined when it can't be asked. The id is a random
 * UUID the office chose, so finding it means the create went through.
 */
async function createdSessionExists(
  client: ConductorClient,
  body: ConductorCreateSessionBody,
): Promise<boolean | undefined> {
  try {
    const status = await client.getSessionStatus(body.sessionId, PRIORITY_USER);
    return status?.workspaceId === undefined || status.workspaceId === body.workspaceId;
  } catch (err) {
    if (err instanceof ConductorApiError && err.kind === 'notFound') return false;
    return undefined;
  }
}

/** Favorites reads Conductor refused (the endpoint is cloud-only: a local
 *  organization answers 404) are not asked again for a full TTL. */
function favoritesRefused(err: unknown): boolean {
  return (
    err instanceof ConductorApiError &&
    (err.kind === 'notFound' || err.kind === 'unauthorized' || err.kind === 'badRequest')
  );
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
  const platform = opts.platform ?? process.platform;
  const execFile = opts.execFile ?? defaultExecFile;
  const keyStore = opts.keyStore ?? createConductorKeyStore({ platform, execFile });

  let sink: AgentEventSink | undefined;
  let authSource: ConductorAuthSource | undefined;
  /** The variable an `env` key came from. */
  let authEnv: ConductorAuthEnv | undefined;
  let settle: ((source: ConductorAuthSource | undefined) => void) | undefined;
  let client: ConductorClient | undefined;
  let poller: ConductorPoller | undefined;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let connectFailures = 0;
  /** While signed out: the next look for a sign-in (macOS only). */
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;
  /** The look in flight: a Keychain read may wait on the user's answer. */
  let rechecking: Promise<void> | undefined;
  /** False once reading the Conductor CLI's Keychain item was refused (access
   *  denied, the prompt dismissed or timed out): another read would only ask
   *  again, so this provider leaves it until Reconnect starts a new one. */
  let readCli = true;
  /** The favorites last read (GET /v0/favorite-models) and when. */
  let favorites: { raw: unknown; at: number } | undefined;
  /** After a failed favorites read: not before this (epoch ms). */
  let favoritesRetryAt = 0;
  /** The favorites read in flight, shared by concurrent callers. */
  let favoritesRead: Promise<void> | undefined;
  /** Sessions with a Switch model create in flight: one at a time each. */
  const continuing = new Set<string>();
  /** Per source session, its last Switch model create (CONTINUE_REUSE_MS). */
  const recentCreates = new Map<string, RecentCreate>();

  /** Where the key came from, where a pasted one is kept, and in the sign-in
   *  states where to get one: the Connect card and Settings read them. */
  const signInFields = (connection: ConductorConnectionState): Partial<StreamProviderStatus> => ({
    ...(authSource ? { authSource } : {}),
    ...(authEnv ? { authEnv } : {}),
    keyStorage: keyStore.storage,
    ...(connection === 'authRequired' || connection === 'unauthorized'
      ? { keyPageUrl: API_KEYS_PAGE_URL }
      : {}),
  });

  /** The provider's own last status (before a poller takes over), so a scope
   *  change while signed out keeps saying so. */
  let ownStatus: Omit<StreamProviderStatus, 'scope'> | undefined;
  const setStatus = (status: Omit<StreamProviderStatus, 'scope'>) => {
    ownStatus = status;
    sink?.setStatus({ ...status, ...signInFields(status.state), scope: state.scope });
  };

  const unauthorizedMessage = (): string =>
    authSource === 'env' ? envUnauthorizedMessage(authEnv) : UNAUTHORIZED_MESSAGE;

  /** /me, then the poller's first discovery. Network failures retry with backoff. */
  const connect = async (): Promise<void> => {
    if (stopped || !client || !sink) return;
    let me;
    try {
      me = await client.me();
    } catch (err) {
      if (err instanceof ConductorApiError && err.kind === 'unauthorized') {
        setStatus({ state: 'unauthorized', message: unauthorizedMessage() });
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
      statusFields: signInFields,
      unauthorizedMessage: unauthorizedMessage(),
    });
    await poller.start();
  };

  const requirePoller = (): ConductorPoller => {
    if (!poller) throw new Error('Conductor is not connected');
    return poller;
  };

  /** Every sign-in the office may use, in order (auth.ts), remembering a
   *  refused read of the CLI's item. */
  const resolveAuth = async (): Promise<ConductorAuth> => {
    const auth = await resolveConductorAuth({ env, platform, execFile, keyStore, readCli });
    if (auth.cliUnreadable) readCli = false;
    return auth;
  };

  /** Connect with a key resolveAuth found: /me, then the poller. */
  const signIn = async (auth: ConductorAuth & { token: string }): Promise<void> => {
    log(`using ${describeSource(auth)}; budget ${budget}/min`);
    client = new ConductorClient({
      baseUrl: auth.baseUrl,
      token: auth.token,
      fetchImpl: opts.fetchImpl ?? fetch,
      budgetPerMinute: budget,
      clock,
    });
    await connect();
  };

  /** Still signed out, with nothing connecting. */
  const signedOut = (): boolean => !stopped && !client && ownStatus?.state === 'authRequired';

  /**
   * While signed out, look again for a sign-in saved outside the office
   * (`conductor auth login`, or Poke Agents' own Keychain item), and connect
   * when one turns up. On macOS only, where those live: elsewhere a key
   * arrives only through the Connect card, which starts a new provider.
   */
  const scheduleRecheck = (): void => {
    if (platform !== 'darwin' || !signedOut() || recheckTimer || rechecking) return;
    recheckTimer = setTimeout(() => {
      recheckTimer = undefined;
      void recheckSignIn();
    }, SIGN_IN_RECHECK_MS);
    recheckTimer.unref?.();
  };

  const recheckSignIn = (): Promise<void> => {
    if (rechecking || !signedOut()) return rechecking ?? Promise.resolve();
    clearTimeout(recheckTimer);
    recheckTimer = undefined;
    rechecking = (async () => {
      try {
        const auth = await resolveAuth();
        if (!auth.token || !signedOut()) return;
        authSource = auth.source;
        authEnv = auth.envName;
        log('found a sign-in made outside the office');
        setStatus({ state: 'connecting' });
        await signIn({ ...auth, token: auth.token });
      } catch (err) {
        log(`sign-in check failed: ${(err as Error).message}`);
      } finally {
        rechecking = undefined;
        scheduleRecheck();
      }
    })();
    return rechecking;
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

  /** Read the favorites once for every caller waiting; a failure keeps the
   *  last ones read and isn't retried before favoritesRetryAt. */
  const readFavorites = (c: ConductorClient): Promise<void> => {
    favoritesRead ??= (async () => {
      try {
        favorites = { raw: await c.listFavoriteModels(), at: clock.now() };
        favoritesRetryAt = 0;
      } catch (err) {
        // The catalog still works without them.
        favoritesRetryAt =
          clock.now() + (favoritesRefused(err) ? FAVORITES_TTL_MS : FAVORITES_RETRY_MS);
        log(`favorite models unavailable: ${(err as Error).message}`);
      } finally {
        favoritesRead = undefined;
      }
    })();
    return favoritesRead;
  };

  /**
   * POST /v0/sessions with `body`: network failures and 5xx are retried with
   * the same ids. When a request with these ids may have gone through (no
   * answer, a 5xx, an undocumented 409, or any failure after an earlier
   * attempt, or an earlier click, sent them), Conductor is asked whether the
   * session exists before anything is said. Resolves with what Conductor
   * returned, or a stand-in built from `body` when the session was found
   * afterwards; `unconfirmed` when nobody knows.
   */
  const createOnce = async (
    c: ConductorClient,
    body: ConductorCreateSessionBody,
    sentBefore: boolean,
  ): Promise<ConductorCreatedSession | 'unconfirmed'> => {
    let failure: unknown;
    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        return await c.createSession(body);
      } catch (err) {
        failure = err;
        if (attempts <= CONTINUE_RETRY_MAX && retryableCreate(err) && !stopped) {
          await clock.sleep(CONTINUE_RETRY_BASE_MS * 2 ** (attempts - 1));
          continue;
        }
        break;
      }
    }
    const mayExist = sentBefore || attempts > 1 || retryableCreate(failure) || isConflict(failure);
    if (!mayExist) throw new Error(continueFailureMessage(failure));
    const exists = await createdSessionExists(c, body);
    if (exists === undefined) return 'unconfirmed';
    if (!exists) throw new Error(continueFailureMessage(failure));
    return {
      id: body.sessionId,
      name: body.name,
      model: body.model,
      effort: body.effort,
      fastMode: body.fastMode,
    };
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
      authSource = undefined;
      authEnv = undefined;
      readCli = true;
      settle = opts.onSignInSettled;
      const settled = (source: ConductorAuthSource | undefined): void => {
        const notify = settle;
        settle = undefined;
        notify?.(source);
      };
      try {
        setStatus({ state: 'connecting' });
        const auth = await resolveAuth();
        if (stopped) {
          settled(undefined);
          return;
        }
        authSource = auth.source;
        authEnv = auth.envName;
        settled(auth.source);
        if (!auth.token) {
          // The office shows the Connect card; say it in the terminal too,
          // where a first run is usually watched.
          log(`no sign-in found. ${AUTH_REQUIRED_MESSAGE}`);
          setStatus({ state: 'authRequired', message: AUTH_REQUIRED_MESSAGE });
          scheduleRecheck();
          return;
        }
        await signIn({ ...auth, token: auth.token });
      } catch (err) {
        settled(undefined);
        log(`start failed: ${(err as Error).message}`);
        setStatus({ state: 'unreachable', message: "Can't reach Conductor." });
      }
    },

    async stop(): Promise<void> {
      stopped = true;
      const notify = settle;
      settle = undefined;
      notify?.(undefined);
      if (retryTimer) clearTimeout(retryTimer);
      clearTimeout(recheckTimer);
      recheckTimer = undefined;
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
        setStatus(ownStatus ?? { state: 'connecting' });
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

    recheckSignIn(): void {
      void recheckSignIn();
    },

    async getModelCatalog(): Promise<StreamModelCatalog> {
      const now = clock.now();
      const fresh = favorites !== undefined && now - favorites.at < FAVORITES_TTL_MS;
      if (client && !fresh && now >= favoritesRetryAt) await readFavorites(client);
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
      const c = client;
      const p = poller;
      try {
        const key = choiceKey(choice);
        let recent = recentCreates.get(sessionId);
        if (recent && clock.now() - recent.at >= CONTINUE_REUSE_MS) {
          recentCreates.delete(sessionId);
          recent = undefined;
        }
        // The same request again: if it went through, it's the same session
        // (its answer may have been lost on the way to the office).
        if (recent?.key === key && recent.createdId) return { sessionId: recent.createdId };
        if (recent && recent.key !== key && !recent.createdId) {
          // Another choice after an unconfirmed create: find out whether that
          // one exists before starting a second session in the same files.
          const exists = await createdSessionExists(c, recent.body);
          if (exists === undefined) throw new Error(CONTINUE_UNCONFIRMED_MESSAGE);
          if (exists) {
            p.addContinuation(
              { id: recent.body.sessionId, name: recent.body.name, model: recent.body.model },
              facts.workspaceId,
              sessionId,
              { agent: recent.body.agent as Harness, message: recent.body.message },
            );
            recentCreates.set(sessionId, { ...recent, createdId: recent.body.sessionId });
            throw new Error(`The last try did start “${recent.body.name}”.`);
          }
          recentCreates.delete(sessionId);
          recent = undefined;
        }
        // Both ids are ours, so a retry after a lost response (this call's or
        // an earlier click's) names the same session and message, and
        // Conductor creates (and sends) them once.
        const reuse = recent?.key === key ? recent.body : undefined;
        const body: ConductorCreateSessionBody = reuse ?? {
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
        try {
          created = await createOnce(c, body, reuse !== undefined);
        } catch (err) {
          recentCreates.delete(sessionId);
          throw err;
        }
        if (created === 'unconfirmed') {
          recentCreates.set(sessionId, { key, body, at: clock.now() });
          throw new Error(CONTINUE_UNCONFIRMED_MESSAGE);
        }
        const id = typeof created.id === 'string' && created.id ? created.id : body.sessionId;
        p.addContinuation(
          {
            ...created,
            id,
            name: created.name ?? body.name,
            model: created.model ?? body.model,
            effort: created.effort ?? body.effort,
            fastMode: created.fastMode ?? body.fastMode,
          },
          facts.workspaceId,
          sessionId,
          { agent: choice.agent as Harness, message: choice.message },
        );
        recentCreates.set(sessionId, { key, body, at: clock.now(), createdId: id });
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
