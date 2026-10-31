/**
 * The Pokémon theme switch, as module state.
 *
 * Read every frame by the renderer and every tick by OfficeState (capsule
 * vs matrix effect, species hit boxes), so it lives outside React — same
 * shape as the renderer's ghost setting. DOM-free: OfficeState imports it and
 * the Node test runner imports OfficeState.
 *
 * Starts on: `settingsLoaded.pokemonTheme` absent means on. Hosts that never
 * send Pokémon species (VS Code, `--no-sprites`) still draw upstream
 * characters, because a character only becomes a Pokémon once its sheets are
 * decoded.
 */

let enabled = true;
const listeners = new Set<() => void>();

export function setPokemonThemeEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  for (const listener of listeners) listener();
}

export function isPokemonThemeEnabled(): boolean {
  return enabled;
}

/** For useSyncExternalStore. Returns the unsubscribe. */
export function subscribePokemonTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
