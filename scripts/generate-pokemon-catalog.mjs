#!/usr/bin/env node
/**
 * Generate server/src/pokemon/speciesCatalog.ts from a curated species.json.
 *
 *   node scripts/generate-pokemon-catalog.mjs <species.json> [out.ts]
 *
 * species.json is the research roster (evolution lines, legendaries, frame
 * metadata, credits). The catalog keeps only what species assignment needs:
 * line ids, dex numbers, names, size classes and evolution stages, plus the
 * Lead defaults. Frame data and credits are left out on purpose (the server
 * reads them from the downloaded AnimData.xml and credits.txt at runtime), and
 * no artwork is ever written: the output is names and numbers.
 *
 * Members can declare stage and evolvesFrom to describe branching evolution
 * paths. Legacy lines retain their original stage-based branch selection;
 * BRANCHED_LINES supplies stages for older research rosters.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(REPO_ROOT, 'server', 'src', 'pokemon', 'speciesCatalog.ts');
const SIZES = new Set(['small', 'medium', 'large']);
const MAX_DEX = 1025;

/** Stage of each member, in species.json member order, for lines that branch.
 *  The dex list pins the order the stages were written against. */
const BRANCHED_LINES = {
  // Eevee evolves into one of eight species.
  eevee: {
    dex: [133, 134, 135, 136, 196, 197, 470, 471, 700],
    stages: [1, 2, 2, 2, 2, 2, 2, 2, 2],
  },
  // Kirlia evolves into Gardevoir or Gallade.
  ralts: { dex: [280, 281, 282, 475], stages: [1, 2, 3, 3] },
};

function fail(message) {
  console.error(`generate-pokemon-catalog: ${message}`);
  process.exit(1);
}

/** Display name: PMDCollab spells Ho-Oh as Ho_Oh. */
function displayName(name) {
  return String(name).replace(/_/g, '-');
}

function idFromName(name) {
  return displayName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function member(raw, where) {
  const dex = raw?.dex;
  if (!Number.isInteger(dex) || dex < 1 || dex > MAX_DEX) fail(`${where}: bad dex ${dex}`);
  if (typeof raw.name !== 'string' || raw.name.trim() === '') fail(`${where}: missing name`);
  if (!SIZES.has(raw.size)) fail(`${where}: bad size ${raw.size}`);
  return { dex, name: displayName(raw.name), size: raw.size };
}

function buildCatalog(species) {
  if (
    !species ||
    typeof species !== 'object' ||
    !Array.isArray(species.lines) ||
    !Array.isArray(species.legendaries)
  ) {
    fail('species.json needs "lines" and "legendaries" arrays');
  }
  const seenDex = new Set();
  const seenIds = new Set();
  const claim = (dex, where) => {
    if (seenDex.has(dex)) fail(`${where}: dex ${dex} appears twice`);
    seenDex.add(dex);
  };
  const claimId = (id, where) => {
    if (!/^[a-z0-9]+$/.test(id)) fail(`${where}: bad id "${id}"`);
    if (seenIds.has(id)) fail(`${where}: id "${id}" appears twice`);
    seenIds.add(id);
  };

  const lines = species.lines.map((line, i) => {
    const id = String(line?.id ?? '');
    claimId(id, `lines[${i}]`);
    if (!Array.isArray(line.members) || line.members.length === 0) fail(`line ${id}: no members`);
    const members = line.members.map((m, j) => member(m, `line ${id} member ${j}`));
    const branched = BRANCHED_LINES[id];
    if (branched && branched.dex.join(',') !== members.map((m) => m.dex).join(',')) {
      fail(`line ${id}: members changed; update BRANCHED_LINES`);
    }
    const staged = members.map((m, j) => {
      claim(m.dex, `line ${id}`);
      const raw = line.members[j];
      const stage = raw.stage ?? (branched ? branched.stages[j] : j + 1);
      if (!Number.isInteger(stage) || stage < 1 || stage > 3) {
        fail(`line ${id}: bad stage ${stage}`);
      }
      const evolvesFrom = raw.evolvesFrom;
      if (evolvesFrom !== undefined) {
        const parentIndex = members.findIndex((p) => p.dex === evolvesFrom);
        if (parentIndex < 0 || parentIndex >= j) {
          fail(`line ${id}: invalid parent ${evolvesFrom} for ${m.dex}`);
        }
        const parentStage =
          line.members[parentIndex].stage ??
          (branched ? branched.stages[parentIndex] : parentIndex + 1);
        if (parentStage !== stage - 1) {
          fail(`line ${id}: invalid parent ${evolvesFrom} for ${m.dex}`);
        }
      }
      return { ...m, stage, ...(evolvesFrom !== undefined ? { evolvesFrom } : {}) };
    });
    if (!staged.some((m) => m.stage === 1)) fail(`line ${id}: no first stage`);
    if (
      staged.some((m) => m.evolvesFrom !== undefined) &&
      staged.some((m) => m.stage > 1 && m.evolvesFrom === undefined)
    ) {
      fail(`line ${id}: every evolved member needs a parent`);
    }
    return { id, members: staged };
  });
  for (const id of Object.keys(BRANCHED_LINES)) {
    if (!lines.some((line) => line.id === id)) fail(`BRANCHED_LINES names unknown line ${id}`);
  }

  const legendaries = species.legendaries.map((raw, i) => {
    const m = member(raw, `legendaries[${i}]`);
    claim(m.dex, `legendary ${m.name}`);
    const id = idFromName(m.name);
    claimId(id, `legendary ${m.name}`);
    return { id, ...m };
  });

  const leadDefaults = species.orchestratorDefaults;
  if (!Array.isArray(leadDefaults) || leadDefaults.length === 0) {
    fail('species.json needs a non-empty "orchestratorDefaults" array');
  }
  for (const dex of leadDefaults) {
    const legendary = legendaries.find((l) => l.dex === dex);
    if (!legendary) fail(`lead default ${dex} is not a legendary`);
    if (legendary.size === 'large') fail(`lead default ${dex} is large`);
  }

  return { lines, legendaries, leadDefaults };
}

function render(catalog, sourceName) {
  return `/**
 * Pokémon species catalog: metadata only (names, national dex numbers, size
 * classes, evolution stages). No artwork, frame data or credits; those are
 * downloaded and read at runtime (see pmdCache.ts and pokemonAssets.ts).
 *
 * GENERATED by scripts/generate-pokemon-catalog.mjs from ${sourceName}.
 * Do not edit by hand; re-run the script.
 */

/** Opaque body size class: small <= 32 px, medium 33-48 px, large > 48 px. */
export type PokemonSize = 'small' | 'medium' | 'large';

export interface CatalogMember {
  dex: number;
  name: string;
  size: PokemonSize;
  /** Evolution stage, 1-based. Branching lines repeat a stage. */
  stage: number;
  /** Parent dex for explicit evolution paths; absent on legacy stage-based lines. */
  evolvesFrom?: number;
}

export interface CatalogLine {
  /** Stable line id, persisted as an agent's \`pokemonLine\`. */
  id: string;
  members: readonly CatalogMember[];
}

export interface CatalogLegendary {
  /** Stable id, persisted as a Lead's \`pokemonLine\`. Never equals a line id. */
  id: string;
  dex: number;
  name: string;
  size: PokemonSize;
}

export interface PokemonCatalog {
  lines: readonly CatalogLine[];
  legendaries: readonly CatalogLegendary[];
  /** Automatic Lead defaults, in preference order. None is large. */
  leadDefaults: readonly number[];
}

export const POKEMON_CATALOG: PokemonCatalog = ${renderCatalog(catalog)};
`;
}

/** Render metadata as a TypeScript literal, then format it with the repository config. */
function renderCatalog({ lines, legendaries, leadDefaults }) {
  const entry = (value) => JSON.stringify(value);
  const renderedLines = lines.map(
    (line) => `{ id: ${entry(line.id)}, members: [\n${line.members.map(entry).join(',\n')}\n] }`,
  );
  return `{
lines: [
${renderedLines.join(',\n')}
],
legendaries: [
${legendaries.map(entry).join(',\n')}
],
leadDefaults: ${entry(leadDefaults)},
}`;
}

async function main() {
  const [input, output = DEFAULT_OUT] = process.argv.slice(2);
  if (!input) fail('usage: node scripts/generate-pokemon-catalog.mjs <species.json> [out.ts]');
  let species;
  try {
    species = JSON.parse(readFileSync(input, 'utf8'));
  } catch (err) {
    fail(`cannot read ${input}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const catalog = buildCatalog(species);
  const source = render(catalog, path.relative(REPO_ROOT, path.resolve(input)));
  // Format with the repo's Prettier config so the committed file passes format:check.
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(output)) ?? {};
  const formatted = await prettier.format(source, { ...config, filepath: output });
  writeFileSync(output, formatted, 'utf8');
  const memberCount = catalog.lines.reduce((n, line) => n + line.members.length, 0);
  console.log(
    `Wrote ${path.relative(REPO_ROOT, output)}: ${catalog.lines.length} lines (${memberCount} species), ${catalog.legendaries.length} legendaries.`,
  );
}

await main();
