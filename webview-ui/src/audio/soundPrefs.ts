/**
 * Per-device sound preferences (localStorage, `pixel-agents.sound.*`): the
 * volume and the Cries / Alerts / Effects toggles. The on/off switch for all
 * sound stays the server's `soundEnabled` setting (notificationSound.ts).
 *
 * Module state with a subscribe function, so the engine reads it on every
 * sound and React reads it through useSyncExternalStore.
 */

import { readBoolPref, writeBoolPref } from '../conductor/preferences.js';
import {
  SOUND_DEFAULT_VOLUME,
  SOUND_PREF_ALERTS_KEY,
  SOUND_PREF_CRIES_KEY,
  SOUND_PREF_EFFECTS_KEY,
  SOUND_PREF_VOLUME_KEY,
} from './constants.js';
import type { SoundCategory } from './soundEvents.js';

export interface SoundPrefs {
  /** 0..1, applied to every Pokémon sound. */
  volume: number;
  cries: boolean;
  alerts: boolean;
  effects: boolean;
}

const CATEGORY_KEYS: Readonly<Record<SoundCategory, string>> = {
  cries: SOUND_PREF_CRIES_KEY,
  alerts: SOUND_PREF_ALERTS_KEY,
  effects: SOUND_PREF_EFFECTS_KEY,
};

/** 0..1 from a stored string; the default when absent or malformed. */
export function parseVolume(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return SOUND_DEFAULT_VOLUME;
  const value = Number(raw);
  if (!Number.isFinite(value)) return SOUND_DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, value));
}

function readVolume(): number {
  try {
    return parseVolume(
      typeof localStorage === 'undefined' ? null : localStorage.getItem(SOUND_PREF_VOLUME_KEY),
    );
  } catch {
    return SOUND_DEFAULT_VOLUME;
  }
}

function load(): SoundPrefs {
  return {
    volume: readVolume(),
    cries: readBoolPref(CATEGORY_KEYS.cries, true),
    alerts: readBoolPref(CATEGORY_KEYS.alerts, true),
    effects: readBoolPref(CATEGORY_KEYS.effects, true),
  };
}

let prefs: SoundPrefs = load();
const listeners = new Set<() => void>();

function set(next: SoundPrefs): void {
  prefs = next;
  for (const listener of listeners) listener();
}

export function getSoundPrefs(): SoundPrefs {
  return prefs;
}

export function subscribeSoundPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSoundVolume(volume: number): void {
  const clamped = Math.min(1, Math.max(0, volume));
  if (clamped === prefs.volume) return;
  try {
    localStorage.setItem(SOUND_PREF_VOLUME_KEY, String(clamped));
  } catch {
    // Storage blocked: the volume still applies for this session.
  }
  set({ ...prefs, volume: clamped });
}

export function setSoundCategory(category: SoundCategory, enabled: boolean): void {
  if (prefs[category] === enabled) return;
  writeBoolPref(CATEGORY_KEYS[category], enabled);
  set({ ...prefs, [category]: enabled });
}
