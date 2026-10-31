/**
 * The status label's activity line: an active session with no tool running
 * reads Working (it sits at its desk), only an inactive one reads Idle.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { getActivityText } from '../src/office/components/activityText.js';

test('active with no tool running is Working; inactive is Idle', () => {
  assert.equal(getActivityText(1, {}, true, null, false), 'Working');
  assert.equal(getActivityText(1, { 1: [] }, true, null, false), 'Working');
  assert.equal(getActivityText(1, {}, false, null, false), 'Idle');
});

test('a running tool, the last finished one mid-turn, questions and errors win', () => {
  const tools = { 1: [{ toolId: 't1', status: 'Reading app.ts', done: false }] };
  assert.equal(getActivityText(1, tools, true, null, false), 'Reading app.ts');
  const done = { 1: [{ toolId: 't1', status: 'Running: npm test', done: true }] };
  assert.equal(getActivityText(1, done, true, null, false), 'Running: npm test');
  assert.equal(getActivityText(1, done, false, null, false), 'Idle', 'a finished turn is idle');
  assert.equal(getActivityText(1, {}, false, 'waiting', true), 'Waiting for input');
  assert.equal(getActivityText(1, {}, true, 'permission', false), 'Needs approval');
  assert.equal(getActivityText(1, {}, false, null, false, 'overloaded'), 'overloaded');
});
