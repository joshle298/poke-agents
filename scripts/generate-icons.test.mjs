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
