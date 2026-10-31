import { useSyncExternalStore } from 'react';

import { isPokemonOffice, subscribePokemonTheme } from '../office/engine/pokemonTheme.js';

/** A Pokémon office (theme on, the host delivers sprites): portraits fall back
 *  to the orb, never to an upstream character's mug shot. */
export function usePokemonOffice(): boolean {
  return useSyncExternalStore(subscribePokemonTheme, isPokemonOffice);
}
