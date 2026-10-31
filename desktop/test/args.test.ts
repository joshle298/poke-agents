import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { parseDesktopArgs } from '../src/args.js';
import {
  COPYRIGHT,
  DESKTOP_BRIDGE_GLOBAL,
  HELP_URL,
  USER_AGENT_PRODUCT,
} from '../src/constants.js';
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

  it('reads --smoke-reconnect only for a smoke run', () => {
    assert.deepEqual(parseDesktopArgs(['.', '--smoke', '--smoke-reconnect'], {}), {
      smoke: true,
      smokeOut: undefined,
      smokeReconnect: true,
    });
    assert.deepEqual(parseDesktopArgs(['.', '--smoke-reconnect'], {}), { smoke: false });
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

  it('gives Finder and the About panel one copyright line', () => {
    const yml = fs.readFileSync(path.join(__dirname, '../electron-builder.yml'), 'utf-8');
    assert.equal(/^copyright: (.+)$/m.exec(yml)?.[1], COPYRIGHT);
    assert.doesNotMatch(yml, /NSHumanReadableCopyright:/, 'no second copyright overriding it');
  });

  it('says why it controls Music or Spotify, and needs no entitlement for it unhardened', () => {
    const yml = fs.readFileSync(path.join(__dirname, '../electron-builder.yml'), 'utf-8');
    const usage = /^ {4}NSAppleEventsUsageDescription: (.+)$/m.exec(yml)?.[1] ?? '';
    assert.match(usage, /Music or Spotify/);
    // The automation entitlement only matters under the hardened runtime.
    assert.match(yml, /^ {2}hardenedRuntime: false$/m);
    assert.doesNotMatch(yml, /entitlements/);
  });

  it('gives the in-process office the Jukebox, as the CLI does', () => {
    const read = (file: string) => fs.readFileSync(path.join(__dirname, file), 'utf-8');
    for (const file of ['../src/electron/main.ts', '../../server/src/cli.ts']) {
      assert.match(read(file), /music: new MusicService\(\)/, file);
    }
  });

  it('shares its names with the office (webview-ui/src/constants.ts)', () => {
    const webview = fs.readFileSync(
      path.join(__dirname, '../../webview-ui/src/constants.ts'),
      'utf-8',
    );
    assert.match(webview, new RegExp(`DESKTOP_APP_USER_AGENT_PRODUCT = '${USER_AGENT_PRODUCT}'`));
    assert.match(webview, new RegExp(`DESKTOP_BRIDGE_GLOBAL = '${DESKTOP_BRIDGE_GLOBAL}'`));
  });

  it('links Help to the README section that exists', () => {
    const readme = fs.readFileSync(path.join(__dirname, '../../README.md'), 'utf-8');
    const anchor = new URL(HELP_URL).hash.slice(1);
    const headings = [...readme.matchAll(/^#+ (.+)$/gm)].map((m) =>
      m[1]
        .toLowerCase()
        .replace(/[^\w\- ]/g, '')
        .replace(/ /g, '-'),
    );
    assert.ok(headings.includes(anchor), `README has a heading for #${anchor}`);
  });
});
