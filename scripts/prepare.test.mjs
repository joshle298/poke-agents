import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { BUILD_OUTPUTS, BUILD_STAMP, planPrepare } from './prepare.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

test('a git dependency install (no .git, no dist) builds and skips husky', () => {
  assert.deepEqual(
    planPrepare({
      inGitCheckout: false,
      built: false,
      builtCommit: null,
      headCommit: null,
      skipBuild: false,
    }),
    { husky: false, build: true },
  );
});

test('a fresh clone installs husky and builds', () => {
  assert.deepEqual(
    planPrepare({
      inGitCheckout: true,
      built: false,
      builtCommit: null,
      headCommit: HEAD,
      skipBuild: false,
    }),
    { husky: true, build: true },
  );
});

test('a clone whose dist was built from HEAD does not rebuild', () => {
  assert.deepEqual(
    planPrepare({
      inGitCheckout: true,
      built: true,
      builtCommit: HEAD,
      headCommit: HEAD,
      skipBuild: false,
    }),
    { husky: true, build: false },
  );
});

test('a clone whose dist came from another commit rebuilds after git pull', () => {
  const plan = planPrepare({
    inGitCheckout: true,
    built: true,
    builtCommit: OLD,
    headCommit: HEAD,
    skipBuild: false,
  });
  assert.equal(plan.build, true);
});

test('a clone with an unstamped dist rebuilds once, since its origin is unknown', () => {
  const plan = planPrepare({
    inGitCheckout: true,
    built: true,
    builtCommit: null,
    headCommit: HEAD,
    skipBuild: false,
  });
  assert.equal(plan.build, true);
});

test('an existing dist is kept when HEAD cannot be read (git missing)', () => {
  const plan = planPrepare({
    inGitCheckout: true,
    built: true,
    builtCommit: null,
    headCommit: null,
    skipBuild: false,
  });
  assert.equal(plan.build, false);
});

test('POKE_AGENTS_SKIP_BUILD wins over a missing or stale dist', () => {
  for (const built of [false, true]) {
    const plan = planPrepare({
      inGitCheckout: true,
      built,
      builtCommit: OLD,
      headCommit: HEAD,
      skipBuild: true,
    });
    assert.deepEqual(plan, { husky: true, build: false });
  }
});

test('the build outputs and stamp live under dist/, which git ignores and npm does not pack', () => {
  const gitignore = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf-8');
  assert.match(gitignore, /^\/?dist\/?$/m);
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
  );
  for (const file of BUILD_OUTPUTS) assert.ok(file.startsWith('dist/'));
  assert.ok(BUILD_STAMP.startsWith('dist/'));
  assert.ok(
    !manifest.files.some((entry) => BUILD_STAMP === entry || BUILD_STAMP.startsWith(entry)),
    'the build stamp must not ship in the npm package',
  );
  assert.equal(manifest.scripts.prepare, 'node scripts/prepare.mjs');
  assert.ok(manifest.scripts['build:app'], 'prepare runs npm run build:app');
});
