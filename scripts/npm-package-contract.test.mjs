import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EXPECTED_BIN_NAME,
  EXPECTED_HELP_USAGE,
  EXPECTED_PACKAGE_NAME,
  EXPECTED_REPOSITORY_URL,
  getPublicationDecision,
  normalizePackMetadata,
  parsePackJsonOutput,
  parseStartupUrl,
  REQUIRED_PACKAGE_FILES,
  REQUIRED_PACKAGE_PREFIXES,
  validatePackageFiles,
  validatePackageManifest,
  validateReleaseIdentity,
  validateTarballIntegrity,
} from './npm-package-contract.mjs';

const REPO_MANIFEST = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
);

function validFiles() {
  return [
    ...REQUIRED_PACKAGE_FILES,
    ...REQUIRED_PACKAGE_PREFIXES.map((prefix) => `${prefix}fixture.dat`),
  ].map((path) => ({ path }));
}

test('the repository manifest is the Poke Agents package with one poke-agents bin', () => {
  assert.doesNotThrow(() => validatePackageManifest(REPO_MANIFEST));
  assert.equal(REPO_MANIFEST.name, '@joshle298/poke-agents');
  assert.deepEqual(REPO_MANIFEST.bin, { 'poke-agents': './dist/cli.js' });
  assert.equal(REPO_MANIFEST.repository.url, 'https://github.com/joshle298/poke-agents');
  assert.equal(EXPECTED_HELP_USAGE, 'Usage: poke-agents');
});

test('rejects an upstream identity or a leftover pixel-agents bin', () => {
  const valid = {
    name: EXPECTED_PACKAGE_NAME,
    repository: { url: EXPECTED_REPOSITORY_URL },
    bin: { [EXPECTED_BIN_NAME]: './dist/cli.js' },
  };
  assert.doesNotThrow(() => validatePackageManifest(valid));
  assert.throws(
    () => validatePackageManifest({ ...valid, name: 'pixel-agents' }),
    /expected name @joshle298\/poke-agents, received pixel-agents/,
  );
  assert.throws(
    () => validatePackageManifest({ ...valid, name: 'poke-agents' }),
    /expected name @joshle298\/poke-agents/,
  );
  assert.throws(
    () =>
      validatePackageManifest({
        ...valid,
        repository: { url: 'https://github.com/pixel-agents-hq/pixel-agents' },
      }),
    /expected repository https:\/\/github\.com\/joshle298\/poke-agents/,
  );
  assert.throws(
    () =>
      validatePackageManifest({
        ...valid,
        bin: { 'poke-agents': './dist/cli.js', 'pixel-agents': './dist/cli.js' },
      }),
    /expected bin/,
  );
  assert.throws(
    () => validatePackageManifest({ ...valid, bin: { 'pixel-agents': './dist/cli.js' } }),
    /expected bin/,
  );
  assert.throws(() => validatePackageManifest({ ...valid, bin: './dist/cli.js' }), /expected bin/);
});

test('reads the tokened URL from the startup line only once the line is complete', () => {
  const url = 'http://127.0.0.1:41510/?token=abc123';
  assert.equal(
    parseStartupUrl(`[Pixel Agents] Terminal disabled\nPoke Agents running at ${url}\n`),
    url,
  );
  assert.equal(parseStartupUrl('Poke Agents running at http://127.0.0.1:415'), null);
  assert.equal(parseStartupUrl(`Pixel Agents server running at ${url}\n`), null);
});

test('normalizes npm pack array and keyed-object output', () => {
  const metadata = { filename: 'joshle298-poke-agents-0.1.0.tgz', files: validFiles() };
  assert.equal(normalizePackMetadata([metadata]), metadata);
  assert.equal(normalizePackMetadata({ '@joshle298/poke-agents@0.1.0': metadata }), metadata);
});

test('extracts pack JSON after lifecycle build output', () => {
  const metadata = [{ filename: 'joshle298-poke-agents-0.1.0.tgz', files: validFiles() }];
  const output = `[generate-messages] built protocol\nHUSKY=0 skip install${JSON.stringify(metadata)}`;
  assert.deepEqual(parsePackJsonOutput(output), metadata);
});

test('rejects a known-bad tarball missing the shipped hook', () => {
  const files = validFiles().filter((file) => file.path !== 'dist/hooks/claude-hook.js');
  assert.throws(
    () => validatePackageFiles(files),
    /missing required file: dist\/hooks\/claude-hook\.js/,
  );
});

test('rejects source and preview files even when required files exist', () => {
  assert.throws(
    () => validatePackageFiles([...validFiles(), { path: 'server/src/cli.ts' }]),
    /forbidden package path: server\/src\/cli\.ts/,
  );
  assert.throws(
    () => validatePackageFiles([...validFiles(), { path: 'dist/browser/index.html' }]),
    /forbidden package path: dist\/browser\/index\.html/,
  );
});

test('validates release tag, ref, repository, and monotonic version', () => {
  const manifest = {
    name: '@joshle298/poke-agents',
    version: '1.4.0',
    repository: { url: 'https://github.com/joshle298/poke-agents' },
  };
  assert.doesNotThrow(() =>
    validateReleaseIdentity({
      manifest,
      releaseTag: 'v1.4.0',
      ref: 'refs/tags/v1.4.0',
      latestVersion: '1.0.2',
    }),
  );
  assert.throws(
    () =>
      validateReleaseIdentity({
        manifest,
        releaseTag: 'v1.3.0',
        ref: 'refs/tags/v1.3.0',
        latestVersion: '1.0.2',
      }),
    /does not match package version/,
  );
  assert.throws(
    () =>
      validateReleaseIdentity({
        manifest: { ...manifest, name: 'pixel-agents' },
        releaseTag: 'v1.4.0',
        ref: 'refs/tags/v1.4.0',
        latestVersion: '1.0.2',
      }),
    /Expected package name @joshle298\/poke-agents/,
  );
  assert.throws(
    () =>
      validateReleaseIdentity({
        manifest: { ...manifest, version: '1.0.2' },
        releaseTag: 'v1.0.2',
        ref: 'refs/tags/v1.0.2',
        latestVersion: '1.0.2',
      }),
    /must be greater than npm latest/,
  );
  assert.doesNotThrow(() =>
    validateReleaseIdentity({
      manifest: { ...manifest, version: '1.0.2' },
      releaseTag: 'v1.0.2',
      ref: 'refs/tags/v1.0.2',
      latestVersion: '1.0.2',
      exactVersionExists: true,
    }),
  );
});

test('publishes only absent versions and treats integrity safely', () => {
  assert.equal(getPublicationDecision('sha512-local', null), 'publish');
  assert.equal(getPublicationDecision('sha512-same', 'sha512-same'), 'skip');
  assert.equal(getPublicationDecision('sha512-local', 'sha512-other'), 'conflict');
});

test('rejects a tarball changed after its metadata was created', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poke-agents-integrity-test-'));
  const tarballPath = path.join(tmpDir, 'poke-agents.tgz');
  const verifiedIntegrity =
    'sha512-RkN76vtkA1+8p/GSGfbyKAGc1SvEWGcyy0e6CVFdcQKBmX1sAD93WjE7XaXvLvWCO8Q8zHEugymaUbvwb3dBXg==';
  try {
    fs.writeFileSync(tarballPath, 'verified tarball');
    assert.equal(validateTarballIntegrity(tarballPath, verifiedIntegrity), verifiedIntegrity);

    fs.writeFileSync(tarballPath, 'tampered tarball');
    assert.throws(
      () => validateTarballIntegrity(tarballPath, verifiedIntegrity),
      /integrity changed after verification/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
