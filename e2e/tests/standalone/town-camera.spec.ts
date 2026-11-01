import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import type { TestHooksWindow } from '../../helpers/editor';
import { SEED_LAYOUT_REVISION } from '../../helpers/layout-seed';

/** The Pokémon Town as the standalone office ships it: wider and taller than
 *  the window at the default zoom. */
const TOWN = {
  ...(JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '../../../webview-ui/public/assets/layouts/pokemon-town.json'),
      'utf-8',
    ),
  ) as Record<string, unknown>),
  layoutRevision: SEED_LAYOUT_REVISION,
};

/** The Lab's walls (cols 3..18, rows 4..13 in the bundled town). */
const LAB = { minCol: 3, maxCol: 18, minRow: 4, maxRow: 13 };

/** Where tile (col, row)'s centre is on the canvas, in CSS px. */
async function tileCenter(page: Page, col: number, row: number) {
  return page.evaluate(
    ([c, r]) => (window as TestHooksWindow).__pixelAgentsTestHooks?.getTileCenter?.(c, r) ?? null,
    [col, row] as const,
  );
}

/** The world point (in tiles) under canvas point (x, y), and the tile size on
 *  screen: from two projected tile centres. */
async function worldAt(page: Page, x: number, y: number) {
  const a = await tileCenter(page, 0, 0);
  const b = await tileCenter(page, 1, 1);
  if (!a || !b) throw new Error('the canvas has no projection yet');
  const px = b.x - a.x;
  return { col: (x - a.x) / px, row: (y - a.y) / px, px };
}

test.describe('Standalone / the Pokémon Town camera', () => {
  test.use({ standaloneOptions: { seedLayout: TOWN, viewport: { width: 900, height: 700 } } });

  test('the town opens with the Lab in view, and a zoom about the pointer keeps the point under it @area:standalone', async ({
    page,
    standalone: _standalone,
  }) => {
    const canvas = page.locator('[data-testid="office-canvas"]');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('office canvas is not rendered');

    // The home view: the town is larger than the window, too narrow here for
    // the Lab and the Work Yard side by side, and the Lab, at the left, is
    // whole on screen with its walls.
    const inView = async (col: number, row: number) => {
      const p = await tileCenter(page, col, row);
      return p !== null && p.x > 0 && p.y > 0 && p.x < box.width && p.y < box.height;
    };
    await expect
      .poll(
        async () =>
          (await inView(LAB.minCol, LAB.minRow)) && (await inView(LAB.maxCol, LAB.maxRow)),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(await inView(55, 37), 'the far corner of the town is off screen').toBe(false);

    // Ctrl+wheel (a trackpad pinch arrives the same way) in the middle of the
    // home view, which sits against the town's top edge, then nearer a corner
    // of the view that left: each zoom step in leaves the world point under
    // the pointer where it was.
    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.25, 0.3],
    ] as const) {
      const x = box.width * fx;
      const y = box.height * fy;
      const before = await worldAt(page, x, y);
      await page.mouse.move(box.x + x, box.y + y);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -120);
      await page.keyboard.up('Control');
      await expect.poll(async () => (await worldAt(page, x, y)).px).toBeGreaterThan(before.px);
      // Let a few frames draw (and clamp) at the new zoom.
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
          ),
      );
      const after = await worldAt(page, x, y);
      const driftPx = Math.hypot(after.col - before.col, after.row - before.row) * after.px;
      expect(driftPx, `drift at ${fx},${fy}`).toBeLessThanOrEqual(2);
    }
  });
});
