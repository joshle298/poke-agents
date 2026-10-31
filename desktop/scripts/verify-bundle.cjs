// electron-builder afterPack hook: fail the build when the packed app holds
// anything beyond the bundled main process, its preload and the built office. In
// particular no node_modules (the server is bundled into main.js), no PTY
// module and no Claude Code hook script: the app never runs agents.

const fs = require('node:fs');
const path = require('node:path');

const { listPackage } = require('@electron/asar');

/** The only entries app.asar may hold. */
const ASAR_ALLOWED = new Set(['/dist', '/dist/main.js', '/dist/preload.js', '/package.json']);
/** Files the office needs at runtime, relative to Resources/. */
const OFFICE_REQUIRED = ['office/webview/index.html', 'office/assets'];
/** Names that must never appear anywhere under Resources/. */
const FORBIDDEN = /node-pty|claude-hook|node_modules/i;

function walk(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    found.push(full);
    if (entry.isDirectory()) walk(full, found);
  }
  return found;
}

/** Problems with a packed app's Resources folder; empty when it is clean. */
function bundleProblems(resourcesDir) {
  const problems = [];
  const asar = path.join(resourcesDir, 'app.asar');
  if (!fs.existsSync(asar)) return [`missing ${asar}`];
  const extra = listPackage(asar, {})
    .map((entry) => entry.split(path.sep).join('/'))
    .filter((entry) => !ASAR_ALLOWED.has(entry));
  if (extra.length)
    problems.push(`app.asar holds unexpected files: ${extra.slice(0, 5).join(', ')}`);
  for (const rel of OFFICE_REQUIRED) {
    if (!fs.existsSync(path.join(resourcesDir, rel))) problems.push(`missing Resources/${rel}`);
  }
  const forbidden = walk(resourcesDir).filter((file) =>
    FORBIDDEN.test(path.relative(resourcesDir, file)),
  );
  if (forbidden.length) {
    problems.push(
      `forbidden files: ${forbidden
        .slice(0, 5)
        .map((f) => path.relative(resourcesDir, f))
        .join(', ')}`,
    );
  }
  return problems;
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const problems = bundleProblems(path.join(app, 'Contents', 'Resources'));
  if (problems.length) {
    throw new Error(
      `[desktop] ${path.basename(app)} failed its bundle check:\n- ${problems.join('\n- ')}`,
    );
  }
  console.log(`  • bundle check passed  app=${path.relative(process.cwd(), app)}`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.bundleProblems = bundleProblems;
