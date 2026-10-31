/**
 * PMDCollab credits: `credits.txt` (per species, per form) and the repo-wide
 * `credit_names.txt`. Pure: no I/O.
 *
 * credits.txt rows are tab-separated (SpriteBot TrackerUtils):
 *   timestamp  creditId  CUR|OLD  licenseKey  comma-separated anims or emotions
 * creditId is `CHUNSOFT`, a Discord mention (`<@!123>`) or a plain name.
 * credit_names.txt maps those ids to display names: `Name  Discord  Contact`,
 * with a header row; some rows leave Name empty.
 */

import { ANONYMOUS_CONTRIBUTOR, CHUNSOFT_CREDIT, MAX_CREDIT_NAME_CHARS } from './constants.js';

export interface CreditRow {
  /** Timestamp as written (`2020-10-07 17:58:43.416193`); sorts lexically. */
  at: string;
  id: string;
  /** True for CUR rows: the contributor's work is what the repo serves now. */
  current: boolean;
  license: string;
  /** Anim names (sprite credits) or emotion names (portrait credits). */
  items: string[];
}

export interface CreditName {
  name: string | null;
  contact: string | null;
}

/** Downloaded files are capped at 2 MB; this bounds the per-row work too. */
const MAX_CREDIT_ROWS = 5000;
const DISCORD_MENTION = /^<@!?\d+>$/;

function rowsOf(txt: string): string[][] {
  return txt
    .split(/\r?\n/)
    .slice(0, MAX_CREDIT_ROWS)
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('\t').map((cell) => cell.trim()));
}

export function parseCredits(txt: string): CreditRow[] {
  const rows: CreditRow[] = [];
  for (const cells of rowsOf(txt)) {
    if (cells.length < 5 || cells[1] === '') continue;
    rows.push({
      at: cells[0],
      id: cells[1],
      current: cells[2] === 'CUR',
      license: cells[3],
      items: cells[4]
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    });
  }
  return rows;
}

/** Keyed by the Discord column (what credits.txt references) and by display name. */
export function parseCreditNames(txt: string): Map<string, CreditName> {
  const names = new Map<string, CreditName>();
  for (const cells of rowsOf(txt)) {
    const [name = '', discord = '', contact = ''] = cells;
    if (name === 'Name' && discord === 'Discord') continue; // header row
    const entry: CreditName = { name: name || null, contact: contact || null };
    if (discord) names.set(discord, entry);
    if (name && !names.has(name)) names.set(name, entry);
  }
  return names;
}

function displayNameFor(id: string, names: ReadonlyMap<string, CreditName>): string {
  if (id === CHUNSOFT_CREDIT) return CHUNSOFT_CREDIT;
  const entry = names.get(id);
  if (entry) return entry.name ?? ANONYMOUS_CONTRIBUTOR;
  // An unmapped Discord id says nothing a person can read.
  return DISCORD_MENTION.test(id) ? ANONYMOUS_CONTRIBUTOR : id;
}

/**
 * Display names of the contributors behind `usedItems`: CUR rows that list at
 * least one used anim or emotion, newest first, without duplicates.
 */
export function creditsFor(
  rows: readonly CreditRow[],
  names: ReadonlyMap<string, CreditName>,
  usedItems: Iterable<string>,
): string[] {
  const used = new Set(usedItems);
  const relevant = rows
    .filter((row) => row.current && row.items.some((item) => used.has(item)))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const out: string[] = [];
  for (const row of relevant) {
    const name = displayNameFor(row.id, names).slice(0, MAX_CREDIT_NAME_CHARS);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Every item listed in any row: which emotions (or anims) the form has. */
export function creditedItems(rows: readonly CreditRow[]): Set<string> {
  return new Set(rows.flatMap((row) => row.items));
}
