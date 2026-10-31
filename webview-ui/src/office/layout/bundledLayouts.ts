/**
 * The layouts that ship with the office, offered by the editor's Templates panel:
 * the Pokémon Town (the standalone default for new installs) and the classic
 * office (upstream's default, still the VS Code default). Each JSON is loaded
 * on demand as its own chunk, so neither weighs on the main bundle.
 */

import type { OfficeLayout } from '../types.js';
import { migrateLayoutColors } from './layoutSerializer.js';

export type BundledLayoutId = 'town' | 'classic';

export interface BundledLayout {
  id: BundledLayoutId;
  label: string;
  load: () => Promise<OfficeLayout>;
}

export const BUNDLED_LAYOUTS: readonly BundledLayout[] = [
  {
    id: 'town',
    label: 'Pokémon Town',
    load: async () =>
      (await import('../../../public/assets/layouts/pokemon-town.json'))
        .default as unknown as OfficeLayout,
  },
  {
    id: 'classic',
    label: 'Classic Office',
    load: async () =>
      (await import('../../../public/assets/default-layout-1.json'))
        .default as unknown as OfficeLayout,
  },
];

/**
 * A bundled layout made ready to replace `current`: a private copy, migrated
 * like any loaded layout, keeping the pets the user already placed.
 */
export function prepareBundledLayout(bundled: OfficeLayout, current: OfficeLayout): OfficeLayout {
  const copy = migrateLayoutColors(structuredClone(bundled));
  return { ...copy, pets: (current.pets ?? []).map((p) => ({ ...p })) };
}
