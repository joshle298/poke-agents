import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import pngjs from 'pngjs';

import {
  bodyCoverage,
  buildIco,
  buildOutputs,
  designFor,
  encodePng,
  ICNS_ENTRIES,
  renderIcon,
} from './generate-icons.mjs';

const { PNG } = pngjs;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Split an .icns file into its entries, checking the container on the way. */
function readIcns(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'icns');
  assert.equal(buf.readUInt32BE(4), buf.length, 'header length is the file length');
  const entries = [];
  for (let at = 8; at < buf.length;) {
    const type = buf.toString('ascii', at, at + 4);
    const length = buf.readUInt32BE(at + 4);
    assert.ok(length >= 8 && at + length <= buf.length, `${type} fits in the file`);
    entries.push({ type, data: buf.subarray(at + 8, at + length) });
    at += length;
  }
  return entries;
}

/** Split an .ico file into its images. */
function readIco(buf) {
  assert.equal(buf.readUInt16LE(0), 0);
  assert.equal(buf.readUInt16LE(2), 1, 'type 1 = icon');
  const count = buf.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const at = 6 + i * 16;
    const size = buf.readUInt8(at) || 256;
    const length = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    assert.equal(buf.readUInt16LE(at + 6), 32, '32 bits per pixel');
    return { size, data: buf.subarray(offset, offset + length) };
  });
}

const decode = (png) => PNG.sync.read(png);

test('rendering is deterministic', () => {
  for (const size of [16, 32, 128]) {
    assert.ok(renderIcon(size).data.equals(renderIcon(size).data), `${size} px`);
  }
});

test('the .icns holds a TOC and one PNG per macOS icon slot, at the right size', () => {
  const entries = readIcns(fs.readFileSync(path.join(REPO_ROOT, 'desktop/resources/icon.icns')));
  assert.equal(entries[0].type, 'TOC ');
  const toc = entries[0].data;
  const listed = Array.from({ length: toc.length / 8 }, (_, i) =>
    toc.toString('ascii', i * 8, i * 8 + 4),
  );
  const images = entries.slice(1);
  assert.deepEqual(
    images.map((e) => e.type),
    ICNS_ENTRIES.map(([type]) => type),
  );
  assert.deepEqual(
    listed,
    ICNS_ENTRIES.map(([type]) => type),
  );
  for (const [i, [type, size]] of ICNS_ENTRIES.entries()) {
    const data = images[i].data;
    assert.ok(data.subarray(0, 8).equals(PNG_SIGNATURE), `${type} is a PNG`);
    const png = decode(data);
    assert.deepEqual([png.width, png.height], [size, size], type);
  }
});

test('favicon.ico holds 16, 32 and 48 px PNGs', () => {
  const images = readIco(fs.readFileSync(path.join(REPO_ROOT, 'webview-ui/public/favicon.ico')));
  assert.deepEqual(
    images.map((i) => i.size),
    [16, 32, 48],
  );
  for (const { size, data } of images) {
    const png = decode(data);
    assert.deepEqual([png.width, png.height], [size, size]);
  }
});

test('buildIco writes 0 for a 256 px dimension, as the format requires', () => {
  const png = encodePng(renderIcon(16));
  const ico = buildIco([{ size: 256, png }]);
  assert.equal(ico.readUInt8(6), 0);
  assert.equal(ico.readUInt8(7), 0);
});

test('the pixel art stays inside the rounded square at every size', () => {
  for (const size of [16, 32, 48, 64, 128, 256, 1024]) {
    const grid = designFor(size);
    const cells = grid.length;
    const body = bodyCoverage(size);
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        if (!grid[cy][cx]) continue;
        for (
          let y = Math.round((cy * size) / cells);
          y < Math.round(((cy + 1) * size) / cells);
          y++
        ) {
          for (
            let x = Math.round((cx * size) / cells);
            x < Math.round(((cx + 1) * size) / cells);
            x++
          ) {
            assert.ok(
              body[y * size + x] >= 0.5,
              `${size} px: cell (${cx}, ${cy}) leaves the square`,
            );
          }
        }
      }
    }
  }
});

test('the committed icon files are what the script draws (run it after changing the art)', () => {
  const pixels = (png) => decode(png).data;
  for (const [rel, expected] of buildOutputs()) {
    const actual = fs.readFileSync(path.join(REPO_ROOT, rel));
    if (rel.endsWith('.icns')) {
      const want = readIcns(expected);
      const got = readIcns(actual);
      assert.deepEqual(
        got.map((e) => e.type),
        want.map((e) => e.type),
        rel,
      );
      for (const [i, entry] of want.entries()) {
        if (entry.type === 'TOC ') continue;
        assert.ok(pixels(got[i].data).equals(pixels(entry.data)), `${rel} ${entry.type}`);
      }
    } else if (rel.endsWith('.ico')) {
      const want = readIco(expected);
      const got = readIco(actual);
      assert.equal(got.length, want.length, rel);
      for (const [i, image] of want.entries()) {
        assert.ok(pixels(got[i].data).equals(pixels(image.data)), `${rel} ${image.size} px`);
      }
    } else {
      // Compare pixels, not bytes: zlib output may differ between Node versions.
      assert.ok(pixels(actual).equals(pixels(expected)), rel);
    }
  }
});

/** Promptling's body, face and feet: everything but the sparkles and the
 *  antenna bulb, which may sit as near the tile's edge as the sparkles. */
const MASCOT_KEYS = new Set('ktTdDcCePmb');
/** The eyes: the `>` prompt and the block cursor (with its glint). */
const EYE_KEYS = new Set('eP');

const isEye = (grid, x, y) => EYE_KEYS.has(grid[y]?.[x]);

/** Is there a `>` drawn in eye ink: a column, the next column one row down,
 *  then the first column again, with nothing in eye ink to its right? */
function hasPrompt(grid) {
  return grid.some((row, y) =>
    row.some(
      (_, x) =>
        isEye(grid, x, y) &&
        isEye(grid, x + 1, y + 1) &&
        isEye(grid, x, y + 2) &&
        !isEye(grid, x + 1, y) &&
        !isEye(grid, x + 1, y + 2) &&
        !isEye(grid, x + 2, y + 1),
    ),
  );
}

/** Is there a solid block of eye ink at least 2 cells wide and 3 tall? */
function hasCursor(grid) {
  return grid.some((row, y) =>
    row.some((_, x) => [0, 1].every((dx) => [0, 1, 2].every((dy) => isEye(grid, x + dx, y + dy)))),
  );
}

test('every size keeps the face: a `>` prompt eye and a block cursor eye', () => {
  for (const size of [16, 32, 48, 64, 128, 1024]) {
    const grid = designFor(size);
    assert.ok(hasPrompt(grid), `${size} px shows the > prompt`);
    assert.ok(hasCursor(grid), `${size} px shows the cursor`);
  }
});

test('the face checks reject a grid without the prompt or the cursor', () => {
  const grid = designFor(1024).map((row) => row.map((key) => (EYE_KEYS.has(key) ? 't' : key)));
  assert.equal(hasPrompt(grid), false);
  assert.equal(hasCursor(grid), false);
});

/** Hue in degrees and saturation (HSV) of an RGB pixel. */
function hueSat(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { hue: 0, sat: 0, value: max / 255 };
  let hue;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  return { hue: (hue * 60 + 360) % 360, sat: d / max, value: max / 255 };
}

test('no size uses red: the icon stays off the official ball colours', () => {
  for (const size of [16, 32, 128, 1024]) {
    const { data } = renderIcon(size);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      const { hue, sat, value } = hueSat(data[i], data[i + 1], data[i + 2]);
      const red = (hue < 20 || hue > 340) && sat > 0.4 && value > 0.3;
      assert.ok(!red, `${size} px: pixel ${i / 4} is red (${data.subarray(i, i + 3).join(',')})`);
    }
  }
});

test('at 16 px a full pixel of tile surrounds the body', () => {
  const grid = designFor(16);
  const body = bodyCoverage(16);
  grid.forEach((row, y) =>
    row.forEach((key, x) => {
      if (!MASCOT_KEYS.has(key)) return;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (MASCOT_KEYS.has(grid[ny][nx])) continue;
        assert.equal(body[ny * 16 + nx], 1, `tile around (${x}, ${y})`);
      }
    }),
  );
});
