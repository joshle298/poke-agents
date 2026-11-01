/**
 * The bundled world for Node tests: the real furniture catalog (decoded from
 * the committed manifests and PNGs) and the bundled layouts, read from disk
 * the same way the server reads them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFurnitureCatalog } from '../../core/src/assets/build.ts';
import { decodeAllFurniture } from '../../core/src/assets/loader.ts';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from '../src/office/layout/layoutSerializer.js';
import type { OfficeLayout } from '../src/office/types.js';

export const ASSETS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public/assets',
);

export const TOWN_LAYOUT_PATH = path.join(ASSETS_DIR, 'layouts/pokemon-town.json');
/** The Pokémon Town as v0.4 shipped it (a Lab of desks with a lectern, no Lab
 *  or field roles): what a user who edited that town still has. */
export const LEGACY_TOWN_LAYOUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/pokemon-town-v0.4.json',
);
export const CLASSIC_LAYOUT_PATH = path.join(ASSETS_DIR, 'default-layout-1.json');

let catalogBuilt = false;

/** Build the furniture catalog from the bundled assets (once per test file). */
export function loadBundledCatalog(): void {
  if (catalogBuilt) return;
  const catalog = buildFurnitureCatalog(ASSETS_DIR);
  const sprites = decodeAllFurniture(ASSETS_DIR, catalog);
  if (!buildDynamicCatalog({ catalog, sprites })) throw new Error('catalog did not build');
  catalogBuilt = true;
}

/** A bundled layout as the webview receives it (parsed and migrated). */
export function readBundledLayout(file: string): OfficeLayout {
  return migrateLayoutColors(JSON.parse(fs.readFileSync(file, 'utf-8')) as OfficeLayout);
}
