/**
 * Change Pokémon: the picker's pure rules (DOM-free, Node-tested). The
 * server owns the catalog (pokemonCatalog) and validates every choice.
 */

import type { PokemonCatalog } from '../../../core/src/messages.js';
import { POKEMON_MAX_DEX, POKEMON_PORTRAIT_ROUTE_PREFIX } from '../constants.js';

/** One square in the picker's grid. */
export interface PickerEntry {
  /** The id setAgentPokemon sends as `line`. */
  id: string;
  kind: 'line' | 'legendary';
  /** The species its portrait shows (a line's first stage). */
  dex: number;
  /** Its name in the grid (a line's first stage). */
  name: string;
  /** Every member, for the tooltip: "Charmander → Charmeleon → Charizard". */
  title: string;
}

/**
 * The grid: every line (named after its first stage; a branching stage lists
 * its members with "/"), then the legendaries, for a Lead only.
 */
export function pickerEntries(catalog: PokemonCatalog | null, isLead: boolean): PickerEntry[] {
  if (!catalog) return [];
  const lines: PickerEntry[] = [];
  for (const line of catalog.lines) {
    const first = [...line.members].sort((a, b) => a.stage - b.stage)[0];
    if (!first) continue;
    const stages = new Map<number, string[]>();
    for (const m of line.members) stages.set(m.stage, [...(stages.get(m.stage) ?? []), m.name]);
    const title = [...stages.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, names]) => names.join(' / '))
      .join(' → ');
    lines.push({ id: line.id, kind: 'line', dex: first.dex, name: first.name, title });
  }
  if (!isLead) return lines;
  const legendaries: PickerEntry[] = catalog.legendaries.map((l) => ({
    id: l.id,
    kind: 'legendary',
    dex: l.dex,
    name: l.name,
    title: `${l.name} (legendary)`,
  }));
  return [...lines, ...legendaries];
}

/** The entry the agent's species belongs to, if any. */
export function currentEntryId(
  catalog: PokemonCatalog | null,
  species: number | undefined,
): string | undefined {
  if (!catalog || species === undefined) return undefined;
  const line = catalog.lines.find((l) => l.members.some((m) => m.dex === species));
  if (line) return line.id;
  return catalog.legendaries.find((l) => l.dex === species)?.id;
}

/** The standalone server's same-origin portrait for a species (lazy-loaded
 *  by the grid), or undefined when the route isn't there or the dex is out
 *  of range. A shiny shows its base form's portrait, as in the PC Box. */
export function pickerPortraitUrl(dex: number, portraitRoute: boolean): string | undefined {
  if (!portraitRoute || !Number.isInteger(dex) || dex < 1 || dex > POKEMON_MAX_DEX)
    return undefined;
  return `${POKEMON_PORTRAIT_ROUTE_PREFIX}/${String(dex).padStart(4, '0')}/portrait/Normal.png`;
}

/** The Shiny box: a toggle's new value while it is on its way (or answered
 *  but not reported back yet), else the agent's own. */
export function shownShiny(
  current: boolean,
  toggle: { shiny?: boolean } | null,
  inFlight: boolean,
): boolean {
  return toggle?.shiny !== undefined && inFlight ? toggle.shiny : current;
}
