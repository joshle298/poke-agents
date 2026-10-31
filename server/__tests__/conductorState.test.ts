import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  STATE_LAZY_SAVE_MS,
  STATE_SAVE_DEBOUNCE_MS,
  STATE_SESSIONS_MAX,
} from '../src/providers/stream/conductor/constants.js';
import { repoShortName, repoSlug, sessionLabel } from '../src/providers/stream/conductor/naming.js';
import { SessionLogStore } from '../src/providers/stream/conductor/sessionLog.js';
import { ConductorStateStore, sanitizeScope } from '../src/providers/stream/conductor/state.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function statePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-state-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'conductor-state.json');
}

describe('conductor-state.json', () => {
  it('starts from the default scope and writes atomically with mode 0600', () => {
    const file = statePath();
    const store = new ConductorStateStore(file);
    expect(store.scope).toEqual({
      creator: 'me',
      activeWithinHours: 6,
      showIdle: true,
      maxSessions: 24,
    });
    store.patchSession('s1', { hidden: true, cursor: { lastId: 'item-9', lastIndex: 9 } });
    store.patchSession('s2', { firstSender: null, harness: 'codex', lastActivityAt: Date.now() });
    store.flush();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(saved).toEqual({
      version: 1,
      scope: { creator: 'me', activeWithinHours: 6, showIdle: true, maxSessions: 24 },
      sessions: {
        s1: {
          hidden: true,
          cursor: { lastId: 'item-9', lastIndex: 9 },
          seenAt: expect.any(Number),
        },
        s2: { firstSender: null, harness: 'codex', lastActivityAt: expect.any(Number) },
      },
    });
  });

  it('clears flags on false/undefined but keeps meaningful falsy values', () => {
    const store = new ConductorStateStore(statePath());
    store.patchSession('s', { hidden: true, pinned: true, firstSender: 'lead' });
    store.patchSession('s', { hidden: false, pinned: undefined, firstSender: null });
    expect(store.session('s')).toEqual({ firstSender: null, seenAt: expect.any(Number) });
  });

  it('keeps no agent ids or Pokémon: the runtime stream memory owns them', () => {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        scope: {},
        sessions: { s: { agentId: 7, pokemonLine: 'eevee', shiny: true, pinned: true } },
      }),
    );
    const store = new ConductorStateStore(file);
    expect(store.session('s')).toEqual({ pinned: true, seenAt: expect.any(Number) });
    store.flush();
    expect(fs.readFileSync(file, 'utf-8')).not.toMatch(/agentId|pokemonLine|shiny/);
  });

  it('writes user decisions within a second and poll bookkeeping lazily', () => {
    vi.useFakeTimers();
    try {
      const file = statePath();
      const store = new ConductorStateStore(file);
      const written = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '');

      // A busy feed moves the cursor every poll: no rewrite every second.
      for (let i = 1; i <= 20; i++) {
        store.patchSession('s', { cursor: { lastId: `item-${i}`, lastIndex: i } });
        vi.advanceTimersByTime(1_000);
      }
      expect(written()).toBe('');
      vi.advanceTimersByTime(STATE_LAZY_SAVE_MS);
      expect(written()).toContain('item-');

      // Hiding a session is the user's decision: it lands at once, and pulls
      // a pending lazy write forward with it.
      store.patchSession('s', { cursor: { lastId: 'item-99', lastIndex: 99 } });
      store.patchSession('t', { hidden: true });
      vi.advanceTimersByTime(STATE_SAVE_DEBOUNCE_MS);
      expect(JSON.parse(written()).sessions).toMatchObject({
        s: { cursor: { lastId: 'item-99' } },
        t: { hidden: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('prunes entries nothing touched for 30 days, even those without activity', () => {
    const file = statePath();
    let now = Date.parse('2026-03-01T00:00:00Z');
    const day = 24 * 3_600_000;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        scope: {},
        sessions: {
          old: { lastActivityAt: now - 40 * day },
          recent: { lastActivityAt: now - 2 * day },
          probedOnly: { firstSender: null },
          hiddenOld: { hidden: true, lastActivityAt: now - 400 * day },
        },
      }),
    );
    const store = new ConductorStateStore(file, undefined, () => now);
    store.flush();
    expect(store.sessionIds().sort()).toEqual(['hiddenOld', 'probedOnly', 'recent']);

    // An entry with no activity ages out 30 days after it was last seen.
    now += 31 * day;
    store.flush();
    expect(store.sessionIds()).toEqual(['hiddenOld']);
  });

  it('keeps at most a bounded number of entries, the least recent going first', () => {
    const now = Date.parse('2026-03-01T00:00:00Z');
    const store = new ConductorStateStore(statePath(), undefined, () => now);
    for (let i = 0; i < STATE_SESSIONS_MAX + 5; i++) {
      store.patchSession(`s${i}`, { lastActivityAt: now - (STATE_SESSIONS_MAX + 5 - i) * 1_000 });
    }
    store.patchSession('s0', { pinned: true });
    store.flush();
    const ids = store.sessionIds();
    expect(ids).toHaveLength(STATE_SESSIONS_MAX);
    expect(ids).toContain('s0');
    expect(ids).not.toContain('s1');
    expect(ids).toContain(`s${STATE_SESSIONS_MAX + 4}`);
  });

  it('ignores unreadable or foreign-version files and sanitizes what it loads', () => {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const errors: string[] = [];
    expect(new ConductorStateStore(file, (m) => errors.push(m)).sessionIds()).toEqual([]);
    expect(errors).toHaveLength(1);

    fs.writeFileSync(
      file,
      JSON.stringify({ version: 2, scope: { creator: 'all' }, sessions: { a: {} } }),
    );
    expect(new ConductorStateStore(file).scope.creator).toBe('me');

    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        scope: { creator: 'all', activeWithinHours: 99_999, showIdle: 'yes', maxSessions: 0 },
        sessions: {
          a: { agentId: -3, hidden: 'true', pinned: true, cursor: { lastId: 5 }, token: 'x' },
        },
      }),
    );
    const store = new ConductorStateStore(file);
    expect(store.scope).toEqual({
      creator: 'all',
      activeWithinHours: 720,
      showIdle: true,
      maxSessions: 1,
    });
    expect(store.session('a')).toEqual({ pinned: true, seenAt: expect.any(Number) });
  });

  it('sanitizes scopes from the wire against the current one', () => {
    expect(
      sanitizeScope(
        { creator: 'everyone', activeWithinHours: 2.4, maxSessions: 300 },
        {
          creator: 'all',
          activeWithinHours: 6,
          showIdle: false,
          maxSessions: 24,
        },
      ),
    ).toEqual({ creator: 'all', activeWithinHours: 2, showIdle: false, maxSessions: 200 });
  });
});

describe('Pokédex session log', () => {
  it('keeps the first prompt, dedupes replayed items, and orders by time', () => {
    const log = new SessionLogStore();
    log.setPrompt('s', 'First task');
    log.setPrompt('s', 'Something later');
    log.addAssistant('s', 'Second', 2_000, 'item-2');
    log.addUser('s', 'First', 1_000, 'item-1');
    log.addAssistant('s', 'Second', 2_000, 'item-2');
    expect(log.get('s')).toEqual({
      prompt: 'First task',
      entries: [
        { role: 'user', text: 'First', at: 1_000 },
        { role: 'assistant', text: 'Second', at: 2_000 },
      ],
    });
  });

  it('keeps only the last 5 tool labels and at most 40 entries, then reports truncation', () => {
    const log = new SessionLogStore();
    for (let i = 0; i < 8; i++) log.addTool('s', `Running: step ${i}`, i, `tool-${i}`);
    expect(log.get('s').entries.map((e) => e.text)).toEqual([
      'Running: step 3',
      'Running: step 4',
      'Running: step 5',
      'Running: step 6',
      'Running: step 7',
    ]);
    expect(log.get('s').truncated).toBeUndefined();
    for (let i = 0; i < 45; i++) log.addAssistant('s', `text ${i}`, 100 + i, `a-${i}`);
    const detail = log.get('s');
    expect(detail.entries).toHaveLength(40);
    expect(detail.entries.at(-1)?.text).toBe('text 44');
    expect(detail.truncated).toBe(true);
  });

  it('records peer messages with their session and updates a peer entry by key', () => {
    const log = new SessionLogStore();
    log.addPeer('orch', 'peerOut', 'child', '', 5, 'msg-1');
    log.addPeer('orch', 'peerOut', 'child', 'Review the change', 5, 'msg-1');
    const detail = log.get('orch', (id) => (id === 'child' ? 'Worker A' : undefined));
    expect(detail.entries).toEqual([
      {
        role: 'peerOut',
        text: 'Review the change',
        at: 5,
        peerSessionId: 'child',
        peerLabel: 'Worker A',
      },
    ]);
  });

  it('clips long texts', () => {
    const log = new SessionLogStore();
    log.setPrompt('s', 'p'.repeat(1_000));
    log.addAssistant('s', 'a'.repeat(1_000), 1);
    const detail = log.get('s');
    expect(detail.prompt).toHaveLength(600);
    expect(detail.entries[0].text).toHaveLength(400);
  });
});

describe('naming', () => {
  it('derives repo slug, short name and labels', () => {
    expect(repoSlug('https://github.com/example-org/example-repo')).toBe(
      'example-org/example-repo',
    );
    expect(repoSlug('https://github.com/example-org/example-repo.git')).toBe(
      'example-org/example-repo',
    );
    expect(repoSlug('git@github.com:example-org/tool.git')).toBe('example-org/tool');
    expect(repoSlug('https://gitlab.example.test/group/sub/proj.git')).toBe(
      'gitlab.example.test/group/sub/proj',
    );
    expect(repoShortName('https://github.com/example-org/example-repo')).toBe('example-repo');
    expect(repoShortName(undefined)).toBeUndefined();
    const hash = '#';
    expect(sessionLabel({ name: 'Orchestrator' }, { name: 'WS', number: 1 })).toBe('Orchestrator');
    expect(sessionLabel({ name: null }, { name: 'Orchestration', number: 101 })).toBe(
      `${hash}101 Orchestration`,
    );
    expect(sessionLabel({ name: '  ' }, undefined)).toBe('Conductor session');
  });
});
