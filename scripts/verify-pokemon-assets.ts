/** Download and validate the roster's normal PMD art into the user's cache.
 * Usage: npx tsx scripts/verify-pokemon-assets.ts <species.json> <report.json>
 * Artwork stays outside the repository. The report contains metadata only.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';

import {
  parseAnimData,
  resolveAnim,
  sheetAnimNames,
  validateSheet,
} from '../server/src/pokemon/animData.js';
import {
  CREDIT_NAMES_PATH,
  PmdCache,
  animDataPath,
  isValidDex,
  portraitCreditsPath,
  portraitPath,
  sheetPath,
  spriteCreditsPath,
  type PmdRelPath,
} from '../server/src/pokemon/pmdCache.js';

type Species = { dex: number; name: string };
type Result = Species &
  ({ ok: true; bodyPx: number; size: 'small' | 'medium' | 'large' } | { ok: false; error: string });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSpecies(roster: unknown): Species[] {
  if (!record(roster) || !Array.isArray(roster.lines) || !Array.isArray(roster.legendaries)) {
    throw new Error('Roster needs lines and legendaries arrays');
  }
  const members: unknown[] = roster.lines.flatMap((line: unknown) => {
    if (!record(line) || !Array.isArray(line.members) || line.members.length === 0) {
      throw new Error('Every line needs a non-empty members array');
    }
    return line.members;
  });
  const seen = new Set<number>();
  return [...members, ...roster.legendaries].map((value: unknown) => {
    if (
      !record(value) ||
      !isValidDex(value.dex) ||
      typeof value.name !== 'string' ||
      !value.name.trim()
    ) {
      throw new Error('Every species needs a valid dex number and name');
    }
    if (seen.has(value.dex)) throw new Error(`Duplicate dex ${value.dex}`);
    seen.add(value.dex);
    return { dex: value.dex, name: value.name };
  });
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    throw new Error('Usage: tsx scripts/verify-pokemon-assets.ts <species.json> <report.json>');
  }
  const roster: unknown = JSON.parse(await readFile(input, 'utf8'));
  const species = readSpecies(roster);
  const cache = new PmdCache({ concurrency: 8 });
  const results: Result[] = [];

  async function bytes(path: PmdRelPath | null): Promise<Buffer> {
    if (!path) throw new Error('Invalid asset path');
    const data = await cache.readFile(path);
    if (!data?.length) throw new Error(`Missing ${path}`);
    return data;
  }

  async function verify(s: Species): Promise<Result> {
    try {
      const data = parseAnimData((await bytes(animDataPath(s.dex, false))).toString('utf8'));
      if (!data) throw new Error('Invalid AnimData');
      let bodyPx = 0;
      for (const name of ['Idle', 'Walk']) {
        const anim = resolveAnim(data, name);
        if (!anim) throw new Error(`Missing ${name} animation`);
        const png = PNG.sync.read(
          await bytes(sheetPath(s.dex, false, anim.source, sheetAnimNames(data))),
        );
        const check = validateSheet(anim, png.width, png.height);
        if (!check.ok) throw new Error(`${name}: ${check.reason}`);
        for (let direction = 0; direction < check.directions; direction++) {
          for (let frame = 0; frame < check.frames; frame++) {
            let minX = anim.frameWidth;
            let minY = anim.frameHeight;
            let maxX = -1;
            let maxY = -1;
            for (let y = 0; y < anim.frameHeight; y++) {
              for (let x = 0; x < anim.frameWidth; x++) {
                const index =
                  ((direction * anim.frameHeight + y) * png.width + frame * anim.frameWidth + x) *
                  4;
                if (png.data[index + 3] < 2) continue;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
              }
            }
            if (maxX < 0) throw new Error(`${name}: empty frame`);
            bodyPx = Math.max(bodyPx, maxX - minX + 1, maxY - minY + 1);
          }
        }
      }
      const portrait = PNG.sync.read(await bytes(portraitPath(s.dex, false, 'Normal')));
      if (!portrait.data.some((v, i) => i % 4 === 3 && v >= 2)) throw new Error('Empty portrait');
      await bytes(spriteCreditsPath(s.dex, false));
      await bytes(portraitCreditsPath(s.dex, false));
      return {
        ...s,
        ok: true,
        bodyPx,
        size: bodyPx <= 32 ? 'small' : bodyPx <= 48 ? 'medium' : 'large',
      };
    } catch (error) {
      return { ...s, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  await bytes(CREDIT_NAMES_PATH);
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < species.length) {
        results.push(await verify(species[next++]));
        if (results.length % 25 === 0) {
          console.log(
            `Checked ${results.length}/${species.length}; ${results.filter((r) => r.ok).length} verified`,
          );
        }
      }
    }),
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        cacheRoot: cache.root,
        results: results.sort((a, b) => a.dex - b.dex),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Saved ${output}: ${results.filter((r) => r.ok).length}/${species.length} verified; cache ${cache.root}`,
  );
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
