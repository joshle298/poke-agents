/**
 * The in-app About copy states the product principle (a visualizer for
 * Conductor that never runs agents itself), credits Pixel Agents honestly,
 * and no webview source calls Poke Agents a fork any more (the repository
 * left the fork network).
 *
 * Run with: npm test
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|css|html)$/.test(entry.name) ? [full] : [];
  });
}

/** The modal's text with JSX line breaks and {' '} joins collapsed. */
function aboutText(): string {
  const source = fs.readFileSync(path.join(srcDir, 'components/CreditsModal.tsx'), 'utf8');
  return source
    .replace(/\{' '\}/g, ' ')
    .replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

describe('About copy', () => {
  it('says what Poke Agents is and is not', () => {
    const text = aboutText();
    expect(text).toContain('It is a visualizer for Conductor');
    expect(text).toContain('never runs agents, never edits your repositories');
    expect(text).toContain("only asks Conductor's API to do so");
    expect(text).toContain('--claude mode is the one exception');
  });

  it('credits Pixel Agents under the MIT license', () => {
    const text = aboutText();
    expect(text).toMatch(/inspired by and built on Pixel Agents by Pablo De Lucca/);
    expect(text).toContain('MIT license');
  });

  it('no webview source calls Poke Agents a fork', () => {
    const offenders = sourceFiles(srcDir).filter((file) =>
      /\bfork(ed)?\b/i.test(fs.readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(srcDir, f))).toEqual([]);
  });
});
