import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { clipboardKey } from '../src/clipboardKey.js';

const KEY = `pa_${'fake'.repeat(11)}`;

describe('clipboardKey', () => {
  it('hands the office a key-shaped clipboard, trimmed', () => {
    assert.equal(clipboardKey(`  ${KEY}\n`), KEY);
    assert.equal(clipboardKey('x'.repeat(20)), 'x'.repeat(20));
  });

  it('keeps every other clipboard content from the page', () => {
    for (const other of [
      '',
      'hello world',
      'https://app.conductor.build/home/api-keys',
      `${KEY} ${KEY}`,
      'x'.repeat(201),
      'my secret password!',
    ]) {
      assert.equal(clipboardKey(other), null);
    }
  });
});

describe('the clipboard bridge', () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, file), 'utf-8');

  it('is exposed by the preload and declared by the office', () => {
    assert.match(read('../src/electron/preload.ts'), /readClipboardKey: async \(\)/);
    assert.match(
      read('../../webview-ui/src/desktopApp.ts'),
      /readClipboardKey\(\): Promise<string \| null>;/,
    );
  });

  it('reads the clipboard only for the focused office window, and answers key-shaped text', () => {
    const main = read('../src/electron/main.ts');
    // Electron's clipboard.readText() is async: the handler awaits it.
    assert.match(
      main,
      /isOfficeSender\(event\) && officeWindow\?\.isFocused\(\)\s*\? clipboardKey\(await clipboard\.readText\(\)\)\s*: null/,
    );
    // The only place main touches the clipboard.
    assert.equal(main.match(/clipboard\.read/g)?.length, 1);
  });
});
