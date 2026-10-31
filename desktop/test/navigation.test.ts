import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyNavigation } from '../src/navigation.js';

const OFFICE = 'http://127.0.0.1:41510';

describe('classifyNavigation', () => {
  it('lets the window load the office itself', () => {
    assert.equal(classifyNavigation(`${OFFICE}/?token=abc`, OFFICE), 'office');
    assert.equal(classifyNavigation(`${OFFICE}/some/route`, OFFICE), 'office');
  });

  it('sends web pages, including other local servers, to the default browser', () => {
    assert.equal(classifyNavigation('https://github.com/joshle298/poke-agents', OFFICE), 'browser');
    assert.equal(classifyNavigation('https://sprites.pmdcollab.org/', OFFICE), 'browser');
    assert.equal(classifyNavigation('http://127.0.0.1:3000/', OFFICE), 'browser');
    assert.equal(classifyNavigation('http://localhost:41510/', OFFICE), 'browser');
  });

  it('hands Conductor deep links to the system', () => {
    assert.equal(classifyNavigation('conductor://workspace?id=w1&session=s1', OFFICE), 'conductor');
    assert.equal(classifyNavigation('conductor-dev://workspace?id=w1', OFFICE), 'conductor');
  });

  it('blocks deep links the server would refuse, and every other scheme', () => {
    for (const url of [
      'conductor://settings',
      'conductor://user:pass@workspace',
      'conductor:// workspace',
      'CONDUCTOR-EVIL!://workspace',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hi',
      'vscode://file/x',
      'about:blank',
      'not a url',
      'https://user:pw@example.com/',
    ]) {
      assert.equal(classifyNavigation(url, OFFICE), 'block', url);
    }
  });
});
