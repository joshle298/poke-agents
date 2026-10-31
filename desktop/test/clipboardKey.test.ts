import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  clipboardKey,
  ClipboardKeyGate,
  type ClipboardKeyRequest,
  clipboardKeySuggestion,
  isApiKeysPage,
} from '../src/clipboardKey.js';
import { CLIPBOARD_SUGGESTION_WINDOW_MS } from '../src/constants.js';

/** Shaped like a Conductor key (short lowercase prefix, `_`, 43 characters). */
const KEY = `pakey_${'Fake0'.repeat(8)}abc`;
/** Other services' tokens that Paste would take but the suggestion must not offer. */
const OTHER_TOKENS = [
  `ghp_${'a'.repeat(36)}`,
  `github_pat_11${'A'.repeat(20)}_${'b'.repeat(59)}`,
  `sk-proj-${'c'.repeat(48)}`,
  `sk-ant-api03-${'d'.repeat(40)}`,
  `xoxb-${'1'.repeat(12)}-${'2'.repeat(12)}-${'e'.repeat(24)}`,
  `sk_live_${'f'.repeat(24)}`,
  `sk_live_${'g'.repeat(99)}`,
];

describe('clipboardKey (Paste)', () => {
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

describe('clipboardKeySuggestion', () => {
  it('offers only text shaped like a Conductor key', () => {
    assert.equal(clipboardKeySuggestion(` ${KEY}\n`), KEY);
    assert.equal(clipboardKeySuggestion('x'.repeat(40)), null);
    for (const token of OTHER_TOKENS) assert.equal(clipboardKeySuggestion(token), null, token);
  });
});

describe('isApiKeysPage', () => {
  it('recognizes Conductor’s API keys page only', () => {
    assert.equal(isApiKeysPage('https://app.conductor.build/home/api-keys'), true);
    assert.equal(isApiKeysPage('https://app.conductor.build/home/api-keys/'), true);
    assert.equal(isApiKeysPage('https://app.conductor.build/home'), false);
    assert.equal(isApiKeysPage('https://evil.example/home/api-keys'), false);
    assert.equal(isApiKeysPage('not a url'), false);
  });
});

describe('ClipboardKeyGate (main’s answer)', () => {
  const office = (purpose: unknown, focused = true): ClipboardKeyRequest => ({
    purpose,
    fromOffice: true,
    focused,
  });

  /** A clipboard that counts its reads. */
  function clipboard(text: string) {
    const reads = { count: 0 };
    return {
      reads,
      readText: async () => {
        reads.count++;
        return text;
      },
    };
  }

  it('answers Paste with key-shaped text for the focused office window', async () => {
    const gate = new ClipboardKeyGate();
    const board = clipboard(`${KEY}\n`);
    assert.equal(await gate.answer(office('paste'), board.readText), KEY);
    assert.equal(await gate.answer(office('paste'), clipboard('hello').readText), null);
  });

  it('never reads the clipboard for an unfocused window, another sender or another purpose', async () => {
    const gate = new ClipboardKeyGate();
    gate.arm();
    const board = clipboard(KEY);
    assert.equal(await gate.answer(office('paste', false), board.readText), null);
    assert.equal(
      await gate.answer({ purpose: 'paste', fromOffice: false, focused: true }, board.readText),
      null,
    );
    assert.equal(
      await gate.answer({ purpose: 'suggest', fromOffice: false, focused: true }, board.readText),
      null,
    );
    for (const purpose of [undefined, 'read', 42, { purpose: 'paste' }]) {
      assert.equal(await gate.answer(office(purpose), board.readText), null);
    }
    assert.equal(board.reads.count, 0);
  });

  it('suggests only after the API keys page opened, once', async () => {
    const gate = new ClipboardKeyGate();
    const board = clipboard(KEY);
    // Not armed: no read at all.
    assert.equal(await gate.answer(office('suggest'), board.readText), null);
    assert.equal(board.reads.count, 0);
    gate.arm();
    assert.equal(await gate.answer(office('suggest'), board.readText), KEY);
    assert.equal(await gate.answer(office('suggest'), board.readText), null);
    assert.equal(board.reads.count, 1);
  });

  it('spends the suggestion on an unfocused request, without reading', async () => {
    const gate = new ClipboardKeyGate();
    const board = clipboard(KEY);
    gate.arm();
    assert.equal(await gate.answer(office('suggest', false), board.readText), null);
    assert.equal(await gate.answer(office('suggest'), board.readText), null);
    assert.equal(board.reads.count, 0);
  });

  it('suggests only text shaped like a Conductor key', async () => {
    const gate = new ClipboardKeyGate();
    for (const token of OTHER_TOKENS) {
      gate.arm();
      assert.equal(await gate.answer(office('suggest'), clipboard(token).readText), null, token);
    }
  });

  it('forgets the opening after CLIPBOARD_SUGGESTION_WINDOW_MS', async () => {
    let now = 1_000;
    const gate = new ClipboardKeyGate(() => now);
    const board = clipboard(KEY);
    gate.arm();
    now += CLIPBOARD_SUGGESTION_WINDOW_MS;
    assert.equal(await gate.answer(office('suggest'), board.readText), null);
    assert.equal(board.reads.count, 0);
  });
});

describe('the clipboard bridge', () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, file), 'utf-8');

  it('sends Paste only during a user’s click, and both purposes through one channel', () => {
    const preload = read('../src/electron/preload.ts');
    assert.match(
      preload,
      /userIsActing\(\) \? keyOrNull\(await ipcRenderer\.invoke\(IPC_READ_CLIPBOARD_KEY, 'paste'\)\) : null/,
    );
    assert.match(preload, /ipcRenderer\.invoke\(IPC_READ_CLIPBOARD_KEY, 'suggest'\)/);
  });

  it('routes every clipboard read in main through the gate, armed by the API keys page', () => {
    const main = read('../src/electron/main.ts');
    // The only clipboard read in main is the one the gate decides on.
    assert.equal(main.match(/clipboard\.read/g)?.length, 1);
    assert.match(main, /clipboardKeys\.answer\([\s\S]*?\(\) => clipboard\.readText\(\),\s*\)/);
    assert.match(main, /if \(isApiKeysPage\(target\)\) clipboardKeys\.arm\(\);/);
  });
});
