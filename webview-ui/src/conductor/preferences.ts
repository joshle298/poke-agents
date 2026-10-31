/**
 * Per-device boolean preferences in localStorage (battle log, show
 * connections). Storage can be missing (Node tests) or blocked (private
 * windows); both read as the default and writes become no-ops.
 */

import { useCallback, useState } from 'react';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readBoolPref(key: string, fallback: boolean): boolean {
  try {
    const raw = storage()?.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

export function writeBoolPref(key: string, value: boolean): void {
  try {
    storage()?.setItem(key, value ? '1' : '0');
  } catch {
    // Storage full or blocked: the choice still applies for this session.
  }
}

/** A boolean preference persisted under `key`. */
export function useBoolPref(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => readBoolPref(key, fallback));
  const set = useCallback(
    (next: boolean) => {
      writeBoolPref(key, next);
      setValue(next);
    },
    [key],
  );
  return [value, set];
}
