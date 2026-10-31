/**
 * Same-origin sound files for the standalone office:
 *
 *   GET /api/pokemon/cry/:dex4    the species' cry (audio/ogg, or audio/mpeg for the few MP3
 *                                 ones), cached on first request
 *   GET /api/sounds               the sound pack overrides present: { overrides: [...] }
 *   GET /api/sounds/:event        one override (audio/ogg, audio/mpeg or audio/wav)
 *
 * Requests must arrive under a Host the WS route would accept for a
 * privileged handshake (DNS-rebinding defence) and never from another site
 * (`Sec-Fetch-Site`: the office fetches same-origin), like the sprite route,
 * so another web page can neither make the server download cries nor read
 * the user's sound pack. Cries
 * are served only for a valid dex the catalog can assign or an agent shows,
 * and answer 404 while sounds, sprites or the Pokémon theme are off. The
 * sound pack answers 404 while sounds are off.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';

import type { AgentStateStore } from '../agentStateStore.js';
import { parseDex4 } from '../pokemon/pmdCache.js';
import { pokemonDeliveryEnabled } from '../pokemon/pokemonAssets.js';
import { isSameSiteFetch } from '../pokemon/routes.js';
import { normalizeHostname } from '../wsAuth.js';
import { AUDIO_CONTENT_TYPES, AUDIO_SIGNATURE_BYTES, sniffAudioFormat } from './audioSignature.js';
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

/** The sprite route's gate: an allowed Host, and not another site's request. */
function requestAllowed(request: FastifyRequest, options: SoundRoutesOptions): boolean {
  const hostname = normalizeHostname(request.headers.host);
  return hostname !== null && options.allowedHostnames.has(hostname) && isSameSiteFetch(request);
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
  if (!requestAllowed(request, options)) return reply.code(403).send();
  if (!cryDeliveryEnabled(options.store)) return reply.code(404).send();
  const dex = parseDex4(request.params.dex4);
  if (dex === null || !isCryAllowed(dex, options.store)) return reply.code(404).send();

  const abs = await (options.cryCache ?? getCryCache()).ensureCry(dex);
  const format = abs ? sniffAudioFormat(await readHead(abs)) : null;
  if (!abs || (format !== 'ogg' && format !== 'mp3')) return reply.code(404).send();
  return reply
    .header('cache-control', CRY_ROUTE_CACHE_CONTROL)
    .header('x-content-type-options', 'nosniff')
    .type(AUDIO_CONTENT_TYPES[format])
    .send(fs.createReadStream(abs));
}

/** The file's first bytes (empty when unreadable). */
async function readHead(abs: string): Promise<Buffer> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(abs, 'r');
    const head = Buffer.alloc(AUDIO_SIGNATURE_BYTES);
    const { bytesRead } = await handle.read(head, 0, AUDIO_SIGNATURE_BYTES, 0);
    return head.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function serveSoundPackList(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SoundRoutesOptions,
): Promise<FastifyReply> {
  if (!requestAllowed(request, options)) return reply.code(403).send();
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
  if (!requestAllowed(request, options)) return reply.code(403).send();
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
