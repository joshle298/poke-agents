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

describe('Pokémon search', () => {
  it('matches evolved names case-insensitively and returns their line tile', () => {
    expect(pickerEntries(CATALOG, false, '  cHaRiZaRd  ').map((entry) => entry.id)).toEqual([
      'charmander',
    ]);
    expect(pickerEntries(CATALOG, false, 'vapor').map((entry) => entry.id)).toEqual(['eevee']);
    expect(pickerEntries(CATALOG, false, '   ')).toEqual(pickerEntries(CATALOG, false));
  });

  it('matches exact Pokédex numbers including a hash and leading zeroes', () => {
    // eslint-disable-next-line pixel-agents/no-inline-colors -- A Pokédex number, not a color.
    for (const query of ['5', '005', '#005']) {
      expect(pickerEntries(CATALOG, false, query).map((entry) => entry.id)).toEqual(['charmander']);
    }
    expect(pickerEntries(CATALOG, false, '15')).toEqual([]);
    expect(pickerEntries(CATALOG, false, 'missingno')).toEqual([]);
  });

  it('limits legendary search results to Leads', () => {
    expect(pickerEntries(CATALOG, false, 'mew')).toEqual([]);
    // eslint-disable-next-line pixel-agents/no-inline-colors -- A Pokédex number, not a color.
    expect(pickerEntries(CATALOG, true, '#150').map((entry) => entry.id)).toEqual(['mewtwo']);
  });

  it('normalizes accents and punctuation in names', () => {
    const catalog: PokemonCatalog = {
      type: 'pokemonCatalog',
      lines: [
        { id: 'flabebe', members: [{ dex: 669, name: 'Flabébé', stage: 1 }] },
        { id: 'mr-mime', members: [{ dex: 122, name: 'Mr. Mime', stage: 1 }] },
      ],
      legendaries: [],
    };
    expect(pickerEntries(catalog, false, 'flabebe').map((entry) => entry.id)).toEqual(['flabebe']);
    expect(pickerEntries(catalog, false, 'mr mime').map((entry) => entry.id)).toEqual(['mr-mime']);
  });
});
