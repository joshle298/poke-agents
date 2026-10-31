// Docs drift checks: what the README, CLAUDE.md and package metadata say
// about Poke Agents must match the code. Run with `npm run test:package-contract`.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf-8');

const README = read('README.md');
const CLAUDE = read('CLAUDE.md');
const CLI_SOURCE = read('server/src/cli.ts');
const UPSTREAM_CREDIT = 'https://github.com/pixel-agents-hq/pixel-agents';

/** The text from `start` (a heading line) up to the next heading of the same level. */
function section(text, start) {
  const from = text.indexOf(`\n${start}\n`);
  assert.ok(from >= 0, `missing section ${start}`);
  const level = start.match(/^#+/)[0];
  const rest = text.slice(from + start.length + 2);
  const end = rest.search(new RegExp(`^${level} `, 'm'));
  return end < 0 ? rest : rest.slice(0, end);
}

/** Markdown table rows (header and divider excluded) whose first cell matches `firstCell`. */
function tableRows(text, firstCell) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .filter((line) => firstCell.test(line.split('|')[1] ?? ''));
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

function constant(file, name) {
  const match = read(file).match(new RegExp(`export const ${name}[^=]*=\\s*([^;]+);`));
  assert.ok(match, `${file} exports ${name}`);
  return match[1].trim();
}

// ── Product identity ─────────────────────────────────────────────

test('package.json describes Poke Agents as inspired by Pixel Agents', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(
    manifest.description,
    'Your Conductor cloud sessions as Pokémon in a pixel-art office. Inspired by Pixel Agents.',
  );
});

test('no doc calls Poke Agents a fork of Pixel Agents', () => {
  // Poke Agents left GitHub's fork network. "Fork the repo" (a contributor
  // step) and upstream's own changelog entries are fine.
  const changelog = read('CHANGELOG.md');
  const ownChangelog = changelog.slice(0, changelog.indexOf('\n## Pixel Agents (upstream)'));
  const docs = {
    'README.md': README,
    'CHANGELOG.md (Poke Agents entries)': ownChangelog,
    'CLAUDE.md': CLAUDE,
    'CONTEXT.md': read('CONTEXT.md'),
    'CONTRIBUTING.md': read('CONTRIBUTING.md'),
    'SECURITY.md': read('SECURITY.md'),
    'package.json': read('package.json'),
    'webview-ui/public/manifest.webmanifest': read('webview-ui/public/manifest.webmanifest'),
    'webview-ui/index.html': read('webview-ui/index.html'),
    // The Mac app's About panel and Info.plist copyright.
    'desktop/src/constants.ts': read('desktop/src/constants.ts'),
    'desktop/electron-builder.yml': read('desktop/electron-builder.yml'),
  };
  const forkWording = /\b(?:a|the|this|our) fork\b|\bfork of\b|\bfork's\b/i;
  for (const [name, text] of Object.entries(docs)) {
    const line = text.split('\n').find((l) => forkWording.test(l));
    assert.equal(line, undefined, `${name} still calls Poke Agents a fork: ${line}`);
  }
});

test('the upstream credit stays: README names Pablo De Lucca and links Pixel Agents, LICENSE keeps his copyright', () => {
  assert.ok(
    README.includes(
      `inspired by and based on [Pixel Agents](${UPSTREAM_CREDIT}) by Pablo De Lucca`,
    ),
    'README opens with the upstream credit',
  );
  assert.match(section(README, '## License'), /Pablo De Lucca/);
  assert.match(read('LICENSE'), /^Copyright \(c\) \d{4} Pablo De Lucca$/m);
});

test('the README states that Poke Agents is only a visualizer', () => {
  const principle = section(README, '## What It Is');
  assert.match(principle, /All coding happens in Conductor/);
  assert.match(principle, /never does/);
  assert.match(principle, /store or change your Conductor settings/);
  assert.match(principle, /`--claude`/);
});

// ── README configuration tables ──────────────────────────────────

const CONFIGURATION = section(README, '## Configuration');

/** Every flag `poke-agents --help` documents (from the help text in cli.ts). */
function helpFlags() {
  const help = CLI_SOURCE.slice(CLI_SOURCE.indexOf('Usage: poke-agents'));
  const body = help.slice(0, help.indexOf('`);'));
  const flags = new Set();
  for (const line of body.split('\n')) {
    const match = line.match(/^ {2}(-[^ ].*?)(?: {2,}|$)/);
    if (!match) continue;
    for (const flag of match[1].matchAll(/(?:^|[ ,])(--?[a-z][a-z-]*)/g)) flags.add(flag[1]);
  }
  flags.delete('--help');
  return flags;
}

test('the README flag table lists every flag in poke-agents --help', () => {
  const flags = helpFlags();
  assert.ok(flags.size >= 10, `parsed the help text (${[...flags].join(' ')})`);
  const rows = tableRows(CONFIGURATION, /`-/).join('\n');
  for (const flag of flags) {
    assert.ok(
      rows.includes(`\`${flag}\``) || rows.includes(`\`${flag} `),
      `README table has ${flag}`,
    );
  }
});

test('every flag in the README table is one the CLI accepts', () => {
  for (const row of tableRows(CONFIGURATION, /`-/)) {
    for (const [, flag] of row.split('|')[1].matchAll(/`(--?[a-z][a-z-]*)/g)) {
      assert.ok(CLI_SOURCE.includes(`'${flag}'`), `cli.ts parses ${flag}`);
    }
  }
});

test('the README environment table lists every variable Poke Agents reads', () => {
  const names = new Set();
  const files = [...sourceFiles('server/src'), 'scripts/prepare.mjs'];
  for (const file of files) {
    for (const [name] of read(file).matchAll(/\b(?:POKE_AGENTS|CONDUCTOR_API)_[A-Z_]+\b/g)) {
      names.add(name);
    }
  }
  assert.ok(names.has('CONDUCTOR_API_KEY') && names.has('POKE_AGENTS_SKIP_BUILD'));
  const rows = tableRows(CONFIGURATION, /`[A-Z_]+`/).join('\n');
  for (const name of names) assert.ok(rows.includes(`\`${name}\``), `README table has ${name}`);
});

test('the README defaults match the code', () => {
  const port = constant('server/src/constants.ts', 'DEFAULT_STANDALONE_PORT');
  const budget = constant(
    'server/src/providers/stream/conductor/constants.ts',
    'DEFAULT_BUDGET_PER_MINUTE',
  );
  const [portRow] = tableRows(CONFIGURATION, /`--port`/);
  const [budgetRow] = tableRows(CONFIGURATION, /`--conductor-budget/);
  assert.match(portRow, new RegExp(`\\| \`${port}\` +\\|`));
  assert.match(budgetRow, new RegExp(`\\| \`${budget}\` +\\|`));

  const constants = read('server/src/providers/stream/conductor/constants.ts');
  const scope = constants.slice(constants.indexOf('export const DEFAULT_SCOPE'));
  const hours = scope.match(/activeWithinHours: (\d+)/)[1];
  const cap = scope.match(/maxSessions: (\d+)/)[1];
  assert.match(README, new RegExp(`active in the last ${hours} hours by default`));
  assert.match(README, new RegExp(`\\*\\*Cap:\\*\\* ${cap} sessions by default`));
});

test('the README data-file table names the files the code writes, and what they hold', () => {
  const rows = tableRows(CONFIGURATION, /`[a-z/-]+(?:\.json)?\/?`/);
  const byFile = Object.fromEntries(rows.map((row) => [row.split('|')[1].trim(), row]));

  // Each Conductor session's Pokémon lives in standalone-state.json (streamAgents),
  // not in conductor-state.json.
  assert.match(read('server/src/fileStateAdapter.ts'), /\$\{options\.namespace\}-state\.json/);
  assert.ok(
    sourceFiles('server/src').some((file) =>
      read(file).includes("new FileStateAdapter({ namespace: 'standalone' })"),
    ),
    'the standalone office persists through FileStateAdapter namespace standalone',
  );
  assert.match(read('server/src/fileStateAdapter.ts'), /streamAgents/);
  assert.match(byFile['`standalone-state.json`'], /Pokémon.*`streamAgents`/);
  assert.doesNotMatch(byFile['`conductor-state.json`'], /Pokémon|species/);
  assert.match(byFile['`conductor-state.json`'], /scope, hidden and pinned/);

  const literal = (file, name) => JSON.parse(constant(file, name).replace(/'/g, '"'));
  assert.equal(
    literal('server/src/providers/stream/conductor/constants.ts', 'STATE_FILE_NAME'),
    'conductor-state.json',
  );
  assert.equal(
    literal('server/src/constants.ts', 'STANDALONE_TOKEN_FILE_NAME'),
    'standalone-token',
  );
  assert.equal(literal('server/src/constants.ts', 'CONFIG_FILE_NAME'), 'config.json');
  assert.equal(literal('server/src/constants.ts', 'LAYOUT_FILE_NAME'), 'layout.json');
  assert.match(read('server/src/pokemon/constants.ts'), /PMD_CACHE_SUBDIR = \['cache', 'pmd'\]/);
  for (const file of [
    '`standalone-state.json`',
    '`conductor-state.json`',
    '`standalone-token`',
    '`config.json`',
    '`layout.json`',
    '`cache/pmd/`',
  ]) {
    assert.ok(byFile[file], `README data-file table has ${file}`);
  }
});

// ── CLAUDE.md protocol summary ───────────────────────────────────

/** Number of `$ref` variants in a oneOf union of core/asyncapi.yaml. */
function unionSize(name) {
  const spec = read('core/asyncapi.yaml');
  const schemas = spec.indexOf('\n  schemas:\n');
  const start = spec.indexOf(`\n    ${name}:\n`, schemas);
  assert.ok(schemas >= 0 && start >= 0, `asyncapi.yaml defines the ${name} schema`);
  const block = spec.slice(start, spec.indexOf('discriminator:', start));
  return [...block.matchAll(/^\s+- \$ref: /gm)].length;
}

test("CLAUDE.md's protocol message counts match core/asyncapi.yaml", () => {
  assert.match(
    CLAUDE,
    new RegExp(`\\*\\*${unionSize('ServerMessage')} ServerMessage variants\\*\\*`),
  );
  assert.match(
    CLAUDE,
    new RegExp(`\\*\\*${unionSize('ClientMessage')} ClientMessage variants\\*\\*`),
  );
  for (const type of ['requestSessionHistory', 'sessionHistory']) {
    assert.ok(CLAUDE.includes(`\`${type}\``), `CLAUDE.md names ${type}`);
  }
});

test('CONTEXT.md defines the Pokédex terms the UI uses', () => {
  const glossary = read('CONTEXT.md');
  for (const term of ['Pokédex', 'Chat tab', 'Pending question', 'PC Box', 'Level']) {
    assert.match(glossary, new RegExp(`^\\*\\*${term}\\*\\*:$`, 'm'), `CONTEXT.md defines ${term}`);
  }
});
