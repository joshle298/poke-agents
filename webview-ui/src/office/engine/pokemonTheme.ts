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
 * characters: only a host that delivers sprites (`settingsLoaded.pokemonSprites`)
 * makes the office a Pokémon office, where every agent is a Pokémon (a closed
 * capsule until its sheets decode) and no upstream character is ever drawn.
 */

let enabled = true;
let spritesDelivered = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function setPokemonThemeEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  notify();
}

export function isPokemonThemeEnabled(): boolean {
  return enabled;
}

/** The host announces Pokémon species for every agent (standalone with sprites on). */
export function setPokemonSpritesDelivered(next: boolean): void {
  if (spritesDelivered === next) return;
  spritesDelivered = next;
  notify();
}

export function arePokemonSpritesDelivered(): boolean {
  return spritesDelivered;
}

/** Theme on in a host that delivers sprites: every agent is a Pokémon, drawn
 *  as a closed capsule while its sheets load, never as an upstream character. */
export function isPokemonOffice(): boolean {
  return enabled && spritesDelivered;
}

/** For useSyncExternalStore. Returns the unsubscribe. */
export function subscribePokemonTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
