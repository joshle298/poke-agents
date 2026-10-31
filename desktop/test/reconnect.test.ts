import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ATTACHED_RECONNECT, reconnectFeedback, reconnectOutcome } from '../src/reconnect.js';

const status = (state: string) => ({ type: 'conductorStatus', state, scope: {} });

describe('reconnectOutcome', () => {
  it('reads each Conductor state', () => {
    assert.equal(reconnectOutcome(status('connecting')), 'pending');
    assert.equal(reconnectOutcome(status('connected')), 'signedIn');
    assert.equal(reconnectOutcome(status('authRequired')), 'noSignIn');
    assert.equal(reconnectOutcome(status('unauthorized')), 'rejected');
    assert.equal(reconnectOutcome(status('unreachable')), 'unreachable');
    assert.equal(reconnectOutcome(status('rateLimited')), 'unreachable');
  });

  it('ignores every other message', () => {
    for (const message of [null, 'conductorStatus', { type: 'agentStatus', state: 'connected' }]) {
      assert.equal(reconnectOutcome(message), null);
    }
  });
});

describe('reconnectFeedback', () => {
  it('speaks up only when the sign-in still fails', () => {
    assert.match(reconnectFeedback('noSignIn')?.detail ?? '', /conductor auth login.*Allow/);
    assert.match(reconnectFeedback('rejected')?.message ?? '', /rejected/);
    for (const quiet of ['pending', 'signedIn', 'unreachable'] as const) {
      assert.equal(reconnectFeedback(quiet), null);
    }
  });

  it('never points a Finder-launched app at environment variables', () => {
    for (const text of [
      reconnectFeedback('noSignIn'),
      reconnectFeedback('rejected'),
      ATTACHED_RECONNECT,
    ]) {
      assert.doesNotMatch(`${text?.message} ${text?.detail}`, /CONDUCTOR_API_KEY/);
    }
  });

  it('tells an app attached to npm start how to restart it, without a PID', () => {
    assert.match(ATTACHED_RECONNECT.detail, /Control-C/);
    assert.doesNotMatch(ATTACHED_RECONNECT.detail, /PID|\d{3,}/);
  });
});
