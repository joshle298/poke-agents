/**
 * Same-origin audio for the Jukebox's music folder:
 *
 *   GET /api/music/track/:id?token=<server token>
 *
 * Streams one file the latest folder scan listed, with HTTP Range support so an
 * <audio> element can seek. The user's own files are private, so the route
 * needs the same privilege as the /ws control socket and the terminal: the
 * server token, arriving under an allowed Host (wsAuth.standaloneHandshakeVerdict).
 * A read-only office never learns track ids anyway (requestMusicLibrary is a
 * privileged message). The request logger redacts the token.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { standaloneHandshakeVerdict } from '../wsAuth.js';
import { MUSIC_ID_PATTERN, MUSIC_ROUTE_CACHE_CONTROL, MUSIC_ROUTE_PREFIX } from './constants.js';
import type { MusicFolderLibrary } from './folderLibrary.js';
import { parseRangeHeader } from './range.js';

export interface MusicRoutesOptions {
  /** The standalone server token (the `?token=` the CLI printed). */
  token: string;
  /** Host names a privileged request may arrive under (wsAuth.privilegedHostnames). */
  allowedHostnames: ReadonlySet<string>;
  library: MusicFolderLibrary;
}

type Params = { id: string };

export function registerMusicRoutes(app: FastifyInstance, options: MusicRoutesOptions): void {
  // HEAD is handled here rather than by Fastify's generated HEAD route, which
  // would read the whole file only to discard it.
  app.route<{ Params: Params }>({
    method: ['GET', 'HEAD'],
    url: `${MUSIC_ROUTE_PREFIX}/track/:id`,
    handler: (request, reply) => serveTrack(request, reply, options),
  });
}

async function serveTrack(
  request: FastifyRequest<{ Params: Params }>,
  reply: FastifyReply,
  options: MusicRoutesOptions,
): Promise<FastifyReply> {
  const verdict = standaloneHandshakeVerdict(
    request.url,
    request.headers.host,
    options.token,
    options.allowedHostnames,
  );
  if (verdict !== 'privileged') return reply.code(403).send();
  const id = request.params.id;
  if (!MUSIC_ID_PATTERN.test(id)) return reply.code(404).send();

  const track = await options.library.openTrack(id);
  if (!track) return reply.code(404).send();
  const { handle, size, mimeType } = track;

  reply
    .header('accept-ranges', 'bytes')
    .header('cache-control', MUSIC_ROUTE_CACHE_CONTROL)
    .header('x-content-type-options', 'nosniff')
    .type(mimeType);

  const range = parseRangeHeader(request.headers.range, size);
  if (range === 'unsatisfiable') {
    await handle.close();
    return reply.code(416).header('content-range', `bytes */${size}`).send();
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  if (range) reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`);
  reply.header('content-length', String(length));

  if (request.method === 'HEAD' || length === 0) {
    await handle.close();
    return reply.send();
  }
  // autoClose (the default) closes the handle when the stream ends, errors, or
  // is destroyed because the client went away.
  return reply.send(handle.createReadStream({ start, end }));
}
