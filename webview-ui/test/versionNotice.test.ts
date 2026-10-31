/**
 * The version label's "Updated to vX!" notice: shown after an update, never
 * on a first run (nothing was updated), and the in-app changelog has an entry
 * for the version the package ships.
 *
 * Run with: npm test
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { changelogEntries, toMajorMinor, versionNotice } from '../src/changelogData.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('versionNotice', () => {
  it('records the version silently on a first run', () => {
    expect(versionNotice('0.2.0', '')).toBe('record');
  });

  it('shows the notice after an update, and not once this version was seen', () => {
    expect(versionNotice('0.2.0', '0.1')).toBe('notice');
    expect(versionNotice('0.2.0', '1.5')).toBe('notice');
    expect(versionNotice('0.2.3', '0.2')).toBe('none');
  });

  it('does nothing before the host has said its version', () => {
    expect(versionNotice('', '')).toBe('none');
    expect(versionNotice('', '0.1')).toBe('none');
  });
});

describe('changelogEntries', () => {
  it("opens with the package's version, so the notice links to its notes", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(changelogEntries[0].version).toBe(toMajorMinor(manifest.version));
  });
});
