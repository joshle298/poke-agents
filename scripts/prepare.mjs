// npm `prepare` lifecycle script. npm runs it in two places:
//
// - `npm install` / `npm ci` in a clone, where it activates the husky git
//   hooks and builds dist/ so `npm start` works right after install;
// - when npm installs this repository as a git dependency
//   (`npx github:joshle298/poke-agents`). dist/ is gitignored, so without a
//   build here the installed package has no dist/cli.js for its bin.
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

/**
 * Decide what `prepare` does. Pure, so the rules are unit-tested.
 *
 * @param {{ inGitCheckout: boolean, built: boolean, builtCommit: string | null,
 *           headCommit: string | null, skipBuild: boolean }} state
 * @returns {{ husky: boolean, build: boolean }}
 */
export function planPrepare({ inGitCheckout, built, builtCommit, headCommit, skipBuild }) {
  const stale = inGitCheckout && headCommit !== null && builtCommit !== headCommit;
  return {
    husky: inGitCheckout,
    build: !skipBuild && (!built || stale),
  };
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
  });

  if (plan.husky) {
    try {
      execSync('husky', { cwd: root, stdio: 'inherit' });
    } catch {
      // Git hooks are a contributor convenience; never fail an install over them.
    }
  }

  if (plan.build) {
    console.log('[poke-agents] Building dist/ (set POKE_AGENTS_SKIP_BUILD=1 to skip)');
    execSync('npm run build:app', { cwd: root, stdio: 'inherit' });
    if (headCommit) fs.writeFileSync(path.join(root, BUILD_STAMP), `${headCommit}\n`);
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
