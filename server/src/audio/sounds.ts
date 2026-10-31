/**
 * The server's sound switch and the cry URL the species payload carries.
 *
 * `--no-sounds` or POKE_AGENTS_SOUNDS=off turns off everything the server
 * delivers for sound: no cry is ever downloaded, `pokemonSpeciesLoaded`
 * carries no `cry`, and the cry and sound-pack routes answer 404. The office's
 * own synthesized effects are the user's Settings choice, not this switch.
 *
 * Cries also need sprite delivery (POKE_AGENTS_SPRITES, the Pokémon theme):
 * a cry belongs to a Pokémon the office shows (routes.ts checks both).
 *
 * Imports nothing from pokemonAssets.ts, which imports cryUrlFor from here.
 */

import type { AgentStateStore } from '../agentStateStore.js';
import { dex4, isValidDex } from '../pokemon/pmdCache.js';
import { POKEMON_CATALOG } from '../pokemon/speciesCatalog.js';
import { CRY_ROUTE_PREFIX } from './constants.js';

let soundsEnabled = process.env.POKE_AGENTS_SOUNDS !== 'off';

/** Turn server-delivered sounds on or off (`--no-sounds`, POKE_AGENTS_SOUNDS=off). */
export function setSoundsEnabled(enabled: boolean): void {
  soundsEnabled = enabled;
}

export function areSoundsEnabled(): boolean {
  return soundsEnabled;
}

/** Same-origin URL of a species' cry for the species payload, or undefined
 *  while sounds are off (the office then plays no cries). */
export function cryUrlFor(dex: number, urlBase = CRY_ROUTE_PREFIX): string | undefined {
  if (!soundsEnabled || !isValidDex(dex)) return undefined;
  return `${urlBase}/${dex4(dex)}`;
}

let catalogDexes: ReadonlySet<number> | null = null;

/** Every dex the species catalog can assign (line members and legendaries). */
function catalogDexSet(): ReadonlySet<number> {
  catalogDexes ??= new Set([
    ...POKEMON_CATALOG.lines.flatMap((line) => line.members.map((m) => m.dex)),
    ...POKEMON_CATALOG.legendaries.map((l) => l.dex),
  ]);
  return catalogDexes;
}

/** A cry may be fetched only for a species the catalog can assign or an
 *  agent in the office shows, so the route is no general proxy. */
export function isCryAllowed(dex: number, store: AgentStateStore): boolean {
  if (!isValidDex(dex)) return false;
  if (catalogDexSet().has(dex)) return true;
  for (const agent of store.values()) {
    if (agent.species === dex) return true;
  }
  return false;
}
