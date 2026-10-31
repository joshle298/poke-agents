/**
 * Same-origin sound files for the standalone office:
 *
 *   GET /api/pokemon/cry/:dex4    the species' cry (audio/ogg), cached on first request
 *   GET /api/sounds               the sound pack overrides present: { overrides: [...] }
 *   GET /api/sounds/:event        one override (audio/ogg, audio/mpeg or audio/wav)
 *
 * Requests must arrive under a Host the WS route would accept for a
 * privileged handshake (DNS-rebinding defence), like the sprite route. Cries
 * are served only for a valid dex the catalog can assign or an agent shows,
 * and answer 404 while sounds, sprites or the Pokémon theme are off. The
 * sound pack answers 404 while sounds are off.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';

import type { AgentStateStore } from '../agentStateStore.js';
import { parseDex4 } from '../pokemon/pmdCache.js';
import { pokemonDeliveryEnabled } from '../pokemon/pokemonAssets.js';
import { normalizeHostname } from '../wsAuth.js';
import {
  CRY_ROUTE_CACHE_CONTROL,
  CRY_ROUTE_PREFIX,
  SOUND_PACK_CACHE_CONTROL,
  SOUND_PACK_ROUTE_PREFIX,
} from './constants.js';
import type { CryCache } from './cryCache.js';
import { getCryCache } from './cryCache.js';
import { defaultSoundPackDir, listSoundPack, openSoundPackFile } from './soundPack.js';
import { areSoundsEnabled, isCryAllowed } from './sounds.js';

export interface SoundRoutesOptions {
  /** Host names the office may be reached under (wsAuth.privilegedHostnames). */
  allowedHostnames: ReadonlySet<string>;
  /** Read for the theme setting and the species in use. */
  store: AgentStateStore;
  /** Default: the process-wide cry cache. */
  cryCache?: CryCache;
  /** Default: ~/.pixel-agents/sounds. */
  soundPackDir?: string;
}

/** Cries may be fetched and served: sounds on, sprites on, theme on. */
export function cryDeliveryEnabled(store: AgentStateStore): boolean {
  return areSoundsEnabled() && pokemonDeliveryEnabled(store);
}

function hostAllowed(request: FastifyRequest, options: SoundRoutesOptions): boolean {
  const hostname = normalizeHostname(request.headers.host);
  return hostname !== null && options.allowedHostnames.has(hostname);
}

export function registerSoundRoutes(app: FastifyInstance, options: SoundRoutesOptions): void {
  app.get<{ Params: { dex4: string } }>(`${CRY_ROUTE_PREFIX}/:dex4`, (request, reply) =>
    serveCry(request, reply, options),
  );
  app.get(SOUND_PACK_ROUTE_PREFIX, (request, reply) => serveSoundPackList(request, reply, options));
  app.get<{ Params: { event: string } }>(`${SOUND_PACK_ROUTE_PREFIX}/:event`, (request, reply) =>
    serveSoundPackFile(request, reply, options),
  );
}

async function serveCry(
  request: FastifyRequest<{ Params: { dex4: string } }>,
  reply: FastifyReply,
  options: SoundRoutesOptions,
): Promise<FastifyReply> {
  if (!hostAllowed(request, options)) return reply.code(403).send();
  if (!cryDeliveryEnabled(options.store)) return reply.code(404).send();
  const dex = parseDex4(request.params.dex4);
  if (dex === null || !isCryAllowed(dex, options.store)) return reply.code(404).send();

  const abs = await (options.cryCache ?? getCryCache()).ensureCry(dex);
  if (!abs) return reply.code(404).send();
  return reply
    .header('cache-control', CRY_ROUTE_CACHE_CONTROL)
    .header('x-content-type-options', 'nosniff')
    .type('audio/ogg')
    .send(fs.createReadStream(abs));
}

async function serveSoundPackList(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SoundRoutesOptions,
): Promise<FastifyReply> {
  if (!hostAllowed(request, options)) return reply.code(403).send();
  if (!areSoundsEnabled()) return reply.code(404).send();
  const overrides = await listSoundPack(options.soundPackDir ?? defaultSoundPackDir());
  return reply
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    .send({ overrides });
}

async function serveSoundPackFile(
  request: FastifyRequest<{ Params: { event: string } }>,
  reply: FastifyReply,
  options: SoundRoutesOptions,
): Promise<FastifyReply> {
  if (!hostAllowed(request, options)) return reply.code(403).send();
  if (!areSoundsEnabled()) return reply.code(404).send();
  const file = await openSoundPackFile(
    options.soundPackDir ?? defaultSoundPackDir(),
    request.params.event,
  );
  if (!file) return reply.code(404).send();
  return reply
    .header('cache-control', SOUND_PACK_CACHE_CONTROL)
    .header('x-content-type-options', 'nosniff')
    .type(file.contentType)
    .send(file.handle.createReadStream({ start: 0, autoClose: true }));
}
