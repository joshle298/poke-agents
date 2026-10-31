// Package the Mac app with electron-builder (after `node scripts/build.mjs
// --production`):
//
//   node scripts/dist-mac.mjs         this Mac's architecture only (arm64 on
//                                     Apple silicon, x64 on Intel)
//   node scripts/dist-mac.mjs --all   both, for sharing builds
//
// Extra arguments go to electron-builder.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export function archFlags(argv, arch) {
  if (argv.includes('--all')) return ['--arm64', '--x64'];
  return [arch === 'arm64' ? '--arm64' : '--x64'];
}

function main() {
  const argv = process.argv.slice(2);
  const cli = path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js');
  const args = [
    cli,
    '--mac',
    ...archFlags(argv, process.arch),
    '--config',
    'electron-builder.yml',
    ...argv.filter((arg) => arg !== '--all'),
  ];
  const result = spawnSync(process.execPath, args, { cwd: DESKTOP, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
