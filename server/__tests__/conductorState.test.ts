import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

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
    store.patchSession('s1', {
      agentId: 7,
      hidden: true,
      cursor: { lastId: 'item-9', lastIndex: 9 },
    });
    store.patchSession('s2', {
      agentId: 12,
      firstSender: null,
      shiny: false,
      pokemonLine: 'eevee',
    });
    store.flush();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(saved).toEqual({
      version: 1,
      scope: { creator: 'me', activeWithinHours: 6, showIdle: true, maxSessions: 24 },
      sessions: {
        s1: { agentId: 7, hidden: true, cursor: { lastId: 'item-9', lastIndex: 9 } },
        s2: { agentId: 12, firstSender: null, shiny: false, pokemonLine: 'eevee' },
      },
    });
    expect(new ConductorStateStore(file).maxAgentId()).toBe(12);
  });

  it('clears flags on false/undefined but keeps meaningful falsy values', () => {
    const store = new ConductorStateStore(statePath());
    store.patchSession('s', { hidden: true, pinned: true, shiny: true });
    store.patchSession('s', { hidden: false, pinned: undefined, shiny: false });
    expect(store.session('s')).toEqual({ shiny: false });
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
    expect(store.session('a')).toEqual({ pinned: true });
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
