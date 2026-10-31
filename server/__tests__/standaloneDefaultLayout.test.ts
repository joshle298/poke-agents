import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadDefaultLayout, loadStandaloneDefaultLayout } from '../src/assetLoader.js';
import { TOWN_LAYOUT_FILE } from '../src/constants.js';

const REPO_ASSETS_ROOT = path.resolve(__dirname, '../../webview-ui/public');

let root: string;

function writeAsset(rel: string, content: string): void {
  const file = path.join(root, 'assets', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const layout = (marker: string) =>
  JSON.stringify({ version: 1, cols: 1, rows: 1, tiles: [1], furniture: [], marker });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-default-layout-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('loadStandaloneDefaultLayout', () => {
  it('prefers the bundled Pokémon Town over the classic default', () => {
    writeAsset('default-layout-1.json', layout('classic'));
    writeAsset(TOWN_LAYOUT_FILE, layout('town'));
    expect(loadStandaloneDefaultLayout(root)?.marker).toBe('town');
  });

  it('falls back to the classic default when the town is missing', () => {
    writeAsset('default-layout-1.json', layout('classic'));
    expect(loadStandaloneDefaultLayout(root)?.marker).toBe('classic');
  });

  it('falls back to the classic default when the town is not a layout', () => {
    writeAsset('default-layout-1.json', layout('classic'));
    writeAsset(TOWN_LAYOUT_FILE, '{ "version": 1, "tiles": "nope" }');
    expect(loadStandaloneDefaultLayout(root)?.marker).toBe('classic');
    writeAsset(TOWN_LAYOUT_FILE, '{ not json');
    expect(loadStandaloneDefaultLayout(root)?.marker).toBe('classic');
  });

  it('ships a town whose revision never resets a saved layout and never yields to the classic one', () => {
    // VS Code shares ~/.pixel-agents/layout.json and resets it when the bundled
    // classic default carries a NEWER revision: the town must match it.
    const town = loadStandaloneDefaultLayout(REPO_ASSETS_ROOT);
    const classic = loadDefaultLayout(REPO_ASSETS_ROOT);
    expect(town?.cols).toBeGreaterThan(30);
    expect(town?.layoutRevision).toBe(classic?.layoutRevision);
  });
});
