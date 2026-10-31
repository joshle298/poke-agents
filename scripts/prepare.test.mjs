import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BUILD_OUTPUTS,
  BUILD_STAMP,
  BUILD_TOOLS,
  buildFailedMessage,
  doneMessage,
  noBuildToolsMessage,
  planPrepare,
  startMessage,
} from './prepare.mjs';

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
    { husky: false, build: true, reason: 'missing', noBuildTools: false },
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
    { husky: true, build: true, reason: 'missing', noBuildTools: false },
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
    { husky: true, build: false, reason: null, noBuildTools: false },
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
  assert.equal(plan.reason, 'stale');
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
    assert.deepEqual(plan, { husky: true, build: false, reason: null, noBuildTools: false });
  }
});

test('without the build tools (npm ci --omit=dev) no build is attempted', () => {
  const missing = planPrepare({
    inGitCheckout: true,
    built: false,
    builtCommit: null,
    headCommit: HEAD,
    skipBuild: false,
    buildToolsInstalled: false,
  });
  assert.deepEqual(missing, { husky: true, build: false, reason: 'missing', noBuildTools: true });

  const stale = planPrepare({
    inGitCheckout: true,
    built: true,
    builtCommit: OLD,
    headCommit: HEAD,
    skipBuild: false,
    buildToolsInstalled: false,
  });
  assert.deepEqual(stale, { husky: true, build: false, reason: 'stale', noBuildTools: true });

  // Nothing to build: missing tools don't matter.
  const current = planPrepare({
    inGitCheckout: true,
    built: true,
    builtCommit: HEAD,
    headCommit: HEAD,
    skipBuild: false,
    buildToolsInstalled: false,
  });
  assert.equal(current.noBuildTools, false);
});

test('husky runs only in a git checkout that has it installed', () => {
  const plan = planPrepare({
    inGitCheckout: true,
    built: true,
    builtCommit: HEAD,
    headCommit: HEAD,
    skipBuild: false,
    huskyInstalled: false,
  });
  assert.equal(plan.husky, false);
});

test('messages name the next command a new user needs', () => {
  assert.match(startMessage('missing'), /Building the app into dist\//);
  assert.match(startMessage('stale'), /built from another commit/);
  assert.match(
    doneMessage(4321, true),
    /Built dist\/ in 4\.3 s\. Start the office with: npm start$/,
  );
  // A git-dependency install is started with npx, not npm start.
  assert.doesNotMatch(doneMessage(4321, false), /npm start/);
  assert.match(noBuildToolsMessage('missing'), /Can't build dist\//);
  assert.match(noBuildToolsMessage('missing'), /npm ci --include=dev/);
  assert.match(noBuildToolsMessage('stale'), /Kept the dist\/ built from another commit/);
  assert.match(buildFailedMessage(), /npm run build:app/);
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

test('the build tools prepare checks for are devDependencies of their workspace', () => {
  for (const [dir, name] of BUILD_TOOLS) {
    const manifest = JSON.parse(
      fs.readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf-8'),
    );
    assert.ok(manifest.devDependencies?.[name], `${dir}/package.json devDependencies has ${name}`);
  }
});

// ── prepare.mjs run as npm runs it, in a throwaway repository ──────────

const PREPARE_SOURCE = new URL('./prepare.mjs', import.meta.url);

/**
 * A temp directory laid out like this repository: scripts/prepare.mjs and a
 * package.json whose build:app runs `buildScript`. `tools` fakes the
 * installed build tools; `git` makes it a git checkout with one commit.
 */
function fakeRepo(t, { buildScript, tools, git = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-prepare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(PREPARE_SOURCE, path.join(root, 'scripts', 'prepare.mjs'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fake', private: true, scripts: { 'build:app': buildScript } }),
  );
  fs.mkdirSync(path.join(root, 'webview-ui'));
  if (tools) {
    for (const [, name] of BUILD_TOOLS) {
      const dir = path.join(root, 'node_modules', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
    }
  }
  if (git) {
    const run = (...args) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: root,
        stdio: 'ignore',
      });
    run('init', '-q');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
  }
  return root;
}

function runPrepare(root) {
  const env = { ...process.env };
  // CI sets this for the whole job; these runs are about the build itself.
  delete env.POKE_AGENTS_SKIP_BUILD;
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'prepare.mjs')], {
    cwd: root,
    env,
    encoding: 'utf-8',
  });
}

const WRITE_DIST = `node -e "const fs=require('fs');fs.mkdirSync('dist/webview',{recursive:true});fs.writeFileSync('dist/cli.js','');fs.writeFileSync('dist/webview/index.html','')"`;
const STACK_LINE = /^\s+at .+[(:]/m;

test('a clone installed without devDependencies fails with the fix, not a stack trace', (t) => {
  const root = fakeRepo(t, { buildScript: `node -e "require('esbuild')"`, tools: false });
  const result = runPrepare(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm ci --include=dev/);
  assert.doesNotMatch(result.stderr, STACK_LINE);
  assert.doesNotMatch(result.stdout, /Building/);
});

test('a failing build reports itself once, without a prepare.mjs stack trace', (t) => {
  const root = fakeRepo(t, {
    buildScript: `node -e "console.error('build broke here');process.exit(3)"`,
    tools: true,
  });
  const result = runPrepare(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /build broke here/);
  assert.match(result.stderr, /Building dist\/ failed/);
  assert.doesNotMatch(result.stderr, STACK_LINE);
});

test('a fresh clone builds, stamps dist/ and says how to start', (t) => {
  const root = fakeRepo(t, { buildScript: WRITE_DIST, tools: true, git: true });
  const result = runPrepare(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Building the app into dist\//);
  assert.match(result.stdout, /Built dist\/ in \d+\.\d s\. Start the office with: npm start/);
  // husky is a devDependency: not installed here, so it is skipped quietly.
  assert.doesNotMatch(result.stderr, /husky/);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim();
  assert.equal(fs.readFileSync(path.join(root, BUILD_STAMP), 'utf-8').trim(), head);
});
