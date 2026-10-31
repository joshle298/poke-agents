import { POKEMON_CATALOG } from '../../server/src/pokemon/speciesCatalog.js';

/** National dex number → species name, from the committed catalog. */
const NAMES = new Map<number, string>();
for (const line of POKEMON_CATALOG.lines) {
  for (const member of line.members) NAMES.set(member.dex, member.name);
}
for (const legendary of POKEMON_CATALOG.legendaries) NAMES.set(legendary.dex, legendary.name);

/** The species name for a dex number ("Pikachu" for 25), if the catalog has it. */
export function speciesName(dex: number): string | undefined {
  return NAMES.get(dex);
}
