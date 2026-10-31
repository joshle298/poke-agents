/**
 * The chime policy for agentStatus (DESIGN §D "Chimes and selection"): every
 * finished turn chimes for upstream agents; a stream agent only when it needs
 * an answer, for the selected agent, or when a pinned one errors; silent
 * resends never.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { StatusChimeInput } from '../src/office/chimePolicy.js';
import { statusChimeFor } from '../src/office/chimePolicy.js';

const base: StatusChimeInput = {
  status: 'waiting',
  awaitingInput: false,
  silent: false,
  streamAgent: true,
  selected: false,
  pinned: false,
  changed: true,
};
const chime = (over: Partial<StatusChimeInput>) => statusChimeFor({ ...base, ...over });

test('upstream agents keep the upstream rule: every finished turn chimes', () => {
  assert.equal(chime({ streamAgent: false }), 'done');
  assert.equal(chime({ streamAgent: false, changed: false }), 'done');
  assert.equal(chime({ streamAgent: false, status: 'active' }), null);
});

test('a stream agent chimes when it needs an answer, selected or not', () => {
  assert.equal(chime({ awaitingInput: true }), 'done');
});

test('an unselected stream agent finishing, starting or erroring stays quiet', () => {
  assert.equal(chime({}), null);
  assert.equal(chime({ status: 'active' }), null);
  assert.equal(chime({ status: 'error' }), null);
});

test('a pinned stream agent taps on error, but finishing stays quiet', () => {
  assert.equal(chime({ pinned: true, status: 'error' }), 'attention');
  assert.equal(chime({ pinned: true }), null);
});

test('the selected stream agent: a change to waiting chimes, an error taps', () => {
  assert.equal(chime({ selected: true }), 'done');
  assert.equal(chime({ selected: true, changed: false }), null, 'a repeat is not news');
  assert.equal(chime({ selected: true, status: 'error' }), 'attention');
  assert.equal(chime({ selected: true, status: 'active' }), null);
});

test('silent resends (seeding, reconnect) never sound', () => {
  assert.equal(chime({ silent: true, awaitingInput: true }), null);
  assert.equal(chime({ silent: true, streamAgent: false }), null);
  assert.equal(chime({ silent: true, selected: true, status: 'error' }), null);
});
