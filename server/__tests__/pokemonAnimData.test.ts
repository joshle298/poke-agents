import { describe, expect, it } from 'vitest';

import {
  hasPngSignature,
  parseAnimData,
  readPngSize,
  resolveAnim,
  sheetAnimNames,
  validateSheet,
} from '../src/pokemon/animData.js';
import { animDataXml, solidPng } from './pokemonTestUtils.js';

describe('parseAnimData', () => {
  it('reads frame size, durations, shadow size and marker frames', () => {
    const data = parseAnimData(
      animDataXml(
        [
          { name: 'Walk', index: 0, w: 32, h: 40, durations: [8, 10, 8, 10] },
          {
            name: 'Attack',
            index: 1,
            w: 80,
            h: 80,
            durations: [2, 4, 1, 1],
            rushFrame: 1,
            hitFrame: 2,
            returnFrame: 3,
          },
        ],
        2,
      ),
    );
    expect(data).not.toBeNull();
    expect(data!.shadowSize).toBe(2);
    expect(data!.anims.Walk).toEqual({
      index: 0,
      frameWidth: 32,
      frameHeight: 40,
      durations: [8, 10, 8, 10],
      rushFrame: undefined,
      hitFrame: undefined,
      returnFrame: undefined,
    });
    expect(data!.anims.Attack).toMatchObject({ rushFrame: 1, hitFrame: 2, returnFrame: 3 });
  });

  it('keeps CopyOf aliases, with or without an Index', () => {
    const data = parseAnimData(
      animDataXml([
        { name: 'Charge', index: 11, w: 40, h: 40, durations: [2, 2] },
        { name: 'Shoot', index: 3, copyOf: 'Charge' },
        { name: 'Appeal', copyOf: 'Shoot' },
      ]),
    )!;
    expect(data.anims.Shoot).toEqual({ index: 3, durations: [], copyOf: 'Charge' });
    expect(data.anims.Appeal).toEqual({ index: undefined, durations: [], copyOf: 'Shoot' });
    expect(sheetAnimNames(data)).toEqual(new Set(['Charge']));
  });

  it('drops malformed anims instead of trusting them', () => {
    const data = parseAnimData(
      animDataXml([
        { name: 'Walk', w: 32, h: 40, durations: [8] },
        { name: '../Evil', w: 32, h: 40, durations: [8] },
        { name: 'Huge', w: 9999, h: 40, durations: [8] },
        { name: 'NoFrames', w: 32, h: 40, durations: [] },
        { name: 'ZeroHold', w: 32, h: 40, durations: [0, 4] },
        { name: 'BadAlias', copyOf: 'not-a-name' },
        { name: 'SelfAlias', copyOf: 'SelfAlias' },
        { name: 'Marker', w: 32, h: 40, durations: [2, 2], hitFrame: 5 },
      ]),
    )!;
    expect(Object.keys(data.anims).sort()).toEqual(['Marker', 'Walk']);
    expect(data.anims.Marker.hitFrame).toBeUndefined();
  });

  it('returns null when nothing usable is left', () => {
    expect(parseAnimData('<html>404</html>')).toBeNull();
    expect(parseAnimData(animDataXml([{ name: 'x', w: 1, h: 1, durations: [1] }]))).toBeNull();
  });

  it('treats a missing or out-of-range ShadowSize as 0', () => {
    const xml = animDataXml([{ name: 'Walk', w: 32, h: 40, durations: [8] }], 7);
    expect(parseAnimData(xml)!.shadowSize).toBe(0);
  });
});

describe('resolveAnim', () => {
  const data = parseAnimData(
    animDataXml([
      { name: 'Charge', w: 40, h: 40, durations: [2, 2, 2], hitFrame: 1 },
      { name: 'Shoot', copyOf: 'Charge' },
      { name: 'Appeal', copyOf: 'Shoot' },
      { name: 'Ping', copyOf: 'Pong' },
      { name: 'Pong', copyOf: 'Ping' },
      { name: 'Dangling', copyOf: 'Missing' },
    ]),
  )!;

  it('returns an anim with a sheet of its own as is', () => {
    expect(resolveAnim(data, 'Charge')).toEqual({
      name: 'Charge',
      source: 'Charge',
      file: 'Charge-Anim.png',
      frameWidth: 40,
      frameHeight: 40,
      durations: [2, 2, 2],
      rushFrame: undefined,
      hitFrame: 1,
      returnFrame: undefined,
    });
  });

  it('follows CopyOf chains to the target file, whatever its name', () => {
    expect(resolveAnim(data, 'Shoot')).toMatchObject({
      name: 'Shoot',
      source: 'Charge',
      file: 'Charge-Anim.png',
      durations: [2, 2, 2],
    });
    expect(resolveAnim(data, 'Appeal')?.file).toBe('Charge-Anim.png');
  });

  it('gives up on cycles, dangling aliases, the hop limit and unknown names', () => {
    expect(resolveAnim(data, 'Ping')).toBeNull();
    expect(resolveAnim(data, 'Dangling')).toBeNull();
    expect(resolveAnim(data, 'Appeal', 1)).toBeNull();
    expect(resolveAnim(data, 'Walk')).toBeNull();
    expect(resolveAnim(data, 'constructor')).toBeNull();
  });
});

describe('validateSheet', () => {
  const walk = { frameWidth: 32, frameHeight: 40, durations: [8, 10, 8, 10] };

  it('accepts 8-direction and 1-direction sheets', () => {
    expect(validateSheet(walk, 128, 320)).toEqual({ ok: true, frames: 4, directions: 8 });
    expect(validateSheet(walk, 128, 40)).toEqual({ ok: true, frames: 4, directions: 1 });
  });

  it('rejects a width that does not match the frame count', () => {
    const check = validateSheet(walk, 96, 320);
    expect(check.ok).toBe(false);
  });

  it('rejects a height that is neither 8 rows nor 1', () => {
    expect(validateSheet(walk, 128, 160).ok).toBe(false);
  });

  it('validates against the size read from a real PNG header', () => {
    const size = readPngSize(solidPng(128, 320));
    expect(size).toEqual({ width: 128, height: 320 });
    expect(validateSheet(walk, size!.width, size!.height)).toMatchObject({ ok: true });
  });
});

describe('PNG header checks', () => {
  it('recognises the PNG signature and nothing else', () => {
    expect(hasPngSignature(solidPng(2, 2))).toBe(true);
    expect(hasPngSignature(Buffer.from('<html>not a png</html>'))).toBe(false);
    expect(readPngSize(Buffer.from('GIF89a........................'))).toBeNull();
    expect(readPngSize(solidPng(2, 2).subarray(0, 20))).toBeNull();
  });
});
