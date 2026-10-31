import { describe, expect, it } from 'vitest';

import {
  creditedItems,
  creditsFor,
  parseCreditNames,
  parseCredits,
} from '../src/pokemon/pmdCredits.js';
import { CREDIT_NAMES, PORTRAIT_CREDITS, SPRITE_CREDITS } from './pokemonTestUtils.js';

describe('parseCredits', () => {
  it('splits tab-separated rows and marks CUR rows current', () => {
    const rows = parseCredits(SPRITE_CREDITS);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      at: '2020-01-01 00:00:00.000001',
      id: 'CHUNSOFT',
      current: true,
      license: 'Unspecified',
      items: ['Walk', 'Idle', 'Sleep'],
    });
    expect(rows[2]).toMatchObject({ id: '<@!1002>', current: false, items: ['Walk'] });
  });

  it('tolerates CRLF, blank lines and short rows', () => {
    const rows = parseCredits(
      '\r\n2020-01-01\tCHUNSOFT\tCUR\tUnspecified\tWalk\r\nbroken\trow\r\n\r\n',
    );
    expect(rows).toEqual([
      { at: '2020-01-01', id: 'CHUNSOFT', current: true, license: 'Unspecified', items: ['Walk'] },
    ]);
  });
});

describe('parseCreditNames', () => {
  it('maps Discord ids and names to display names, skipping the header', () => {
    const names = parseCreditNames(CREDIT_NAMES);
    expect(names.get('<@!1001>')).toEqual({
      name: 'Alice Example',
      contact: 'https://example.test/alice',
    });
    expect(names.get('Alice Example')?.name).toBe('Alice Example');
    expect(names.get('<@!1003>')).toEqual({ name: null, contact: null });
    expect(names.has('Name')).toBe(false);
  });
});

describe('creditsFor', () => {
  const names = parseCreditNames(CREDIT_NAMES);

  it('lists CUR contributors for the used items, newest first', () => {
    const rows = parseCredits(SPRITE_CREDITS);
    expect(creditsFor(rows, names, ['Walk', 'Charge'])).toEqual(['Alice Example', 'CHUNSOFT']);
    // Bob's row is OLD: replaced work is not credited.
    expect(creditsFor(rows, names, ['Walk'])).toEqual(['CHUNSOFT']);
    expect(creditsFor(rows, names, ['Attack'])).toEqual([]);
  });

  it('shows anonymous contributors and unmapped mentions as anonymous', () => {
    expect(creditsFor(parseCredits(PORTRAIT_CREDITS), names, ['Normal'])).toEqual([
      'anonymous contributor',
    ]);
    const unmapped = parseCredits('2022-01-01\t<@!999>\tCUR\tCC_BY-NC_4\tWalk');
    expect(creditsFor(unmapped, names, ['Walk'])).toEqual(['anonymous contributor']);
  });

  it('keeps a plain-name credit and dedupes repeats', () => {
    const rows = parseCredits(
      [
        '2022-01-02\tCarol Example\tCUR\tCC_BY-NC_4\tWalk',
        '2022-01-01\tCarol Example\tCUR\tCC_BY-NC_4\tIdle',
      ].join('\n'),
    );
    expect(creditsFor(rows, new Map(), ['Walk', 'Idle'])).toEqual(['Carol Example']);
  });
});

describe('creditedItems', () => {
  it('collects every item named in any row', () => {
    expect(creditedItems(parseCredits(PORTRAIT_CREDITS))).toEqual(
      new Set(['Normal', 'Happy', 'Worried', 'Angry']),
    );
  });
});
