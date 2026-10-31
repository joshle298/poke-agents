import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import type { HookProvider } from '../../core/src/provider.js';
import { agentCreatedMessage } from './agentMessages.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import { registerSoundRoutes } from './audio/routes.js';
import type {
  AssetCache,
  OpenExternalSideEffect,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import { handleClientMessage } from './clientMessageHandler.js';
import {
  HOOK_API_PREFIX,
  LAUNCH_CODE_API_PATH,
  LAUNCH_PATH_PREFIX,
  MAX_HOOK_BODY_SIZE,
  REFUSED_HOST_LOG_MAX,
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_CLOSE_UNAUTHORIZED,
} from './constants.js';
import { LaunchCodes } from './launchCodes.js';
import { registerPokemonRoutes } from './pokemon/routes.js';
import { createSpeciesDelivery } from './pokemon/speciesDelivery.js';
import type { PtySessionManager } from './terminal/ptySessionManager.js';
import { registerTerminalRoutes } from './terminal/terminalRoutes.js';
import type { AgentState } from './types.js';
import {
  bearerTokenValid,
  isAllowedWebSocketOrigin,
  normalizeHostname,
  privilegedHostnames,
  redactTokenQuery,
  standaloneConnectionHostAllowed,
  standaloneHandshakeVerdict,
} from './wsAuth.js';

/** Options for creating the HTTP + WebSocket server. */
export interface HttpServerOptions {
  /** true = VS Code embedded mode (ephemeral port, no static, quiet logging) */
  embedded: boolean;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Port to listen on. Default: 0 (auto-assign) */
  port?: number;
  /** Bearer auth token for hook and WebSocket endpoints */
  token: string;
  /** AgentStateStore for WebSocket broadcast piping */
  store: AgentStateStore;
  /** Shared agent lifecycle core (for toggle side effects + standalone restore). Optional in embedded mode. */
  runtime?: AgentRuntime;
  /** Path to SPA dist directory for static serving (standalone only) */
  staticDir?: string;
  /** Cached assets loaded at startup (standalone only) */
  assetCache?: AssetCache;
  /** Callback when a hook event is received */
  onHookEvent?: (providerId: string, event: Record<string, unknown>) => void;
  /** Invoked when setHooksEnabled is toggled via WebSocket. Standalone installs/uninstalls hooks here. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Invoked when an external asset directory is added/removed. Standalone reloads + re-broadcasts assets here. */
  onReloadAssets?: ReloadAssetsSideEffect;
  /** PTY terminals for standalone-launched agents. Absent = terminal feature off
   *  (VS Code embedded mode, where the editor owns terminals). */
  ptyManager?: PtySessionManager;
  /** Extra Host names (beyond loopback and a specific bind address) a
   *  privileged standalone handshake may arrive under -- e.g. a reverse proxy's
   *  public name. See wsAuth.privilegedHostnames. */
  allowedHosts?: readonly string[];
  /** Hook providers this office runs (ClientMessageContext.hookProviders).
   *  Absent = every bundled one; empty when Claude Code tracking is off. */
  hookProviders?: readonly HookProvider[];
  /** Opens a validated Conductor deep link on the host (standalone). */
  openExternal?: OpenExternalSideEffect;
}

/** Result of createHttpServer(). */
export interface HttpServerHandle {
  app: FastifyInstance;
  port: number;
}

const startTime = Date.now();

/**
 * Create a Fastify server with hook endpoint, health check, and WebSocket support.
 *
 * All Fastify-specific code lives in this file. The rest of the server layer is
 * framework-agnostic. If Fastify is ever replaced, only this file changes.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({
    // Standalone logs every request. The privilege token rides `/ws?token=`
    // and `/terminal/:id?token=` handshakes, so the url is redacted before it
    // is written -- otherwise every (re)connect would put the secret in stdout
    // and any log file (see wsAuth.redactTokenQuery).
    logger: options.embedded ? false : { serializers: { req: serializeRequestForLog } },
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Static SPA serving (standalone mode only)
  if (!options.embedded && options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
    });
    // HTML5 history fallback: serve index.html for unmatched routes
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  // ── Routes ──────────────────────────────────────────────────

  const host = options.host ?? '127.0.0.1';
  const allowedHostnames = privilegedHostnames(host, options.allowedHosts ?? []);

  registerHealthRoute(app);
  registerHookRoute(app, options);
  if (!options.embedded) registerLaunchRoutes(app, options.token, allowedHostnames);
  registerWebSocketRoute(app, options, allowedHostnames);
  registerTerminalRoutes(app, {
    token: options.token,
    allowedHostnames,
    ptyManager: options.ptyManager,
  });
  // Pokémon sprites are standalone-only: VS Code keeps the upstream characters.
  if (!options.embedded) {
    registerPokemonRoutes(app, { allowedHostnames, store: options.store });
    // Cries and the user's sound pack, same rules as the sprites.
    registerSoundRoutes(app, { allowedHostnames, store: options.store });
  }

  // ── Listen ──────────────────────────────────────────────────

  try {
    await app.listen({ host, port: options.port ?? 0 });
  } catch (err) {
    // A failed listen (EADDRINUSE on the default port) must not leave a
    // half-started instance behind: the CLI retries on another port.
    await app.close().catch(() => undefined);
    throw err;
  }
  const address = app.server.address();
  const port = typeof address === 'object' ? (address?.port ?? 0) : 0;

  return { app, port };
}

// ── Health ──────────────────────────────────────────────────────

function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    pid: process.pid,
  }));
}

// ── Hook Events ────────────────────────────────────────────────

function registerHookRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{
    Params: { providerId: string };
    Body: Record<string, unknown>;
  }>(
    `${HOOK_API_PREFIX}/:providerId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: {
            providerId: { type: 'string', pattern: '^[a-z0-9-]+$' },
          },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params;
      const event = request.body;

      if (event.session_id && event.hook_event_name) {
        options.onHookEvent?.(providerId, event);
      }

      reply.send('ok');
    },
  );
}

// ── Launch codes (--open) ──────────────────────────────────────

/**
 * `POST /api/launch-code` (Bearer token) mints a one-time code for `--open`;
 * `GET /launch/:code` redeems it and redirects to the tokened office URL, so
 * the browser's command line never carries the token (see launchCodes.ts).
 */
function registerLaunchRoutes(
  app: FastifyInstance,
  token: string,
  allowedHostnames: ReadonlySet<string>,
): void {
  const codes = new LaunchCodes();
  app.post(LAUNCH_CODE_API_PATH, { preHandler: bearerAuth(token) }, async (_request, reply) => {
    if (reply.sent) return reply;
    return reply.header('cache-control', 'no-store').send({ code: codes.mint() });
  });
  app.get<{ Params: { code: string } }>(`${LAUNCH_PATH_PREFIX}/:code`, async (request, reply) => {
    const hostname = normalizeHostname(request.headers.host);
    if (hostname === null || !allowedHostnames.has(hostname)) {
      return reply.code(403).send();
    }
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    if (!codes.redeem(request.params.code)) {
      return reply
        .code(410)
        .type('text/plain; charset=utf-8')
        .send(
          'This launch link has expired or was already used. Open the URL poke-agents printed in your terminal.',
        );
    }
    return reply.redirect(`/?token=${encodeURIComponent(token)}`, 302);
  });
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(
  app: FastifyInstance,
  options: HttpServerOptions,
  allowedHostnames: ReadonlySet<string>,
): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // CONNECTION gate. Embedded (VS Code) requires the Bearer token. Standalone
    // requires a same-origin handshake instead (isAllowedWebSocketOrigin), so a
    // non-browser local client with no Origin can still watch the office, and
    // a Host that is an allowlisted name or an IP literal: a DNS-rebound page
    // arrives under its own name and must not even watch (the feed carries
    // session names, commands and message previews). What may be DONE over an
    // accepted connection is a separate question, decided below.
    if (options.embedded) {
      if (!bearerTokenValid(request.headers.authorization, options.token)) {
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
    } else if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)) {
      socket.close(WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden origin');
      return;
    } else if (!standaloneConnectionHostAllowed(request.headers.host, allowedHostnames)) {
      warnRefusedHost(request.headers.host);
      socket.close(WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden host');
      return;
    }

    // Both modes prove privilege with the SAME out-of-band secret, differently
    // carried: embedded sends the Bearer token it was handed in-process;
    // standalone sends the `?token=` the CLI printed in the local URL and the
    // SPA forwarded on this handshake, and it must arrive under an allowed Host
    // -- the same verdict the terminal socket applies. A network POSITION
    // never grants privilege, because every position is reproducible by a
    // forwarder; the Host allowlist can only take it away.
    let privileged = options.embedded;
    if (!options.embedded) {
      const verdict = standaloneHandshakeVerdict(
        request.url,
        request.headers.host,
        options.token,
        allowedHostnames,
      );
      privileged = verdict === 'privileged';
      if (verdict === 'untrusted-host') {
        // The operator has the right URL but reached us under a name they never
        // listed (typically a reverse proxy). Say how to fix it, or the session
        // silently stays watch-only.
        console.warn(
          `[Pixel Agents] Tokened connection via Host "${request.headers.host ?? ''}" is read-only: restart with --allowed-host <that name> to allow changes from it.`,
        );
      }
    }

    const { store } = options;

    // Every message to this client goes through `send`. In standalone it also
    // announces each Pokémon species the client needs (pokemonSpeciesLoaded)
    // around the messages that introduce it.
    const species = options.embedded
      ? null
      : createSpeciesDelivery(store, (m) => safeSend(socket, m));
    const send = (message: Record<string, unknown>): void => {
      if (species) species.send(message);
      else safeSend(socket, message);
    };

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      const seatId = store.getAdapter()?.loadSeats()[String(id)]?.seatId;
      send({ ...agentCreatedMessage(id, agent, seatId) });
    };

    const onAgentRemoved = (id: number) => {
      send({ type: 'agentClosed', id });
    };

    const onBroadcast = (message: Record<string, unknown>) => {
      send(message);
    };

    store.on('agentAdded', onAgentAdded);
    store.on('agentRemoved', onAgentRemoved);
    store.on('broadcast', onBroadcast);

    // Handle incoming client messages
    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!options.embedded && msg.type) {
          console.log('[Pixel Agents] WS client message:', msg.type);
        }
        handleClientMessage(msg, send, {
          store,
          runtime: options.runtime,
          cache: options.assetCache ?? null,
          onSetHooksEnabled: options.onSetHooksEnabled,
          onReloadAssets: options.onReloadAssets,
          privileged,
          ptyManager: options.ptyManager,
          hookProviders: options.hookProviders,
          openExternal: options.openExternal,
        });
      } catch {
        // Malformed JSON, ignore
      }
    });

    socket.on('close', () => {
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      store.off('broadcast', onBroadcast);
      species?.dispose();
    });
  });
}

/** Host names already reported as refused, so a page retrying its socket logs once. */
const reportedRefusedHosts = new Set<string>();

/** Say once per name why a connection was refused and how to allow it. */
function warnRefusedHost(host: string | undefined): void {
  const name = normalizeHostname(host) ?? 'an unreadable Host header';
  if (reportedRefusedHosts.has(name) || reportedRefusedHosts.size >= REFUSED_HOST_LOG_MAX) return;
  reportedRefusedHosts.add(name);
  console.warn(
    `[Pixel Agents] Refused a connection via Host "${name}" (DNS-rebinding defence). If that is your own name for this machine, restart with --allowed-host ${name}.`,
  );
}

// ── Auth Helper ────────────────────────────────────────────────

function bearerAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!bearerTokenValid(request.headers.authorization, expectedToken)) {
      reply.code(401).send('unauthorized');
    }
  };
}

// ── Logging ────────────────────────────────────────────────────

/** Fastify's default request serializer, minus the token query. Exported so a
 *  test can pin that the secret never reaches the log line. */
export function serializeRequestForLog(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactLaunchCode(redactTokenQuery(request.url)),
    hostname: request.hostname,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort,
  };
}

/** A launch code is single-use, but it is still a key to the token: keep it out of the log. */
function redactLaunchCode(url: string): string {
  return url.startsWith(`${LAUNCH_PATH_PREFIX}/`) ? `${LAUNCH_PATH_PREFIX}/[redacted]` : url;
}

// ── Utilities ──────────────────────────────────────────────────

function safeSend(
  socket: { send: (data: string) => void; readyState: number },
  message: Record<string, unknown>,
): void {
  // WebSocket.OPEN = 1
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}
