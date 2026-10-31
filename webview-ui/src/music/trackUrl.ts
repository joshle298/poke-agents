/**
 * Where the folder player streams a track from: the standalone server's
 * `/api/music/track/<id>`, carrying the server token the page was opened with
 * (the route is privileged like /ws; see server/src/music/routes.ts).
 */

import { serverToken } from '../transport/serverToken.js';

let override: ((id: string) => string) | null = null;

export function musicTrackUrl(id: string): string {
  if (override) return override(id);
  const token = serverToken ? `?token=${encodeURIComponent(serverToken)}` : '';
  return `/api/music/track/${encodeURIComponent(id)}${token}`;
}

/** Vite dev mock only: there is no server to stream from. */
export function setMusicTrackUrlOverride(resolve: ((id: string) => string) | null): void {
  override = resolve;
}
