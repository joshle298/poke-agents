/**
 * Client messages that act on stream-provider sessions (Conductor): the
 * Pokédex panel's detail and actions, the Sessions modal's scope, hide and pin
 * controls, Archived sessions, and deep links. Dispatched from handleClientMessage
 * after its read-only gate, so every one of them is privileged.
 *
 * Agent-addressed messages resolve their session through the driver that owns
 * the agent; session-addressed ones go to the Conductor driver. Every action
 * answers its sender with conductorActionResult, success or not.
 *
 * Switch model (requestModelCatalog, continueWithModel) only asks Conductor to
 * start a new session: its API can't change a running session's model, and
 * Poke Agents never changes Conductor's stored settings. The request is
 * validated here against the maintained model table (no network) before the
 * provider sees it; the provider validates it again.
 *
 * The Pokédex detail and the chat history carry conversation text (prompts,
 * replies, commands), more than the office feed shows, so they are privileged
 * like everything else here: a read-only viewer (no token, e.g. a LAN watcher)
 * sees the office but not conversations; a device opened with the tokened URL
 * sees both.
 */

import type { ConductorAction, ConductorScope } from '../../core/src/messages.js';
import type { ClientMessageContext } from './clientMessageHandler.js';
import {
  AGENT_ERROR_MESSAGE_MAX_LENGTH,
  CONDUCTOR_SCOPE_MAX_HOURS,
  CONDUCTOR_SCOPE_MAX_SESSIONS,
  EXTERNAL_URL_HOST,
  EXTERNAL_URL_MAX_LENGTH,
  EXTERNAL_URL_SCHEME_PATTERN,
  MODEL_CATALOG_WAIT_MS,
  SESSION_MESSAGE_MAX_LENGTH,
} from './constants.js';
import {
  buildModelCatalog,
  catalogAgents,
  parseModelChoice,
} from './providers/stream/modelCatalog.js';
import type { StreamAgentDriver } from './streamAgentDriver.js';

type WsSend = (message: Record<string, unknown>) => void;

/** The stream provider that session-addressed messages (scope, hide, pin, archive) act on. */
const CONDUCTOR_PROVIDER_ID = 'conductor';

/** Provider session ids as they may arrive from a client. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

const NOT_ENABLED_MESSAGE = 'Conductor is not enabled on this server.';
const NOT_A_SESSION_MESSAGE = 'This agent is not a Conductor session.';
const INVALID_REQUEST_MESSAGE = 'Invalid request.';
const EMPTY_MESSAGE_MESSAGE = 'Type a message first.';
const MESSAGE_TOO_LONG_MESSAGE = 'Message is too long.';
const INVALID_SCOPE_MESSAGE = 'Invalid scope.';
const BLOCKED_LINK_MESSAGE = 'Only Conductor links can be opened.';
const NO_LINK_OPENER_MESSAGE = 'Opening links is not available here.';
const READ_ONLY_MESSAGE = 'Read-only office: open the tokened URL to make changes.';
const READ_ONLY_HISTORY_MESSAGE = 'Read-only office: open the tokened URL to read conversations.';
const HISTORY_FAILED_MESSAGE = "Couldn't load earlier messages.";
const NO_MODEL_CATALOG_MESSAGE = "Switching models isn't available here.";

/** History cursors as they may arrive from a client (the provider validates its own). */
const HISTORY_CURSOR_WIRE_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/;

/** Every message type this module handles. */
export const STREAM_SESSION_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'requestSessionDetail',
  'requestSessionHistory',
  'sendSessionMessage',
  'stopSession',
  'archiveSession',
  'restoreSession',
  'setSessionHidden',
  'setSessionPinned',
  'setConductorScope',
  'requestConductorSessions',
  'openExternal',
  'requestModelCatalog',
  'continueWithModel',
]);

/** Message types that answer with conductorActionResult. */
const ACTION_TYPES: ReadonlySet<string> = new Set<ConductorAction>([
  'sendSessionMessage',
  'stopSession',
  'openExternal',
  'setSessionHidden',
  'setSessionPinned',
  'setConductorScope',
  'archiveSession',
  'restoreSession',
  'continueWithModel',
]);

export function handleStreamSessionMessage(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): void {
  switch (msg.type) {
    case 'requestSessionDetail':
      void requestSessionDetail(msg, send, ctx);
      return;
    case 'requestSessionHistory':
      void requestSessionHistory(msg, send, ctx);
      return;
    case 'sendSessionMessage': {
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (!text.trim())
        return reply(send, 'sendSessionMessage', false, EMPTY_MESSAGE_MESSAGE, msg.id);
      if (text.length > SESSION_MESSAGE_MAX_LENGTH) {
        return reply(send, 'sendSessionMessage', false, MESSAGE_TOO_LONG_MESSAGE, msg.id);
      }
      return agentAction(msg, send, ctx, 'sendSessionMessage', (p, sessionId) =>
        p.sendMessage ? p.sendMessage(sessionId, text) : UNSUPPORTED,
      );
    }
    case 'stopSession':
      return agentAction(msg, send, ctx, 'stopSession', (p, sessionId) =>
        p.stopSession ? p.stopSession(sessionId) : UNSUPPORTED,
      );
    case 'archiveSession':
      return sessionAction(msg, send, ctx, 'archiveSession', (p, sessionId) =>
        p.archiveSession ? p.archiveSession(sessionId) : UNSUPPORTED,
      );
    case 'restoreSession':
      return sessionAction(msg, send, ctx, 'restoreSession', (p, sessionId) =>
        p.restoreSession ? p.restoreSession(sessionId) : UNSUPPORTED,
      );
    case 'setSessionHidden': {
      if (typeof msg.hidden !== 'boolean') {
        return reply(send, 'setSessionHidden', false, INVALID_REQUEST_MESSAGE);
      }
      const hidden = msg.hidden;
      return sessionAction(msg, send, ctx, 'setSessionHidden', (p, sessionId) =>
        p.setSessionHidden ? p.setSessionHidden(sessionId, hidden) : UNSUPPORTED,
      );
    }
    case 'setSessionPinned': {
      if (typeof msg.pinned !== 'boolean') {
        return reply(send, 'setSessionPinned', false, INVALID_REQUEST_MESSAGE);
      }
      const pinned = msg.pinned;
      return sessionAction(msg, send, ctx, 'setSessionPinned', (p, sessionId) =>
        p.setSessionPinned ? p.setSessionPinned(sessionId, pinned) : UNSUPPORTED,
      );
    }
    case 'setConductorScope': {
      const scope = parseScope(msg.scope);
      if (!scope) return reply(send, 'setConductorScope', false, INVALID_SCOPE_MESSAGE);
      const driver = conductorDriver(ctx);
      if (!driver) return reply(send, 'setConductorScope', false, NOT_ENABLED_MESSAGE);
      return run(send, 'setConductorScope', undefined, driver, () =>
        driver.provider.setScope ? driver.provider.setScope(scope) : UNSUPPORTED,
      );
    }
    case 'requestConductorSessions':
      send({ type: 'conductorSessions', sessions: conductorDriver(ctx)?.sessionsSnapshot() ?? [] });
      return;
    case 'openExternal':
      void openExternal(msg.url, send, ctx);
      return;
    case 'requestModelCatalog':
      void requestModelCatalog(send, ctx);
      return;
    case 'continueWithModel':
      void continueWithModel(msg, send, ctx);
      return;
  }
}

/**
 * The read-only gate's answer for these messages: actions get a refusal (so a
 * pending control settles), and the optimistic Sessions-modal toggles get the
 * real state back.
 */
export function refuseStreamSessionMessage(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): void {
  const type = String(msg.type);
  if (type === 'requestModelCatalog') {
    // Settle the picker instead of leaving it loading.
    send({ type: 'modelCatalog', agents: [], favorites: [], error: READ_ONLY_MESSAGE });
    return;
  }
  if (type === 'requestSessionHistory') {
    // Settle the chat view's "Load earlier" instead of leaving it spinning.
    if (isAgentId(msg.id)) {
      send({
        type: 'sessionHistory',
        id: msg.id,
        entries: [],
        hasMore: false,
        error: READ_ONLY_HISTORY_MESSAGE,
      });
    }
    return;
  }
  if (!ACTION_TYPES.has(type)) return;
  const driver = conductorDriver(ctx);
  if (type === 'setSessionHidden' || type === 'setSessionPinned') {
    // The cached list: asking the provider (listSessions) would also start
    // the archived listings (Archived sessions), an effect only privileged clients get.
    if (driver) send({ type: 'conductorSessions', sessions: driver.cachedSessionsSnapshot() });
  } else if (type === 'setConductorScope') {
    const status = driver?.statusMessage();
    if (status) send(status);
  }
  reply(send, type as ConductorAction, false, READ_ONLY_MESSAGE, agentIdOf(msg, driver));
}

/** Whether a deep link may be opened on the host: a Conductor scheme
 *  (`conductor:` or `conductor-<channel>:`) naming the `workspace` host. */
export function isAllowedExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > EXTERNAL_URL_MAX_LENGTH) {
    return false;
  }
  // Control characters and whitespace never belong in a deep link, and some
  // openers treat them as argument separators.
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    EXTERNAL_URL_SCHEME_PATTERN.test(parsed.protocol) &&
    parsed.hostname === EXTERNAL_URL_HOST &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === ''
  );
}

// ── Handlers ────────────────────────────────────────────────────

async function requestSessionDetail(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): Promise<void> {
  const id = msg.id;
  if (!isAgentId(id)) return;
  const driver = ctx.runtime?.streamDriverForAgent(id);
  const sessionId = driver?.sessionIdFor(id);
  if (!driver || sessionId === undefined) {
    send({ type: 'sessionDetail', id, entries: [] });
    return;
  }
  const provider = driver.provider;
  try {
    // An open Pokédex asks every few seconds: keep its session polled fast.
    provider.setFocus?.([sessionId]);
    const detail = (await provider.getSessionDetail?.(sessionId)) ?? null;
    send({
      type: 'sessionDetail',
      id,
      prompt: detail?.prompt,
      entries: withPeerIds(detail?.entries ?? [], driver),
      truncated: detail?.truncated,
      question: detail?.question,
    });
  } catch (err) {
    // Keep whatever the panel already shows; a later request may succeed.
    console.error(
      `[Pixel Agents] Session detail for agent ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** One page of an agent's older conversation (the Pokédex chat view). */
async function requestSessionHistory(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): Promise<void> {
  const id = msg.id;
  if (!isAgentId(id)) return;
  const answer = (
    page: { entries?: unknown[]; before?: string; hasMore?: boolean },
    error?: string,
  ) =>
    send({
      type: 'sessionHistory',
      id,
      entries: page.entries ?? [],
      before: page.before,
      hasMore: page.hasMore ?? false,
      error,
    });
  const before = msg.before;
  if (
    before !== undefined &&
    (typeof before !== 'string' || !HISTORY_CURSOR_WIRE_PATTERN.test(before))
  ) {
    answer({}, INVALID_REQUEST_MESSAGE);
    return;
  }
  const driver = ctx.runtime?.streamDriverForAgent(id);
  const sessionId = driver?.sessionIdFor(id);
  if (!driver || sessionId === undefined) {
    answer({}, NOT_A_SESSION_MESSAGE);
    return;
  }
  const provider = driver.provider;
  if (!provider.getSessionHistory) {
    answer({}, `${provider.displayName} does not support this.`);
    return;
  }
  try {
    // The chat view is open: keep the session polled fast, like the Pokédex.
    provider.setFocus?.([sessionId]);
    const page = await provider.getSessionHistory(sessionId, before);
    answer({ ...page, entries: withPeerIds(page.entries, driver) });
  } catch (err) {
    answer({}, err instanceof Error && err.message ? userMessage(err) : HISTORY_FAILED_MESSAGE);
  }
}

/** Entries with peer session ids mapped to the agent ids in the office. */
function withPeerIds(
  entries: ReadonlyArray<{ peerSessionId?: string } & Record<string, unknown>>,
  driver: StreamAgentDriver,
): Array<Record<string, unknown>> {
  return entries.map(({ peerSessionId, ...entry }) => ({
    ...entry,
    peerId: peerSessionId !== undefined ? driver.agentIdFor(peerSessionId) : undefined,
  }));
}

async function openExternal(url: unknown, send: WsSend, ctx: ClientMessageContext): Promise<void> {
  if (!isAllowedExternalUrl(url)) {
    reply(send, 'openExternal', false, BLOCKED_LINK_MESSAGE);
    return;
  }
  if (!ctx.openExternal) {
    reply(send, 'openExternal', false, NO_LINK_OPENER_MESSAGE);
    return;
  }
  try {
    await ctx.openExternal(new URL(url).href);
    reply(send, 'openExternal', true);
  } catch (err) {
    reply(send, 'openExternal', false, userMessage(err));
  }
}

/**
 * The Switch model picker's catalog, from the Conductor provider. When the
 * favorites take longer than MODEL_CATALOG_WAIT_MS (a rate-limit pause, a slow
 * network), the table goes out at once and the full catalog when it is ready,
 * so the picker never waits on them.
 */
async function requestModelCatalog(send: WsSend, ctx: ClientMessageContext): Promise<void> {
  const provider = conductorDriver(ctx)?.provider;
  if (!provider?.getModelCatalog) {
    send({ type: 'modelCatalog', agents: [], favorites: [], error: NO_MODEL_CATALOG_MESSAGE });
    return;
  }
  const full = provider.getModelCatalog().then(
    (catalog) => ({ ok: true as const, catalog }),
    (err: unknown) => ({ ok: false as const, error: userMessage(err) }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), MODEL_CATALOG_WAIT_MS);
    timer.unref?.();
  });
  const first = await Promise.race([full, late]);
  clearTimeout(timer);
  if (first) {
    send(
      first.ok
        ? { type: 'modelCatalog', ...first.catalog }
        : { type: 'modelCatalog', agents: [], favorites: [], error: first.error },
    );
    return;
  }
  send({ type: 'modelCatalog', ...buildModelCatalog(undefined) });
  const settled = await full;
  // A late failure keeps the table the picker already has.
  if (settled.ok) send({ type: 'modelCatalog', ...settled.catalog });
}

/**
 * Switch model: start a new session in the agent's workspace with the chosen
 * agent and model, seeded with the user's message. Validated against the
 * provider's catalog; the result names the new session, so the office can
 * open its Pokédex once it arrives.
 */
async function continueWithModel(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): Promise<void> {
  const id = msg.id;
  if (!isAgentId(id)) return reply(send, 'continueWithModel', false, INVALID_REQUEST_MESSAGE);
  const driver = ctx.runtime?.streamDriverForAgent(id);
  const sessionId = driver?.sessionIdFor(id);
  if (!driver || sessionId === undefined) {
    return reply(send, 'continueWithModel', false, NOT_A_SESSION_MESSAGE, id);
  }
  const provider = driver.provider;
  if (!provider.continueWithModel) {
    return reply(
      send,
      'continueWithModel',
      false,
      `${provider.displayName} does not support this.`,
      id,
    );
  }
  // The maintained table, not the provider's catalog: validating must not
  // wait on (or spend budget for) the favorites.
  const parsed = parseModelChoice(msg, { agents: catalogAgents() });
  if (!parsed.ok) return reply(send, 'continueWithModel', false, parsed.message, id);
  try {
    const started = await provider.continueWithModel(sessionId, parsed.choice);
    send({
      type: 'conductorActionResult',
      action: 'continueWithModel',
      id,
      ok: true,
      sessionId: started.sessionId,
    });
  } catch (err) {
    reply(send, 'continueWithModel', false, userMessage(err), id);
  }
}

/** What a provider call returns when the provider lacks the method. */
const UNSUPPORTED = Symbol('unsupported');

type CallOutcome = Promise<void> | void | typeof UNSUPPORTED;

type ProviderCall = (provider: StreamAgentDriver['provider'], sessionId: string) => CallOutcome;

/** An action on the session behind an agent id. */
function agentAction(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
  action: ConductorAction,
  call: ProviderCall,
): void {
  const id = msg.id;
  if (!isAgentId(id)) return reply(send, action, false, INVALID_REQUEST_MESSAGE);
  const driver = ctx.runtime?.streamDriverForAgent(id);
  const sessionId = driver?.sessionIdFor(id);
  if (!driver || sessionId === undefined)
    return reply(send, action, false, NOT_A_SESSION_MESSAGE, id);
  run(send, action, id, driver, () => call(driver.provider, sessionId));
}

/** An action on a session named by its provider id (it may not be in the office). */
function sessionAction(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
  action: ConductorAction,
  call: ProviderCall,
): void {
  const sessionId = msg.sessionId;
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    return reply(send, action, false, INVALID_REQUEST_MESSAGE);
  }
  const driver = conductorDriver(ctx);
  if (!driver) return reply(send, action, false, NOT_ENABLED_MESSAGE);
  const id = driver.agentIdFor(sessionId);
  run(send, action, id, driver, () => call(driver.provider, sessionId));
}

/** Run a provider call (sync or async) and answer with its outcome. */
function run(
  send: WsSend,
  action: ConductorAction,
  id: number | undefined,
  driver: StreamAgentDriver,
  call: () => CallOutcome,
): void {
  let outcome: CallOutcome;
  try {
    outcome = call();
  } catch (err) {
    reply(send, action, false, userMessage(err), id);
    return;
  }
  if (outcome === UNSUPPORTED) {
    reply(send, action, false, `${driver.provider.displayName} does not support this.`, id);
    return;
  }
  Promise.resolve(outcome).then(
    () => reply(send, action, true, undefined, id),
    (err: unknown) => reply(send, action, false, userMessage(err), id),
  );
}

// ── Helpers ─────────────────────────────────────────────────────

function conductorDriver(ctx: ClientMessageContext): StreamAgentDriver | undefined {
  return ctx.runtime?.streamDriver(CONDUCTOR_PROVIDER_ID);
}

function reply(
  send: WsSend,
  action: ConductorAction,
  ok: boolean,
  message?: string,
  id?: unknown,
): void {
  send({
    type: 'conductorActionResult',
    action,
    id: isAgentId(id) ? id : undefined,
    ok,
    message,
  });
}

function agentIdOf(msg: Record<string, unknown>, driver: StreamAgentDriver | undefined): unknown {
  if (msg.id !== undefined) return msg.id;
  return typeof msg.sessionId === 'string' ? driver?.agentIdFor(msg.sessionId) : undefined;
}

function isAgentId(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

/** Providers reject with user-facing messages; anything else gets a generic one. */
function userMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const trimmed = text.trim();
  if (!trimmed) return 'Something went wrong.';
  return trimmed.length > AGENT_ERROR_MESSAGE_MAX_LENGTH
    ? `${trimmed.slice(0, AGENT_ERROR_MESSAGE_MAX_LENGTH - 1)}…`
    : trimmed;
}

function parseScope(raw: unknown): ConductorScope | null {
  if (!raw || typeof raw !== 'object') return null;
  const { creator, activeWithinHours, showIdle, maxSessions } = raw as Record<string, unknown>;
  if (creator !== 'me' && creator !== 'all') return null;
  if (
    typeof activeWithinHours !== 'number' ||
    !Number.isFinite(activeWithinHours) ||
    activeWithinHours < 0 ||
    activeWithinHours > CONDUCTOR_SCOPE_MAX_HOURS
  ) {
    return null;
  }
  if (typeof showIdle !== 'boolean') return null;
  if (
    typeof maxSessions !== 'number' ||
    !Number.isSafeInteger(maxSessions) ||
    maxSessions < 1 ||
    maxSessions > CONDUCTOR_SCOPE_MAX_SESSIONS
  ) {
    return null;
  }
  return { creator, activeWithinHours, showIdle, maxSessions };
}
