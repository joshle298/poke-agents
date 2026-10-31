/**
 * Asleep has one source of truth (office/asleep.ts): the office's sleeping
 * Pokémon and the party's SLP read the same facts through the same rule, so
 * they never disagree. Synthetic agents, no DOM.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterEach, beforeEach, test } from 'vitest';

import { ConductorStore } from '../src/conductor/conductorStore.js';
import {
  agentCondition,
  agentMsUntilAsleep,
  conditionBadge,
  nextAgentSleepAt,
} from '../src/conductor/party.js';
import { SLEEP_AFTER_MS, SLEEP_DROWSY_MS } from '../src/constants.js';
import { isAsleep, isDrowsy, msUntilAsleep } from '../src/office/asleep.js';
import { CONDITION_BADGE, pokemonLabel } from '../src/office/components/pokemonOverlay.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { setPokemonThemeEnabled } from '../src/office/engine/pokemonTheme.js';
import { setPokemonSpecies } from '../src/office/sprites/pokemonSprites.js';
import {
  floorLayout,
  flushDecodes,
  installFakeLoader,
  resetPokemonStore,
  speciesMessage,
} from './pokemonFixtures.js';

beforeEach(() => {
  resetPokemonStore();
  setPokemonThemeEnabled(true);
});

afterEach(() => {
  resetPokemonStore();
  setPokemonThemeEnabled(true);
});

test('asleep = resting with no activity for SLEEP_AFTER_MS; drowsy just before', () => {
  const now = 10_000_000;
  const done = (ago: number) => msUntilAsleep(true, now - ago, now);
  assert.equal(isAsleep(done(SLEEP_AFTER_MS - 1)), false);
  assert.equal(isAsleep(done(SLEEP_AFTER_MS)), true);
  assert.equal(done(SLEEP_AFTER_MS - 1_000), 1_000);
  assert.equal(isDrowsy(done(SLEEP_AFTER_MS - SLEEP_DROWSY_MS)), true);
  assert.equal(isDrowsy(done(SLEEP_AFTER_MS - SLEEP_DROWSY_MS - 1)), false);
  assert.equal(isDrowsy(done(SLEEP_AFTER_MS)), false, 'asleep is no longer drowsy');
  // Working, fainted or needing you (not resting), or with no clock: never.
  assert.equal(msUntilAsleep(false, 1, now), null);
  assert.equal(msUntilAsleep(true, undefined, now), null);
  assert.equal(msUntilAsleep(true, 0, now), null);
  assert.equal(isAsleep(null), false);
  assert.equal(isDrowsy(null), false);
});

test('nextAgentSleepAt: the soonest fall asleep still to come, for all or one agent', () => {
  const now = 10_000_000;
  const store = new ConductorStore({ now: () => now });
  const quiet = (id: number, ago: number) => {
    store.apply({ type: 'agentCreated', id, providerId: 'conductor' });
    store.apply({ type: 'agentStatus', id, status: 'waiting', silent: true });
    store.apply({ type: 'agentDetails', id, lastActivityAt: now - ago });
  };
  quiet(1, 30_000);
  quiet(2, 100_000);
  quiet(3, SLEEP_AFTER_MS); // already asleep
  store.apply({ type: 'agentStatus', id: 4, status: 'active' });
  const state = store.getState();
  assert.equal(nextAgentSleepAt(state, now), now - 100_000 + SLEEP_AFTER_MS);
  assert.equal(nextAgentSleepAt(state, now, 1), now - 30_000 + SLEEP_AFTER_MS, 'just agent 1');
  assert.equal(nextAgentSleepAt(state, now, 3), null, 'asleep already');
  assert.equal(nextAgentSleepAt(state, now, 4), null, 'working');
  assert.equal(nextAgentSleepAt(state, now, 99), null, 'not in the office');
});

test('a Claude Code agent replayed after a reload falls asleep SLEEP_AFTER_MS after it is seen', async () => {
  // A reconnect resends a hook agent's status silently and hook agents carry
  // no provider activity time: the sleep clock starts when this client first
  // saw it, so it still falls asleep, in the party and in the office alike.
  const msg = speciesMessage(25);
  installFakeLoader([msg]);
  setPokemonSpecies(msg);
  await flushDecodes();
  let now = 70_000_000;
  const store = new ConductorStore({ now: () => now });
  const os = new OfficeState(floorLayout());
  os.wallClock = () => now;
  os.setSleepClock((id, at) => agentMsUntilAsleep(store.getState().agents[id], at));
  os.addAgent(1, 0, 0, undefined, true);
  os.setAgentIdentity(1, { species: 25 });
  store.apply({
    type: 'existingAgents',
    agents: [1],
    agentMeta: {},
    directoryNames: {},
    externalAgents: { '1': true },
  });
  store.apply({ type: 'agentStatus', id: 1, status: 'waiting', silent: true });
  os.setAgentActive(1, false);
  const asleep = () => {
    os.update(0.05);
    const party = agentCondition(store.getState().agents[1], now) === 'asleep';
    const office = pokemonLabel(os.characters.get(1)!).condition === 'asleep';
    assert.equal(party, office, 'one answer');
    return office;
  };
  assert.equal(asleep(), false);
  now += SLEEP_AFTER_MS - 1_000;
  assert.equal(asleep(), false);
  now += 1_000;
  assert.equal(asleep(), true);
  // A live turn later moves the clock as usual.
  store.apply({ type: 'agentStatus', id: 1, status: 'active' });
  os.setAgentActive(1, true);
  assert.equal(asleep(), false);
});

test('the office and the party agree at every moment of a session’s day', async () => {
  // One Conductor session through the messages the server sends: adopted
  // idle (long quiet), woken by a message, a turn with tools, done, quiet
  // again until it falls asleep, then a question. At each step the office's
  // Pokémon (OfficeState reading the store's facts, as App wires it) and the
  // party slot must say the same thing.
  const msg = speciesMessage(25);
  installFakeLoader([msg]);
  setPokemonSpecies(msg);
  await flushDecodes();
  let now = 50_000_000;
  const store = new ConductorStore({ now: () => now });
  const os = new OfficeState(floorLayout());
  os.wallClock = () => now;
  os.setSleepClock((id, at) => agentMsUntilAsleep(store.getState().agents[id], at));
  const id = 1;
  const lead = 2;
  os.addAgent(id, 0, 0, undefined, true);
  os.addAgent(lead, 0, 0, undefined, true);
  os.setAgentIdentity(id, { species: 25 });
  os.setAgentIdentity(lead, { species: 25 });
  const apply = (m: Parameters<ConductorStore['apply']>[0]) => store.apply(m);
  apply({ type: 'agentCreated', id, providerId: 'conductor', label: 'Update docs' });
  apply({ type: 'agentCreated', id: lead, providerId: 'conductor', label: 'Lead' });
  const check = (label: string, expected: boolean) => {
    os.update(0.05);
    const party = agentCondition(store.getState().agents[id], now);
    const office = pokemonLabel(os.characters.get(id)!).condition;
    assert.equal(party === 'asleep', expected, `${label}: party says ${party}`);
    assert.equal(office === 'asleep', expected, `${label}: office says ${office}`);
    assert.equal(
      conditionBadge(party) === 'SLP',
      office !== null && CONDITION_BADGE[office] === 'SLP',
      `${label}: one SLP`,
    );
  };

  // Adopted silently, its last activity 10 minutes ago: asleep at once.
  apply({ type: 'agentStatus', id, status: 'waiting', silent: true });
  apply({ type: 'agentDetails', id, lastActivityAt: now - 600_000 });
  os.setAgentActive(id, false);
  check('adopted quiet', true);

  // The Lead messages it: woken.
  apply({ type: 'agentMessage', fromId: lead, toId: id, kind: 'messaged', at: now });
  check('message received', false);
  now += SLEEP_AFTER_MS - 1_000;
  check('just before the threshold', false);
  now += 1_000;
  check('quiet since the message', true);

  // A turn with a tool, then done.
  apply({ type: 'agentStatus', id, status: 'active' });
  os.setAgentActive(id, true);
  check('turn started', false);
  apply({ type: 'agentToolStart', id, toolId: 't1', status: 'Editing docs.md' });
  now += 30_000;
  check('working', false);
  apply({ type: 'agentToolsClear', id });
  apply({ type: 'agentStatus', id, status: 'waiting' });
  os.setAgentActive(id, false);
  check('done', false);
  now += SLEEP_AFTER_MS / 2;
  check('done a minute', false);
  now += SLEEP_AFTER_MS / 2;
  check('done two minutes', true);

  // A question wakes it (needs you, not asleep), and so does its answer.
  apply({ type: 'agentStatus', id, status: 'waiting', awaitingInput: true });
  os.setAgentAwaitingInput(id, true);
  check('asks a question', false);
});
