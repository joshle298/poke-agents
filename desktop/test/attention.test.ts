import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type AttentionOptions, AttentionTracker, type AttentionUpdate } from '../src/attention.js';
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

/** The notices an update carries. */
const sent = (update: AttentionUpdate) => update.notices;

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
    assert.deepEqual(sent(tracker.handle(askInput(1))), [
      {
        id: '1:input',
        agentId: 1,
        kind: 'input',
        title: 'Pikachu needs your answer',
        body: 'Fix the login flow',
      },
    ]);
  });

  it('notifies a permission request, and a fainted session with its error', () => {
    const { tracker, adopt } = setup();
    adopt(1, 'Deploy', 133);
    adopt(2, 'Migrate', 150);
    assert.equal(
      sent(tracker.handle({ type: 'agentToolPermission', id: 1 }))[0]?.title,
      'Eevee needs your permission',
    );
    const [fainted] = sent(
      tracker.handle({
        type: 'agentStatus',
        id: 2,
        status: 'error',
        errorMessage: 'Rate   limited\nby the model provider',
      }),
    );
    assert.equal(fainted?.title, 'Mewtwo fainted!');
    assert.equal(fainted?.body, 'Migrate\nRate limited by the model provider');
  });

  it('leads with the session name when the Pokémon theme is off or the species unknown', () => {
    const { tracker, adopt } = setup();
    adopt(1, 'Fix the login flow', 25);
    tracker.handle({ type: 'pokemonThemeUpdated', enabled: false });
    assert.deepEqual(sent(tracker.handle(askInput(1)))[0], {
      id: '1:input',
      agentId: 1,
      kind: 'input',
      title: 'Fix the login flow needs your answer',
      body: '',
    });
    adopt(2, 'Refactor', 99_999);
    tracker.handle({ type: 'pokemonThemeUpdated', enabled: true });
    assert.equal(
      sent(tracker.handle({ type: 'agentStatus', id: 2, status: 'error' }))[0]?.title,
      'Refactor hit an error',
    );
  });

  it('stays quiet for silent seeds and resends', () => {
    const { tracker, adopt } = setup();
    adopt(1);
    assert.deepEqual(sent(tracker.handle(askInput(1, { silent: true }))), []);
    assert.deepEqual(
      sent(tracker.handle({ type: 'agentStatus', id: 1, status: 'error', silent: true })),
      [],
    );
  });

  it('treats a session’s state in its first seconds in the office as where it already was', () => {
    const { tracker, advance } = setup();
    // Adoption replays a waiting session's state right after agentCreated.
    tracker.handle({ type: 'agentCreated', id: 1, label: 'Old question', species: 25 });
    assert.deepEqual(sent(tracker.handle(askInput(1))), []);
    assert.deepEqual(sent(tracker.handle({ type: 'agentToolPermission', id: 1 })), []);
    assert.equal(tracker.needsYouCount(), 1, 'still counted for the badge');
    // A message about a session the office announced before this feed
    // connected starts its grace too.
    tracker.handle({ type: 'existingAgents', agents: [2] });
    assert.deepEqual(sent(tracker.handle(askInput(2))), []);
    advance(GRACE);
    tracker.handle({ type: 'agentStatus', id: 1, status: 'active' });
    assert.equal(sent(tracker.handle(askInput(1))).length, 1, 'a later change is news');
  });

  it('stays quiet during quiet() (a reconnect replay)', () => {
    const { tracker, adopt, advance } = setup();
    adopt(1);
    tracker.quiet(8_000);
    assert.deepEqual(sent(tracker.handle(askInput(1))), []);
    advance(8_000);
    tracker.handle({ type: 'agentStatus', id: 1, status: 'active' });
    assert.equal(sent(tracker.handle(askInput(1))).length, 1);
  });

  it('notifies a session flapping in and out of waiting once per dedupe window', () => {
    const { tracker, adopt, advance } = setup();
    adopt(1);
    assert.equal(sent(tracker.handle(askInput(1))).length, 1);
    for (let i = 0; i < 5; i++) {
      advance(10_000);
      tracker.handle({ type: 'agentStatus', id: 1, status: 'active' });
      assert.deepEqual(sent(tracker.handle(askInput(1))), []);
    }
    advance(DEDUPE);
    tracker.handle({ type: 'agentStatus', id: 1, status: 'active' });
    assert.equal(sent(tracker.handle(askInput(1))).length, 1);
  });

  it('only notifies a change into the state, not a repeat of it', () => {
    const { tracker, adopt } = setup({ dedupeMs: 0 });
    adopt(1);
    assert.equal(sent(tracker.handle(askInput(1))).length, 1);
    assert.deepEqual(sent(tracker.handle(askInput(1))), []);
    assert.equal(sent(tracker.handle({ type: 'agentToolPermission', id: 1 })).length, 1);
    assert.deepEqual(sent(tracker.handle({ type: 'agentToolPermission', id: 1 })), []);
  });

  it('caps notifications across sessions to the rate limit, then lets them through again', () => {
    const { tracker, adopt, advance } = setup();
    for (let id = 1; id <= 5; id++) adopt(id);
    const shown = [1, 2, 3, 4, 5].flatMap((id) => sent(tracker.handle(askInput(id))));
    assert.deepEqual(
      shown.map((n) => n.agentId),
      [1, 2, 3],
    );
    assert.equal(tracker.needsYouCount(), 5, 'the badge still counts every one');
    advance(RATE_WINDOW);
    adopt(6);
    assert.equal(sent(tracker.handle(askInput(6))).length, 1);
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
      assert.deepEqual(tracker.handle(junk), { notices: [], withdrawn: [] });
    }
    assert.equal(tracker.needsYouCount(), 0);
  });
});

describe('AttentionTracker withdrawals', () => {
  it('withdraws a notice when its reason clears, and only one that was given out', () => {
    const { tracker, adopt } = setup({ rateMax: 10 });
    for (let id = 1; id <= 4; id++) adopt(id);
    tracker.handle(askInput(1));
    tracker.handle({ type: 'agentToolPermission', id: 2 });
    tracker.handle({ type: 'agentStatus', id: 3, status: 'error' });
    tracker.handle(askInput(4));

    assert.deepEqual(tracker.handle({ type: 'agentStatus', id: 1, status: 'active' }).withdrawn, [
      '1:input',
    ]);
    assert.deepEqual(tracker.handle({ type: 'agentToolPermissionClear', id: 2 }).withdrawn, [
      '2:permission',
    ]);
    // A revived session (its next turn starts) takes its "fainted" down.
    assert.deepEqual(tracker.handle({ type: 'agentStatus', id: 3, status: 'active' }).withdrawn, [
      '3:fainted',
    ]);
    assert.deepEqual(tracker.handle({ type: 'agentClosed', id: 4 }).withdrawn, ['4:input']);
    // Nothing left to take down.
    assert.deepEqual(
      tracker.handle({ type: 'agentStatus', id: 1, status: 'active' }).withdrawn,
      [],
    );
  });

  it('keeps the notice up through a silent replay of the plain waiting status', () => {
    const { tracker, adopt } = setup();
    adopt(1);
    tracker.handle(askInput(1));
    const replay = tracker.handle({ type: 'agentStatus', id: 1, status: 'waiting', silent: true });
    assert.deepEqual(replay.withdrawn, []);
    // A live "waiting" without the flag means the question was answered.
    const answered = tracker.handle({ type: 'agentStatus', id: 1, status: 'waiting' });
    assert.deepEqual(answered.withdrawn, ['1:input']);
  });

  it('gives a repeat the same id, so it replaces the earlier notification', () => {
    const { tracker, adopt, advance } = setup();
    adopt(1);
    const first = sent(tracker.handle(askInput(1)))[0];
    tracker.handle({ type: 'agentStatus', id: 1, status: 'active' });
    advance(DEDUPE);
    const again = sent(tracker.handle(askInput(1)))[0];
    assert.equal(again?.id, first?.id);
  });

  it('forgets what it gave out on reset() (the caller takes everything down)', () => {
    const { tracker, adopt } = setup();
    adopt(1);
    tracker.handle(askInput(1));
    tracker.reset();
    assert.deepEqual(tracker.handle({ type: 'agentClosed', id: 1 }).withdrawn, []);
  });
});

describe('AttentionTracker rate-limit summary', () => {
  /** Five sessions ask at once: three notify, two are held. */
  function burst() {
    const env = setup();
    const species = [25, 133, 150, 4, 7]; // Pikachu, Eevee, Mewtwo, Charmander, Squirtle
    species.forEach((dex, i) => env.adopt(i + 1, `Worker ${i + 1}`, dex));
    const shown = [1, 2, 3, 4, 5].flatMap((id) => sent(env.tracker.handle(askInput(id))));
    assert.equal(shown.length, 3);
    return env;
  }

  it('holds what the limit refuses and sends it as one summary when the window has room', () => {
    const { tracker, advance } = burst();
    const ready = tracker.nextFlushAt();
    assert.ok(ready !== null);
    assert.deepEqual(sent(tracker.flush()), [], 'nothing until the window has room');
    advance(RATE_WINDOW);
    assert.ok((tracker.nextFlushAt() ?? Infinity) <= 1_000_000 + 5 * GRACE + RATE_WINDOW);
    assert.deepEqual(sent(tracker.flush()), [
      {
        id: 'summary',
        kind: 'summary',
        title: '2 more sessions need you',
        body: 'Charmander, Squirtle',
      },
    ]);
    assert.equal(tracker.nextFlushAt(), null, 'nothing held any more');
    assert.deepEqual(sent(tracker.flush()), []);
  });

  it('sends a single held notice as itself, and drops held ones that cleared', () => {
    const { tracker, advance } = burst();
    tracker.handle({ type: 'agentStatus', id: 4, status: 'active' }); // Charmander went on
    advance(RATE_WINDOW);
    const [notice] = sent(tracker.flush());
    assert.equal(notice?.id, '5:input');
    assert.equal(notice?.title, 'Squirtle needs your answer');
  });

  it('withdraws the summary once every session in it has moved on', () => {
    const { tracker, advance } = burst();
    advance(RATE_WINDOW);
    tracker.flush();
    assert.deepEqual(
      tracker.handle({ type: 'agentStatus', id: 4, status: 'active' }).withdrawn,
      [],
    );
    assert.deepEqual(tracker.handle({ type: 'agentClosed', id: 5 }).withdrawn, ['summary']);
  });

  it('names at most three sessions in a summary', () => {
    const { tracker, adopt, advance } = setup({ rateMax: 1 });
    for (let id = 1; id <= 6; id++) adopt(id, `Worker ${id}`, 25);
    for (let id = 1; id <= 6; id++) tracker.handle(askInput(id));
    advance(RATE_WINDOW);
    const [summary] = sent(tracker.flush());
    assert.equal(summary?.title, '5 more sessions need you');
    assert.equal(summary?.body, 'Pikachu, Pikachu, Pikachu and 2 more');
  });
});
