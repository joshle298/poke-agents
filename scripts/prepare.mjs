// npm `prepare` lifecycle script. npm runs it in two places:
//
// - `npm install` / `npm ci` in a clone, where it activates the husky git
//   hooks and builds dist/ so `npm start` works right after install;
// - when npm installs this repository as a git dependency
//   (`npx github:joshle298/poke-agents`). dist/ is gitignored, so without a
//   build here the installed package has no dist/cli.js for its bin. npm hides
//   this script's output in that case, so the messages below are for clones.
//
// In a git checkout dist/ is also rebuilt when it was built from another
// commit, so `git pull && npm ci && npm start` never runs a stale build.
// Set POKE_AGENTS_SKIP_BUILD=1 to skip the build (CI jobs build explicitly).

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files whose presence means the standalone app is built. */
export const BUILD_OUTPUTS = ['dist/cli.js', 'dist/webview/index.html'];

/** Commit the current dist/ was built from (gitignored with dist/, never packed). */
export const BUILD_STAMP = 'dist/.build-commit';

/** devDependencies `npm run build:app` needs, as [workspace dir, package name].
 *  npm leaves them out under `--omit=dev` or `NODE_ENV=production`. */
export const BUILD_TOOLS = [
  ['.', 'esbuild'],
  ['webview-ui', 'typescript'],
  ['webview-ui', 'vite'],
];

const PREFIX = '[poke-agents]';
const ISSUES_URL = 'https://github.com/joshle298/poke-agents/issues';

/**
 * Decide what `prepare` does. Pure, so the rules are unit-tested.
 *
 * `reason` says why dist/ needs a build ('missing' or 'stale'), or null when it
 * doesn't. `noBuildTools` is true when a build is needed but the build tools
 * are not installed, so `build` is false.
 *
 * @param {{ inGitCheckout: boolean, built: boolean, builtCommit: string | null,
 *           headCommit: string | null, skipBuild: boolean,
 *           huskyInstalled?: boolean, buildToolsInstalled?: boolean }} state
 * @returns {{ husky: boolean, build: boolean, reason: 'missing' | 'stale' | null,
 *             noBuildTools: boolean }}
 */
export function planPrepare({
  inGitCheckout,
  built,
  builtCommit,
  headCommit,
  skipBuild,
  huskyInstalled = true,
  buildToolsInstalled = true,
}) {
  const stale = inGitCheckout && headCommit !== null && builtCommit !== headCommit;
  const needed = !skipBuild && (!built || stale);
  return {
    husky: inGitCheckout && huskyInstalled,
    build: needed && buildToolsInstalled,
    reason: needed ? (built ? 'stale' : 'missing') : null,
    noBuildTools: needed && !buildToolsInstalled,
  };
}

/** The line printed before a build. */
export function startMessage(reason) {
  return reason === 'stale'
    ? `${PREFIX} dist/ was built from another commit: rebuilding it (POKE_AGENTS_SKIP_BUILD=1 skips this).`
    : `${PREFIX} Building the app into dist/. This takes a few seconds (POKE_AGENTS_SKIP_BUILD=1 skips it).`;
}

/** The line printed after a successful build. A clone gets the next step. */
export function doneMessage(elapsedMs, inGitCheckout) {
  const built = `${PREFIX} Built dist/ in ${(elapsedMs / 1000).toFixed(1)} s.`;
  return inGitCheckout ? `${built} Start the office with: npm start` : built;
}

/** Printed when a build is needed but the build tools are not installed. */
export function noBuildToolsMessage(reason) {
  const what =
    reason === 'stale'
      ? `${PREFIX} Kept the dist/ built from another commit: the build tools (devDependencies) are not installed.`
      : `${PREFIX} Can't build dist/: the build tools (devDependencies) are not installed.`;
  return [
    what,
    `${PREFIX} npm leaves them out with --omit=dev or NODE_ENV=production. Install them with: npm ci --include=dev`,
  ].join('\n');
}

/** Printed when `npm run build:app` fails; its own output is already above. */
export function buildFailedMessage() {
  return [
    `${PREFIX} Building dist/ failed. The build's error is above.`,
    `${PREFIX} Retry with: npm run build:app. If it keeps failing, report it at ${ISSUES_URL}`,
  ].join('\n');
}

/** True when `name` is installed for `dir` (in its node_modules or a parent's, up to root). */
function isInstalled(root, dir, name) {
  let current = path.resolve(root, dir);
  for (;;) {
    if (fs.existsSync(path.join(current, 'node_modules', name, 'package.json'))) return true;
    if (current === root) return false;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function readHeadCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function readBuiltCommit(root) {
  try {
    return fs.readFileSync(path.join(root, BUILD_STAMP), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function main() {
  const root = REPO_ROOT;
  const inGitCheckout = fs.existsSync(path.join(root, '.git'));
  const headCommit = inGitCheckout ? readHeadCommit(root) : null;
  const plan = planPrepare({
    inGitCheckout,
    built: BUILD_OUTPUTS.every((file) => fs.existsSync(path.join(root, file))),
    builtCommit: readBuiltCommit(root),
    headCommit,
    skipBuild: process.env.POKE_AGENTS_SKIP_BUILD === '1',
    huskyInstalled: isInstalled(root, '.', 'husky'),
    buildToolsInstalled: BUILD_TOOLS.every(([dir, name]) => isInstalled(root, dir, name)),
  });

  if (plan.husky) {
    try {
      execSync('husky', { cwd: root, stdio: 'inherit' });
    } catch {
      // Git hooks are a contributor convenience; never fail an install over them.
    }
  }

  if (plan.noBuildTools) {
    console.error(noBuildToolsMessage(plan.reason));
    // Without any dist/ there is nothing for `npm start` to run, so the
    // install fails here rather than at the first start. A stale dist/ still
    // runs, so it is kept with the warning.
    if (plan.reason === 'missing') process.exitCode = 1;
    return;
  }

  if (plan.build) {
    console.log(startMessage(plan.reason));
    const started = Date.now();
    try {
      execSync('npm run build:app', { cwd: root, stdio: 'inherit' });
    } catch {
      // The build printed its own error; a Node stack trace from here would
      // only bury it.
      console.error(buildFailedMessage());
      process.exitCode = 1;
      return;
    }
    if (headCommit) fs.writeFileSync(path.join(root, BUILD_STAMP), `${headCommit}\n`);
    console.log(doneMessage(Date.now() - started, inGitCheckout));
  }
}

// Run only when executed (`node scripts/prepare.mjs`), not when the test imports
// it. Compare real paths: Node resolves symlinks in import.meta.url but not in
// argv, so a checkout under a symlinked directory would otherwise skip main().
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
