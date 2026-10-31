/**
 * "Show connections": whether the office draws links between agents. A local,
 * per-device preference (default on) kept in localStorage — not synced
 * through the server, like the mobile card order.
 *
 * Module state so the render loop reads it every frame without React; the
 * Settings toggle calls setShowConnections and can subscribe through
 * useSyncExternalStore(subscribeShowConnections, getShowConnections).
 * Storage is read lazily and every access is guarded: private windows and
 * the Node test runner may have none.
 */

import { SHOW_CONNECTIONS_STORAGE_KEY } from '../constants.js';

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

let cached: boolean | null = null;
const listeners = new Set<() => void>();

function storage(): KeyValueStorage | null {
  try {
    return (globalThis as { localStorage?: KeyValueStorage }).localStorage ?? null;
  } catch {
    return null; // access itself can throw (blocked storage)
  }
}

export function getShowConnections(): boolean {
  if (cached === null) {
    let stored: string | null;
    try {
      stored = storage()?.getItem(SHOW_CONNECTIONS_STORAGE_KEY) ?? null;
    } catch {
      stored = null;
    }
    cached = stored !== 'false';
  }
  return cached;
}

export function setShowConnections(show: boolean): void {
  try {
    storage()?.setItem(SHOW_CONNECTIONS_STORAGE_KEY, show ? 'true' : 'false');
  } catch {
    // Not persisted (quota, blocked storage); the session still honours it.
  }
  if (cached === show) return;
  cached = show;
  for (const listener of listeners) listener();
}

/** For useSyncExternalStore. Returns the unsubscribe. */
export function subscribeShowConnections(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
