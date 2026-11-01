/**
 * Upgrading a saved Pokémon Town. The standalone office shows the bundled town
 * until a layout is saved; once ~/.pixel-agents/layout.json holds one, it is
 * never replaced on its own (VS Code's layoutRevision reset never touches the
 * town). Except here: when the saved layout is a town an earlier version
 * shipped, exactly as it shipped (any pets placed in it aside), it is replaced
 * by the bundled town on startup, keeping those pets, and the old file is kept
 * next to it (`layout.json.town-<hash>.bak`). A town the user edited, the
 * classic office and any other layout are left alone; the editor's Templates →
 * Pokémon Town still offers the new one.
 *
 * "Exactly as it shipped" is a content hash of the layout's structure (the
 * grid, colours, furniture, carpets and areas, with object keys sorted), so a
 * town the office loaded and saved again unchanged still matches.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR, LAYOUT_FILE_NAME } from './constants.js';

/** The fields a layout's look and behaviour come from. */
const STRUCTURE_KEYS = [
  'version',
  'cols',
  'rows',
  'tiles',
  'tileColors',
  'furniture',
  'carpetTiles',
  'areas',
  'areaTiles',
] as const;

/**
 * The towns earlier versions shipped (townContentHash → where it came from).
 * Add the bundled town's hash here when a release replaces it.
 */
export const PREVIOUS_TOWN_HASHES: ReadonlyMap<string, string> = new Map([
  ['4c27f6dd9909d8e90042e9ecfda6791a2d25eae51677685bb38337c2fd76438b', 'v0.3.0 to v0.4.0'],
  ['0333dae5e8079e4cb5c3a226d750b243b7fec6306154abf6e9841ad59dfa98b6', 'pre-release 4f1aeb6'],
  ['8b64f3d4d99c2ddd65dbf95929a312bb8667b1ef6c459f5c6890bb8ab86c7e99', 'pre-release 45566aa'],
  ['7f4806e70bb4a264b8c1f1ddadc4d2763be989f1384c9850253bac98eb974fae', 'pre-release 856fa2b'],
  ['b8beddfbdc3b4f5ca94e5109480559fe175c64a257e03d6b09ac37e531e86987', 'pre-release c2dc57e'],
]);

/** JSON with object keys sorted (and undefined members dropped, as JSON does). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const members = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The sha256 of a layout's structure: equal for the same town however it was
 *  saved (key order, formatting, pets, layoutRevision aside). */
export function townContentHash(layout: Record<string, unknown>): string {
  const structure = Object.fromEntries(STRUCTURE_KEYS.map((key) => [key, layout[key] ?? null]));
  return crypto.createHash('sha256').update(canonicalJson(structure)).digest('hex');
}

/** Whether a layout is a Pokémon Town (its Areas carry roles). */
function isTown(layout: Record<string, unknown> | null | undefined): boolean {
  const areas = layout?.areas;
  return (
    Array.isArray(areas) &&
    areas.some((a) => typeof (a as { role?: unknown } | null)?.role === 'string')
  );
}

export type TownUpgradeResult =
  | { upgraded: false; reason: 'no-saved-layout' | 'no-bundled-town' | 'current' | 'kept' }
  | { upgraded: true; from: string; backupPath: string };

/**
 * Replace a saved, unmodified earlier Pokémon Town with `bundledTown`, keeping
 * a backup next to the layout file and the pets placed in it. Never throws: a
 * failure leaves the saved layout as it was. `dir` defaults to ~/.pixel-agents.
 */
export function upgradeSavedTown(
  bundledTown: Record<string, unknown> | null | undefined,
  {
    dir = path.join(os.homedir(), LAYOUT_FILE_DIR),
    log = (message: string) => console.log(message),
  }: { dir?: string; log?: (message: string) => void } = {},
): TownUpgradeResult {
  if (!bundledTown || !isTown(bundledTown)) return { upgraded: false, reason: 'no-bundled-town' };
  const file = path.join(dir, LAYOUT_FILE_NAME);
  let raw: string;
  let saved: Record<string, unknown>;
  try {
    raw = fs.readFileSync(file, 'utf-8');
    saved = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { upgraded: false, reason: 'no-saved-layout' };
  }
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
    return { upgraded: false, reason: 'kept' };
  }
  const hash = townContentHash(saved);
  if (hash === townContentHash(bundledTown)) return { upgraded: false, reason: 'current' };
  const from = PREVIOUS_TOWN_HASHES.get(hash);
  if (!from) return { upgraded: false, reason: 'kept' };

  const backupPath = path.join(dir, `${LAYOUT_FILE_NAME}.town-${hash.slice(0, 8)}.bak`);
  const next = { ...bundledTown, pets: Array.isArray(saved.pets) ? saved.pets : [] };
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(backupPath, raw);
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing was written */
    }
    log(
      `[Pixel Agents] Could not upgrade the saved Pokémon Town (it is unchanged): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { upgraded: false, reason: 'kept' };
  }
  log(
    `[Pixel Agents] Upgraded the saved Pokémon Town (${from}) to the new town; the old layout is in ${backupPath}`,
  );
  return { upgraded: true, from, backupPath };
}
