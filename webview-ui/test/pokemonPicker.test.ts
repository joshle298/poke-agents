import { describe, expect, it } from 'vitest';

import type { PokemonCatalog } from '../../core/src/messages.js';
import {
  currentEntryId,
  pickerEntries,
  pickerPortraitUrl,
  shownShiny,
} from '../src/conductor/pokemonPicker.js';

/** Synthetic metadata in the server's shape (names only; no art). */
const CATALOG: PokemonCatalog = {
  type: 'pokemonCatalog',
  lines: [
    {
      id: 'charmander',
      members: [
        { dex: 4, name: 'Charmander', stage: 1 },
        { dex: 5, name: 'Charmeleon', stage: 2 },
        { dex: 6, name: 'Charizard', stage: 3 },
      ],
    },
    {
      id: 'eevee',
      members: [
        { dex: 133, name: 'Eevee', stage: 1 },
        { dex: 134, name: 'Vaporeon', stage: 2 },
        { dex: 135, name: 'Jolteon', stage: 2 },
      ],
    },
    { id: 'empty', members: [] },
  ],
  legendaries: [{ id: 'mewtwo', dex: 150, name: 'Mewtwo' }],
};

describe('Change Pokémon picker rules', () => {
  it('lists every line by its first stage, with the line in the tooltip', () => {
    expect(pickerEntries(CATALOG, false)).toEqual([
      {
        id: 'charmander',
        kind: 'line',
        dex: 4,
        name: 'Charmander',
        title: 'Charmander → Charmeleon → Charizard',
      },
      { id: 'eevee', kind: 'line', dex: 133, name: 'Eevee', title: 'Eevee → Vaporeon / Jolteon' },
    ]);
  });

  it('adds the legendaries for a Lead only', () => {
    expect(pickerEntries(CATALOG, true).at(-1)).toEqual({
      id: 'mewtwo',
      kind: 'legendary',
      dex: 150,
      name: 'Mewtwo',
      title: 'Mewtwo (legendary)',
    });
    expect(pickerEntries(CATALOG, false).some((e) => e.kind === 'legendary')).toBe(false);
    expect(pickerEntries(null, true)).toEqual([]);
  });

  it('finds the entry the agent’s species belongs to', () => {
    expect(currentEntryId(CATALOG, 5)).toBe('charmander');
    expect(currentEntryId(CATALOG, 135)).toBe('eevee');
    expect(currentEntryId(CATALOG, 150)).toBe('mewtwo');
    expect(currentEntryId(CATALOG, 999)).toBeUndefined();
    expect(currentEntryId(CATALOG, undefined)).toBeUndefined();
  });

  it('asks the same-origin portrait route only when it is there, for a valid dex', () => {
    expect(pickerPortraitUrl(4, true)).toBe('/api/pokemon/0004/portrait/Normal.png');
    expect(pickerPortraitUrl(150, false)).toBeUndefined();
    expect(pickerPortraitUrl(0, true)).toBeUndefined();
    expect(pickerPortraitUrl(1026, true)).toBeUndefined();
    expect(pickerPortraitUrl(1.5, true)).toBeUndefined();
  });

  it('shows a Shiny toggle’s new value until the office reports it', () => {
    // Sent, not answered (or answered, agentDetails not here yet): the new value.
    expect(shownShiny(false, { shiny: true }, true)).toBe(true);
    // Refused or never answered: the agent's own.
    expect(shownShiny(false, { shiny: true }, false)).toBe(false);
    // A tile or the reset: the agent's own.
    expect(shownShiny(true, {}, true)).toBe(true);
    expect(shownShiny(false, null, false)).toBe(false);
  });
});
