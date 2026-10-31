// Build the desktop app's main process into dist/:
//
//   dist/main.js      src/electron/main.ts bundled with the office server it
//                     runs in-process (Fastify included; Electron external)
//   dist/preload.js   src/electron/preload.ts, the office window's bridge
//   dist/office/      the built office (assets/ and webview/) copied from the
//                     repo's dist/, which `npm run build:app` makes
//
// `--production` minifies. Run from the repo: the bundle pulls the server's
// sources and dependencies from the root workspace.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.dirname(DESKTOP);
const OFFICE_PARTS = ['webview', 'assets'];
const production = process.argv.includes('--production');

const rootVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8')).version;
const desktopVersion = JSON.parse(
  fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf-8'),
).version;
if (rootVersion !== desktopVersion) {
  console.error(
    `[desktop] desktop/package.json version ${desktopVersion} differs from the repo's ${rootVersion}; make them match.`,
  );
  process.exit(1);
}

for (const part of OFFICE_PARTS) {
  if (!fs.existsSync(path.join(REPO, 'dist', part))) {
    console.error(
      `[desktop] dist/${part} is missing: run \`npm run build:app\` at the repo root first.`,
    );
    process.exit(1);
  }
}

await esbuild.build({
  entryPoints: [path.join(DESKTOP, 'src', 'electron', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(DESKTOP, 'dist', 'main.js'),
  minify: production,
  sourcemap: false,
  external: [
    'electron',
    // The terminal's native PTY module is optional and never used here (the
    // app runs without Claude Code tracking); leave the require to fail softly.
    '@lydell/node-pty',
    'node-pty',
    // ws's optional native speedups.
    'bufferutil',
    'utf-8-validate',
  ],
  define: { 'process.env.PIXEL_AGENTS_VERSION': JSON.stringify(rootVersion) },
  logLevel: 'warning',
});

// The window's preload: runs sandboxed, where only `electron` (and a few
// Node built-ins) can be required, so everything else is bundled in.
await esbuild.build({
  entryPoints: [path.join(DESKTOP, 'src', 'electron', 'preload.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(DESKTOP, 'dist', 'preload.js'),
  minify: production,
  sourcemap: false,
  external: ['electron'],
  logLevel: 'warning',
});

const officeDir = path.join(DESKTOP, 'dist', 'office');
fs.rmSync(officeDir, { recursive: true, force: true });
for (const part of OFFICE_PARTS) {
  fs.cpSync(path.join(REPO, 'dist', part), path.join(officeDir, part), { recursive: true });
}
console.log(
  `[desktop] built dist/main.js, dist/preload.js and dist/office/ (${production ? 'production' : 'development'})`,
);
