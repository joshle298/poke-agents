/**
 * Same-origin sprite and portrait files for the standalone office:
 *
 *   GET /api/pokemon/:dex4/:file                  sprite/<dex4>/<Anim>-Anim.png
 *   GET /api/pokemon/:dex4/portrait/:file         portrait/<dex4>/<Emotion>.png
 *   GET /api/pokemon/:dex4/shiny/:file            sprite/<dex4>/0000/0001/...
 *   GET /api/pokemon/:dex4/shiny/portrait/:file   portrait/<dex4>/0000/0001/...
 *
 * Streamed from the PMD cache root, downloading on a miss. A request can only
 * name a valid dex and an allowlisted file (an anim the species' AnimData.xml
 * declares, or a portrait emotion the office uses), so the route is no general
 * proxy and never reads outside the cache. Only species an agent shows or the
 * catalog can assign are served, so a page cannot make the server download the
 * whole SpriteCollab. Requests must arrive under a Host the WS route would
 * accept for a privileged handshake (DNS-rebinding defence), never from another
 * site (`Sec-Fetch-Site`: the office fetches same-origin), and get 404 while
 * sprites or the theme are off.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';

import type { AgentStateStore } from '../agentStateStore.js';
import { normalizeHostname } from '../wsAuth.js';
import { sheetAnimNames } from './animData.js';
import { PMD_ANIM_NAME, POKEMON_ROUTE_CACHE_CONTROL, POKEMON_ROUTE_PREFIX } from './constants.js';
import type { PmdCache, PmdRelPath } from './pmdCache.js';
import { getPmdCache, parseDex4, portraitPath, sheetPath } from './pmdCache.js';
import { isServableSpecies, loadAnimData, pokemonDeliveryEnabled } from './pokemonAssets.js';

export interface PokemonRoutesOptions {
  /** Host names the office may be reached under (wsAuth.privilegedHostnames). */
  allowedHostnames: ReadonlySet<string>;
  /** Read for the theme setting. */
  store: AgentStateStore;
  /** Default: the process-wide cache. */
  cache?: PmdCache;
}

type Params = { dex4: string; file: string };
type FileKind = 'sprite' | 'portrait';

const SHEET_FILE = /^(.+)-Anim\.png$/;
/** `Sec-Fetch-Site` values of the office's own requests (and a typed URL). */
const SAME_SITE_FETCHES: ReadonlySet<string> = new Set(['same-origin', 'none']);
const PNG_FILE = /^(.+)\.png$/;

export function registerPokemonRoutes(app: FastifyInstance, options: PokemonRoutesOptions): void {
  const route = (suffix: string, kind: FileKind, shiny: boolean) => {
    app.get<{ Params: Params }>(`${POKEMON_ROUTE_PREFIX}/:dex4${suffix}/:file`, (request, reply) =>
      serveFile(request, reply, options, kind, shiny),
    );
  };
  route('', 'sprite', false);
  route('/portrait', 'portrait', false);
  route('/shiny', 'sprite', true);
  route('/shiny/portrait', 'portrait', true);
}

async function relPathFor(
  cache: PmdCache,
  dex: number,
  shiny: boolean,
  kind: FileKind,
  file: string,
): Promise<PmdRelPath | null> {
  if (kind === 'portrait') {
    const emotion = PNG_FILE.exec(file)?.[1];
    return emotion ? portraitPath(dex, shiny, emotion) : null;
  }
  const anim = SHEET_FILE.exec(file)?.[1];
  if (!anim || !PMD_ANIM_NAME.test(anim)) return null;
  const data = await loadAnimData(cache, dex, shiny);
  return data ? sheetPath(dex, shiny, anim, sheetAnimNames(data)) : null;
}

async function serveFile(
  request: FastifyRequest<{ Params: Params }>,
  reply: FastifyReply,
  options: PokemonRoutesOptions,
  kind: FileKind,
  shiny: boolean,
): Promise<FastifyReply> {
  const hostname = normalizeHostname(request.headers.host);
  if (hostname === null || !options.allowedHostnames.has(hostname)) {
    return reply.code(403).send();
  }
  // A cross-site <img> or fetch arrives under an allowed Host (127.0.0.1);
  // the browser still says where it came from.
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string' && !SAME_SITE_FETCHES.has(site)) return reply.code(403).send();
  if (!pokemonDeliveryEnabled(options.store)) return reply.code(404).send();
  const dex = parseDex4(request.params.dex4);
  if (dex === null || !isServableSpecies(dex, options.store)) return reply.code(404).send();

  const cache = options.cache ?? getPmdCache();
  const relPath = await relPathFor(cache, dex, shiny, kind, request.params.file);
  const abs = relPath ? await cache.ensureFile(relPath) : null;
  if (!abs) return reply.code(404).send();

  return reply
    .header('cache-control', POKEMON_ROUTE_CACHE_CONTROL)
    .header('x-content-type-options', 'nosniff')
    .type('image/png')
    .send(fs.createReadStream(abs));
}
