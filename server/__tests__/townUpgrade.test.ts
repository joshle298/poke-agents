import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadDefaultLayout, loadStandaloneDefaultLayout } from '../src/assetLoader.js';
import { PREVIOUS_TOWN_HASHES, townContentHash, upgradeSavedTown } from '../src/townUpgrade.js';

const REPO_ASSETS_ROOT = path.resolve(__dirname, '../../webview-ui/public');
/** The Pokémon Town exactly as v0.4.0 (and v0.3.x) shipped it. */
const V04_TOWN = path.resolve(__dirname, '../../webview-ui/test/fixtures/pokemon-town-v0.4.json');

const read = (file: string) =>
  JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
const bundledTown = () => loadStandaloneDefaultLayout(REPO_ASSETS_ROOT)!;

let dir: string;
let logs: string[];
const layoutFile = () => path.join(dir, 'layout.json');
const backups = () => fs.readdirSync(dir).filter((f) => f.endsWith('.bak'));
const upgrade = (bundled = bundledTown()) =>
  upgradeSavedTown(bundled, { dir, log: (m) => logs.push(m) });

/** Save a layout the way the office does (pretty-printed). */
function save(layout: unknown): string {
  const raw = JSON.stringify(layout, null, 2);
  fs.writeFileSync(layoutFile(), raw);
  return raw;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-town-upgrade-'));
  logs = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('townContentHash', () => {
  it('knows the town v0.4 shipped, and the bundled town is not one of the old ones', () => {
    expect(PREVIOUS_TOWN_HASHES.get(townContentHash(read(V04_TOWN)))).toBe('v0.3.0 to v0.4.0');
    expect(PREVIOUS_TOWN_HASHES.has(townContentHash(bundledTown()))).toBe(false);
    expect(bundledTown().cols).toBe(56);
  });

  it('is the same however the office saved it: key order, pets and revision aside', () => {
    const town = read(V04_TOWN);
    const reordered = Object.fromEntries(Object.entries(town).reverse());
    const furniture = (town.furniture as Array<Record<string, unknown>>).map((f) =>
      Object.fromEntries(Object.entries(f).reverse()),
    );
    const resaved = { ...reordered, furniture, pets: [{ id: 'p1', petType: 2 }] };
    delete (resaved as Record<string, unknown>).layoutRevision;
    expect(townContentHash(resaved)).toBe(townContentHash(town));
  });

  it('changes when anything in the town changes', () => {
    const town = read(V04_TOWN);
    const furniture = [...(town.furniture as Array<Record<string, unknown>>)];
    furniture[0] = { ...furniture[0], col: (furniture[0].col as number) + 1 };
    expect(townContentHash({ ...town, furniture })).not.toBe(townContentHash(town));
  });
});

describe('upgradeSavedTown', () => {
  it('replaces an unchanged earlier town with the new one, keeping its pets and a backup', () => {
    const pets = [{ id: 'p1', petType: 1 }];
    const raw = save({ ...read(V04_TOWN), pets });
    const result = upgrade();
    expect(result).toMatchObject({ upgraded: true, from: 'v0.3.0 to v0.4.0' });
    const now = read(layoutFile());
    expect(now.cols).toBe(56);
    expect(townContentHash(now)).toBe(townContentHash(bundledTown()));
    expect(now.pets).toEqual(pets);
    expect(backups()).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, backups()[0]), 'utf-8')).toBe(raw);
    expect(logs.join('\n')).toContain('Upgraded the saved Pokémon Town');
    // Done once: the next start finds the current town.
    expect(upgrade()).toEqual({ upgraded: false, reason: 'current' });
    expect(backups()).toHaveLength(1);
  });

  it('keeps a town the user edited, and the classic office, untouched', () => {
    const town = read(V04_TOWN);
    const furniture = (town.furniture as unknown[]).slice(1);
    for (const layout of [{ ...town, furniture }, loadDefaultLayout(REPO_ASSETS_ROOT)]) {
      const raw = save(layout);
      expect(upgrade()).toEqual({ upgraded: false, reason: 'kept' });
      expect(fs.readFileSync(layoutFile(), 'utf-8')).toBe(raw);
    }
    expect(backups()).toEqual([]);
  });

  it('does nothing without a saved layout, or without a bundled town to move to', () => {
    expect(upgrade()).toEqual({ upgraded: false, reason: 'no-saved-layout' });
    expect(fs.readdirSync(dir)).toEqual([]);
    const raw = save(read(V04_TOWN));
    expect(upgrade(loadDefaultLayout(REPO_ASSETS_ROOT)!)).toEqual({
      upgraded: false,
      reason: 'no-bundled-town',
    });
    expect(upgrade(null as unknown as Record<string, unknown>).upgraded).toBe(false);
    expect(fs.readFileSync(layoutFile(), 'utf-8')).toBe(raw);
  });

  it('leaves the saved town as it was when the new one cannot be written', () => {
    const raw = save(read(V04_TOWN));
    fs.mkdirSync(path.join(dir, 'layout.json.tmp')); // the atomic write's temp file can't be made
    expect(upgrade()).toEqual({ upgraded: false, reason: 'kept' });
    expect(fs.readFileSync(layoutFile(), 'utf-8')).toBe(raw);
    expect(logs.join('\n')).toContain('Could not upgrade');
  });
});
