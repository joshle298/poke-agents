/**
 * Pokémon sprite assets: runtime download, cache and metadata for the office.
 *
 * Contract used by server/src/cli.ts (the Pokémon server stream fills this in;
 * keep the export names):
 */

let spritesEnabled = process.env.POKE_AGENTS_SPRITES !== 'off';

/** Turn all sprite fetching on or off (`--no-sprites`, POKE_AGENTS_SPRITES=off). */
export function setPokemonSpritesEnabled(enabled: boolean): void {
  spritesEnabled = enabled;
}

export function arePokemonSpritesEnabled(): boolean {
  return spritesEnabled;
}
