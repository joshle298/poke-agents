import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type AttentionOptions, AttentionTracker } from '../src/attention.js';
import { speciesName } from '../src/species.js';

const GRACE = 5_000;
const DEDUPE = 120_000;
const RATE_WINDOW = 30_000;

/** A tracker on a hand-driven clock. */
function setup(options: AttentionOptions = {}) {
  let now = 1_000_000;
  const tracker = new AttentionTracker({
    now: () => now,
    speciesName,
    adoptionGraceMs: GRACE,
    dedupeMs: DEDUPE,
    rateMax: 3,
    rateWindowMs: RATE_WINDOW,
    ...options,
  });
  return {
    tracker,
    advance: (ms: number) => {
      now += ms;
    },
    /** A session that walked in long enough ago to be news when it changes. */
    adopt(id: number, label = `Session ${id}`, species = 25) {
      tracker.handle({ type: 'agentCreated', id, label, species, providerId: 'conductor' });
      now += GRACE;
    },
  };
}

const askInput = (id: number, extra: Record<string, unknown> = {}) => ({
  type: 'agentStatus',
  id,
  status: 'waiting',
  awaitingInput: true,
  ...extra,
});

describe('AttentionTracker notifications', () => {
  it('names the Pokémon and the session when a session starts waiting for an answer', () => {
    const { tracker, adopt } = setup();
    adopt(1, 'Fix the login flow', 25);
    assert.deepEqual(tracker.handle(askInput(1)), [
      { agentId: 1, kind: 'input', title: 'Pikachu needs your answer', body: 'Fix the login flow' },
    ]);
  });

  it('notifies a permission request, and a fainted session with its error', () => {
    const { tracker, adopt } = setup();
    adopt(1, 'Deploy', 133);
    adopt(2, 'Migrate', 150);
    assert.equal(
      tracker.handle({ type: 'agentToolPermission', id: 1 })[0]?.title,
      'Eevee needs your permission',
    );
    const [fainted] = tracker.handle({
      type: 'agentStatus',
      id: 2,
      status: 'error',
      errorMessage: 'Rate   limited\nby the model provider',
    });
    assert.equal(fainted?.title, 'Mewtwo fainted!');
    assert.equal(fainted?.body, 'Migrate\nRate limited by the model provider');
  });

  it('leads with the session name when the Pokémon theme is off or the species unknown', () => {
    const { tracker, adopt } = setup();
    adopt(1, 'Fix the login flow', 25);
    tracker.handle({ type: 'pokemonThemeUpdated', enabled: false });
    assert.deepEqual(tracker.handle(askInput(1))[0], {
      agentId: 1,
      kind: 'input',
      title: 'Fix the login flow needs your answer',
      body: '',
    });
    adopt(2, 'Refactor', 99_999);
    tracker.handle({ type: 'pokemonThemeUpdated', enabled: true });
    assert.equal(
      tracker.handle({ type: 'agentStatus', id: 2, status: 'error' })[0]?.title,
      'Refactor hit an error',
    );
  });

  it('stays quiet for silent seeds and resends', () => {
    const { tracker, adopt } = setup();
    adopt(1);
    assert.deepEqual(tracker.handle(askInput(1, { silent: true })), []);
    assert.deepEqual(
      tracker.handle({ type: 'agentStatus', id: 1, status: 'error', silent: true }),
      [],
    );
  });

  it('treats a session’s state in its first seconds in the office as where it already was', () => {
    const { tracker, advance } = setup();
    // Adoption replays a waiting session's state right after agentCreated.
    tracker.handle({ type: 'agentCreated', id: 1, label: 'Old question', species: 25 });
    assert.deepEqual(tracker.handle(askInput(1)), []);
    assert.deepEqual(tracker.handle({ type: 'agentToolPermission', id: 1 }), []);
    assert.equal(tracker.needsYouCount(), 1, 'still counted for the badge');
    // A message about a session the office announced before this feed
    // connected starts its grace too.
    tracker.handle({ type: 'existingAgents', agents: [2] });
    assert.deepEqual(tracker.handle(askInput(2)), []);
    advance(GRACE);
    tracker.handle({ type: 'agentStatus', id: 1, status: 'active' });
    assert.equal(tracker.handle(askInput(1)).length, 1, 'a later change is news');
  });

  it('stays quiet during quiet() (a reconnect replay)', () => {
    const { tracker, adopt, advance } = setup();
    adopt(1);
    tracker.quiet(8_000);
    assert.deepEqual(tracker.handle(askInput(1)), []);
    advance(8_000);
    tracker.handle({ type: 'agentStatus', id: 1, status: 'active' });
    assert.equal(tracker.handle(askInput(1)).length, 1);
  });

  it('notifies a session flapping in and out of waiting once per dedupe window', () => {
    const { tracker, adopt, advance } = setup();
    adopt(1);
    assert.equal(tracker.handle(askInput(1)).length, 1);
    for (let i = 0; i < 5; i++) {
      advance(10_000);
      tracker.handle({ type: 'agentStatus', id: 1, status: 'active' });
      assert.deepEqual(tracker.handle(askInput(1)), []);
    }
    advance(DEDUPE);
    tracker.handle({ type: 'agentStatus', id: 1, status: 'active' });
    assert.equal(tracker.handle(askInput(1)).length, 1);
  });

  it('only notifies a change into the state, not a repeat of it', () => {
    const { tracker, adopt } = setup({ dedupeMs: 0 });
    adopt(1);
    assert.equal(tracker.handle(askInput(1)).length, 1);
    assert.deepEqual(tracker.handle(askInput(1)), []);
    assert.equal(tracker.handle({ type: 'agentToolPermission', id: 1 }).length, 1);
    assert.deepEqual(tracker.handle({ type: 'agentToolPermission', id: 1 }), []);
  });

  it('caps notifications across sessions to the rate limit, then lets them through again', () => {
    const { tracker, adopt, advance } = setup();
    for (let id = 1; id <= 5; id++) adopt(id);
    const shown = [1, 2, 3, 4, 5].flatMap((id) => tracker.handle(askInput(id)));
    assert.deepEqual(
      shown.map((n) => n.agentId),
      [1, 2, 3],
    );
    assert.equal(tracker.needsYouCount(), 5, 'the badge still counts every one');
    advance(RATE_WINDOW);
    adopt(6);
    assert.equal(tracker.handle(askInput(6)).length, 1);
  });
});

describe('AttentionTracker badge count', () => {
  it('counts sessions waiting for an answer or a permission, each once', () => {
    const { tracker, adopt } = setup();
    for (let id = 1; id <= 4; id++) adopt(id);
    tracker.handle(askInput(1));
    tracker.handle({ type: 'agentToolPermission', id: 2 });
    tracker.handle(askInput(3));
    tracker.handle({ type: 'agentToolPermission', id: 3 });
    tracker.handle({ type: 'agentStatus', id: 4, status: 'error' });
    assert.equal(tracker.needsYouCount(), 3, 'a fainted session is not waiting on you');
  });

  it('drops a session when it answers, gets the permission, finishes or leaves', () => {
    const { tracker, adopt } = setup();
    for (let id = 1; id <= 4; id++) adopt(id);
    for (let id = 1; id <= 3; id++) tracker.handle(askInput(id));
    tracker.handle({ type: 'agentToolPermission', id: 4 });
    assert.equal(tracker.needsYouCount(), 4);
    tracker.handle({ type: 'agentStatus', id: 1, status: 'active' });
    tracker.handle({ type: 'agentStatus', id: 2, status: 'waiting', awaitingInput: false });
    tracker.handle({ type: 'agentClosed', id: 3 });
    tracker.handle({ type: 'agentToolsClear', id: 4 });
    assert.equal(tracker.needsYouCount(), 0);
  });

  it('keeps a waiting session counted through a replay of its plain waiting status', () => {
    const { tracker, adopt } = setup();
    adopt(1);
    tracker.handle(askInput(1));
    // resendAgentActivity replays "waiting" without the awaitingInput flag.
    tracker.handle({ type: 'agentStatus', id: 1, status: 'waiting', silent: true });
    assert.equal(tracker.needsYouCount(), 1);
  });

  it('forgets everything on reset()', () => {
    const { tracker, adopt } = setup();
    adopt(1);
    tracker.handle(askInput(1));
    tracker.reset();
    assert.equal(tracker.needsYouCount(), 0);
  });

  it('ignores malformed messages', () => {
    const { tracker } = setup();
    for (const junk of [null, 'agentStatus', [], { type: 3 }, { type: 'agentStatus', id: 'x' }]) {
      assert.deepEqual(tracker.handle(junk), []);
    }
    assert.equal(tracker.needsYouCount(), 0);
  });
});
