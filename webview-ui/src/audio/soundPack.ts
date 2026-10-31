/**
 * The user's sound pack as the local server lists it (GET /api/sounds): which
 * effects have a file in ~/.pixel-agents/sounds that replaces the synth.
 * Standalone only; VS Code has no server routes and keeps the synth.
 */

import { SOUND_PACK_FILE_URL_PREFIX, SOUND_PACK_LIST_URL } from './constants.js';
import type { SfxName } from './soundEvents.js';
import { SFX_NAMES } from './soundEvents.js';

export interface SoundPackOverride {
  event: SfxName;
  format: string;
  size: number;
  /** Changes when the file is replaced. */
  version: string;
}

const SFX_SET: ReadonlySet<string> = new Set(SFX_NAMES);
const FORMAT = /^(ogg|mp3|wav)$/;
const VERSION = /^[\w.-]{1,64}$/;

/** The overrides in a /api/sounds reply; anything malformed is skipped. */
export function parseSoundPackList(body: unknown): SoundPackOverride[] {
  const list = (body as { overrides?: unknown } | null)?.overrides;
  if (!Array.isArray(list)) return [];
  const out: SoundPackOverride[] = [];
  for (const item of list as Array<Record<string, unknown>>) {
    if (
      item &&
      typeof item.event === 'string' &&
      SFX_SET.has(item.event) &&
      typeof item.format === 'string' &&
      FORMAT.test(item.format) &&
      typeof item.size === 'number' &&
      typeof item.version === 'string' &&
      VERSION.test(item.version) &&
      !out.some((o) => o.event === item.event)
    ) {
      out.push({
        event: item.event as SfxName,
        format: item.format,
        size: item.size,
        version: item.version,
      });
    }
  }
  return out;
}

/** Same-origin URL of one override; the version busts any cached copy. */
export function soundPackFileUrl(override: SoundPackOverride): string {
  return `${SOUND_PACK_FILE_URL_PREFIX}${override.event}?v=${encodeURIComponent(override.version)}`;
}

let overrides: readonly SoundPackOverride[] = [];
const listeners = new Set<() => void>();

export function getSoundPack(): readonly SoundPackOverride[] {
  return overrides;
}

export function subscribeSoundPack(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function same(a: readonly SoundPackOverride[], b: readonly SoundPackOverride[]): boolean {
  return (
    a.length === b.length && a.every((o, i) => o.event === b[i].event && o.version === b[i].version)
  );
}

/** Ask the server which overrides exist. Failures (no server, sounds off)
 *  read as none. */
export async function refreshSoundPack(): Promise<void> {
  let next: SoundPackOverride[] = [];
  try {
    const res = await fetch(SOUND_PACK_LIST_URL, { cache: 'no-store' });
    if (res.ok) next = parseSoundPackList(await res.json());
  } catch {
    // No server route (VS Code, dev) or offline: the synth plays.
  }
  if (same(overrides, next)) return;
  overrides = next;
  for (const listener of listeners) listener();
}
