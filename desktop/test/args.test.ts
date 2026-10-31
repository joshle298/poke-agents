import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { parseDesktopArgs } from '../src/args.js';
import { speciesName } from '../src/species.js';

describe('parseDesktopArgs', () => {
  it('is a normal launch by default, whatever Chromium switches come along', () => {
    assert.deepEqual(parseDesktopArgs(['/Applications/Poke Agents.app', '--no-sandbox'], {}), {
      smoke: false,
    });
  });

  it('reads --smoke and --smoke-out', () => {
    assert.deepEqual(parseDesktopArgs(['.', '--smoke'], {}), { smoke: true, smokeOut: undefined });
    assert.deepEqual(parseDesktopArgs(['.', '--smoke-out=/tmp/shot.png'], {}), {
      smoke: true,
      smokeOut: '/tmp/shot.png',
    });
    assert.deepEqual(parseDesktopArgs(['.', '--smoke-out='], {}), { smoke: false });
  });

  it('reads the same from the environment', () => {
    assert.deepEqual(
      parseDesktopArgs(['.'], { POKE_AGENTS_SMOKE: '1', POKE_AGENTS_SMOKE_OUT: '/tmp/a.png' }),
      { smoke: true, smokeOut: '/tmp/a.png' },
    );
  });
});

describe('speciesName', () => {
  it('names line members and legendaries from the catalog', () => {
    assert.equal(speciesName(25), 'Pikachu');
    assert.equal(speciesName(150), 'Mewtwo');
    assert.equal(speciesName(0), undefined);
  });
});

describe('desktop package', () => {
  it('carries the repo’s version, which the app reports in About', () => {
    const read = (file: string) =>
      JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf-8')) as { version: string };
    assert.equal(read('../package.json').version, read('../../package.json').version);
  });
});
