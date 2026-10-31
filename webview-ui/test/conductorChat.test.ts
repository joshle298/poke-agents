/**
 * The Pokédex chat view's pure rules: plain-text rendering of Conductor
 * messages, merging history pages with the live detail, tool grouping, the
 * reply box's send key and send state, sticky scroll, and the poll that
 * pauses while the page is hidden. Synthetic text only.
 *
 * Run with: npm test
 */

import { describe, expect, it } from 'vitest';

import type { SessionDetailEntry } from '../../core/src/messages.js';
import {
  buildThread,
  entryKey,
  isNearBottom,
  isSendKey,
  mergeEntries,
  questionTitle,
  scrollTopAfterPrepend,
  sendState,
  toolGroupSummary,
  toolLabel,
} from '../src/conductor/chat.js';
import { plainText } from '../src/conductor/chatText.js';
import { startVisibleInterval } from '../src/conductor/visibleInterval.js';

const entry = (patch: Partial<SessionDetailEntry> & { at: number }): SessionDetailEntry => ({
  role: 'assistant',
  text: `text ${patch.at}`,
  ...patch,
});

describe('plainText', () => {
  it('shows an attachment mention as its link text', () => {
    expect(
      plainText('@[Transcript of Planning.md](.context%2Fattachments%2Fplanning-notes.md) please'),
    ).toBe('Transcript of Planning.md please');
  });

  it('reads any markdown link or image as its text, the target when the text is empty', () => {
    expect(plainText('See [the guide](https://example.com/guide) first.')).toBe(
      'See the guide first.',
    );
    expect(plainText('![diagram](img/flow.png)')).toBe('diagram');
    expect(plainText('[](docs%2Fnotes%20one.md)')).toBe('docs/notes one.md');
    expect(plainText('[My%20file.md](x)')).toBe('My file.md');
    expect(plainText('Open <https://example.com/a>')).toBe('Open https://example.com/a');
  });

  it('leaves everything else alone, malformed escapes and markup included', () => {
    expect(plainText('100% done, [not a link] (really)')).toBe('100% done, [not a link] (really)');
    expect(plainText('[bad %zz](x)')).toBe('bad %zz');
    // Markup stays literal text: React renders it as a text node.
    expect(plainText('<b>bold</b> <img src=x onerror=alert(1)>')).toBe(
      '<b>bold</b> <img src=x onerror=alert(1)>',
    );
    expect(plainText('')).toBe('');
  });
});

describe('mergeEntries', () => {
  it('merges history pages and the live detail by key, oldest first', () => {
    const older = [entry({ at: 1, key: 'a' }), entry({ at: 2, key: 'b' })];
    const newest = [entry({ at: 2, key: 'b' }), entry({ at: 3, key: 'c' })];
    const live = [entry({ at: 3, key: 'c', text: 'edited' }), entry({ at: 4, key: 'd' })];
    const merged = mergeEntries(older, newest, live);
    expect(merged.map((e) => e.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(merged[2].text).toBe('edited');
  });

  it('falls back to role, time and text for entries without a key', () => {
    const a = entry({ at: 5, role: 'user', text: 'hi' });
    expect(entryKey(a)).toBe('user|5|hi');
    expect(mergeEntries([a], [{ ...a }], undefined)).toHaveLength(1);
  });

  it('keeps the given order for entries at the same time', () => {
    const merged = mergeEntries([
      entry({ at: 9, key: 'x', role: 'user' }),
      entry({ at: 9, key: 'y', role: 'tool' }),
      entry({ at: 8, key: 'w' }),
    ]);
    expect(merged.map((e) => e.key)).toEqual(['w', 'x', 'y']);
  });
});

describe('buildThread', () => {
  it("groups each turn's tool lines between messages", () => {
    const items = buildThread([
      entry({ at: 1, role: 'user', key: 'u1' }),
      entry({ at: 2, role: 'tool', toolName: 'Read', key: 't1' }),
      entry({ at: 3, role: 'tool', toolName: 'Bash', key: 't2' }),
      entry({ at: 4, role: 'assistant', key: 'a1' }),
      entry({ at: 5, role: 'tool', toolName: 'Edit', key: 't3' }),
      entry({ at: 6, role: 'peerOut', key: 'p1', peerId: 3 }),
    ]);
    expect(items.map((i) => (i.kind === 'tools' ? i.entries.length : i.entry.role))).toEqual([
      'user',
      2,
      'assistant',
      1,
      'peerOut',
    ]);
    expect(items[1].key).toBe('t1');
  });

  it('names tools, and sums a group up', () => {
    expect(toolLabel(entry({ at: 1, role: 'tool', toolName: 'Bash' }))).toBe('Bash');
    expect(toolLabel(entry({ at: 1, role: 'tool' }))).toBe('Tool');
    const tools = ['Bash', 'Read', 'Bash', 'Edit', 'Grep'].map((toolName, i) =>
      entry({ at: i, role: 'tool', toolName }),
    );
    expect(toolGroupSummary(tools)).toBe('5 tools · Bash, Read, Edit +1');
    expect(toolGroupSummary(tools.slice(0, 1))).toBe('1 tool · Bash');
  });
});

describe('questionTitle', () => {
  it('heads a plan as a plan and every other question as a question', () => {
    expect(questionTitle('askUser')).toBe('Question');
    expect(questionTitle('notice')).toBe('Question');
    expect(questionTitle('plan')).toBe('Plan to approve');
  });
});

describe('the reply box', () => {
  it('sends on Enter, keeps Shift+Enter as a newline, and lets an IME confirm', () => {
    expect(isSendKey({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(isSendKey({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(isSendKey({ key: 'a', shiftKey: false })).toBe(false);
    // The Enter that accepts a kanji conversion (Chromium: isComposing, 229).
    expect(isSendKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(isSendKey({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false);
  });

  it('tracks a send through its conductorActionResult', () => {
    const timeout = 15_000;
    const sentAt = 1_000;
    expect(sendState(null, undefined, 2_000, timeout)).toBe('idle');
    expect(sendState(sentAt, undefined, 2_000, timeout)).toBe('sending');
    // An older outcome, or another action's, doesn't answer this send.
    const old = { action: 'sendSessionMessage' as const, ok: true, at: 500 };
    expect(sendState(sentAt, old, 2_000, timeout)).toBe('sending');
    const stop = { action: 'stopSession' as const, ok: true, at: 1_500 };
    expect(sendState(sentAt, stop, 2_000, timeout)).toBe('sending');
    const ok = { action: 'sendSessionMessage' as const, ok: true, at: 1_200 };
    expect(sendState(sentAt, ok, 2_000, timeout)).toBe('sent');
    const refused = { ...ok, ok: false, message: 'Session not found' };
    expect(sendState(sentAt, refused, 2_000, timeout)).toBe('failed');
    expect(sendState(sentAt, undefined, sentAt + timeout, timeout)).toBe('unconfirmed');
  });
});

describe('sticky scroll', () => {
  it('sticks while the newest line is in view', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }, 24)).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 580, clientHeight: 400 }, 24)).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 }, 24)).toBe(false);
  });

  it('keeps the lines being read in place when older ones load above', () => {
    expect(scrollTopAfterPrepend({ scrollHeight: 1000, scrollTop: 0 }, 1600)).toBe(600);
    expect(scrollTopAfterPrepend({ scrollHeight: 1000, scrollTop: 120 }, 1300)).toBe(420);
  });
});

describe('startVisibleInterval', () => {
  function harness(hidden = false) {
    const env = {
      hidden,
      listeners: new Set<() => void>(),
      timers: new Map<number, () => void>(),
      nextId: 1,
    };
    const visibility = {
      isHidden: () => env.hidden,
      onChange: (listener: () => void) => {
        env.listeners.add(listener);
        return () => env.listeners.delete(listener);
      },
    };
    const timers = {
      setInterval: (run: () => void) => {
        const id = env.nextId++;
        env.timers.set(id, run);
        return id;
      },
      clearInterval: (id: unknown) => {
        env.timers.delete(id as number);
      },
    };
    const setHidden = (value: boolean) => {
      env.hidden = value;
      env.listeners.forEach((l) => l());
    };
    const tick = () => env.timers.forEach((run) => run());
    return { env, visibility, timers, setHidden, tick };
  }

  it('polls now and on every tick while visible', () => {
    const h = harness();
    let runs = 0;
    startVisibleInterval(() => runs++, 5_000, h.visibility, h.timers);
    expect(runs).toBe(1);
    h.tick();
    h.tick();
    expect(runs).toBe(3);
  });

  it('stops while hidden and refreshes at once when shown again', () => {
    const h = harness();
    let runs = 0;
    startVisibleInterval(() => runs++, 5_000, h.visibility, h.timers);
    h.setHidden(true);
    h.tick();
    expect(runs).toBe(1);
    expect(h.env.timers.size).toBe(0);
    h.setHidden(false);
    expect(runs).toBe(2);
    expect(h.env.timers.size).toBe(1);
  });

  it('opened in a hidden page, it waits; stopping it ends everything', () => {
    const h = harness(true);
    let runs = 0;
    const stop = startVisibleInterval(() => runs++, 5_000, h.visibility, h.timers);
    expect(runs).toBe(0);
    h.setHidden(false);
    expect(runs).toBe(1);
    stop();
    expect(h.env.timers.size).toBe(0);
    expect(h.env.listeners.size).toBe(0);
    h.setHidden(false);
    expect(runs).toBe(1);
  });
});
