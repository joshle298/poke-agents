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
  cellLayout,
  designFor,
  encodePng,
  ICNS_ENTRIES,
  INK,
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
    const { edge } = cellLayout(size, grid.length);
    const body = bodyCoverage(size);
    for (const { x, y } of cellsOf(grid, () => true)) {
      for (let py = edge(y); py < edge(y + 1); py++) {
        for (let px = edge(x); px < edge(x + 1); px++) {
          assert.ok(body[py * size + px] >= 0.5, `${size} px: cell (${x}, ${y}) leaves the square`);
        }
      }
    }
  }
});

/** Every size buildOutputs writes, apart from the full-bleed touch icon. */
const OUTPUT_SIZES = [
  ...new Set([...ICNS_ENTRIES.map(([, size]) => size), 16, 32, 48, 192, 256, 512, 128]),
];

test('every output size draws its design on whole-pixel cells', () => {
  for (const size of OUTPUT_SIZES) {
    const cells = designFor(size).length;
    assert.equal(size % cells, 0, `${size} px draws ${cells} cells of ${size / cells} px`);
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

/** The sparkles, which sit apart from the capsule. */
const SPARKLE_KEYS = new Set('yYW');
/** The C's gold (the collar's at 16 px). */
const GOLD_KEYS = new Set('Ggo');
/** The outline (at 16 px, the C printed on the collar). */
const DARK_KEYS = new Set('k');
const TEAL_KEYS = new Set('TtdD');
const CREAM_KEYS = new Set('wcCb');
const DESIGN_SIZES = [16, 32, 48, 64, 128, 1024];
/** The hand-drawn 16 px design, which 48 px also draws. */
const isSmallDesign = (size) => designFor(size).length === 16;

/** Every drawn cell of a grid whose key passes `keep`. */
function cellsOf(grid, keep) {
  return grid.flatMap((row, y) =>
    row.flatMap((key, x) => (key && keep(key) ? [{ x, y, key }] : [])),
  );
}

const capsuleCells = (grid) => cellsOf(grid, (key) => !SPARKLE_KEYS.has(key));

/** The box round some cells, in cells. */
function box(cells) {
  const xs = cells.map((c) => c.x);
  const ys = cells.map((c) => c.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { x0, x1, y0, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

test('the capsule is a pill 1.4 to 2 times as wide as tall at every size, not a ball', () => {
  // The office sprite's closed capsule is 16 by 8, twice as wide as tall.
  for (const size of DESIGN_SIZES) {
    const { width, height } = box(capsuleCells(designFor(size)));
    const ratio = width / height;
    assert.ok(ratio >= 1.4 && ratio <= 2, `${size} px: ${width} x ${height}`);
  }
});

/**
 * The C drawn in `keys`, or null. Taken top to bottom, the rows of its box
 * must each hold one run of those keys starting in the box's first two
 * columns (for rounded corners): first an arm reaching the right edge, then
 * at least two rows that stop at least two cells short of it (a counter open
 * to the right), then an arm reaching the right edge again. That rules out
 * an O, an E, a mirrored C and a solid block.
 */
function findC(grid, keys) {
  const cells = cellsOf(grid, (key) => keys.has(key));
  if (cells.length === 0) return null;
  const found = box(cells);
  const { x0, x1, y0, y1 } = found;
  if (found.height < 5 || found.width < 3) return null;
  let shape = '';
  for (let y = y0; y <= y1; y++) {
    const xs = [];
    for (let x = x0; x <= x1; x++) if (keys.has(grid[y][x])) xs.push(x);
    if (xs.length === 0 || xs.at(-1) - xs[0] + 1 !== xs.length || xs[0] > x0 + 1) return null;
    shape += xs.at(-1) === x1 ? 'a' : xs.at(-1) <= x1 - 2 ? 'c' : '?';
  }
  return /^a+c{2,}a+$/.test(shape) ? found : null;
}

/** At 16 px, the C printed dark on the gold collar, or null: the collar must
 *  show left of its spine, above and below it, and in its counter. */
function findPrintedC(grid) {
  const c = findC(grid, DARK_KEYS);
  if (!c) return null;
  const { x0, x1, y0, y1 } = c;
  for (let y = y0 - 1; y <= y1 + 1; y++) {
    for (let x = x0 - 1; x <= x1; x++) {
      const key = grid[y][x];
      if (!DARK_KEYS.has(key) && !GOLD_KEYS.has(key)) return null;
    }
  }
  return c;
}

/** The C at a size: gold on the capsule from 32 px, printed on the collar in
 *  the 16 px design. */
const cAt = (size) =>
  isSmallDesign(size) ? findPrintedC(designFor(size)) : findC(designFor(size), GOLD_KEYS);

test('every size shows a bold C in the middle of the capsule, at least 60% of its height', () => {
  for (const size of DESIGN_SIZES) {
    const c = cAt(size);
    assert.ok(c, `${size} px shows a C`);
    const capsule = box(capsuleCells(designFor(size)));
    assert.ok(c.height >= 0.6 * capsule.height, `${size} px: C ${c.height} of ${capsule.height}`);
    const centre = (from, to) => (from + to + 1) / 2;
    assert.ok(
      Math.abs(centre(c.x0, c.x1) - centre(capsule.x0, capsule.x1)) <= 1 &&
        Math.abs(centre(c.y0, c.y1) - centre(capsule.y0, capsule.y1)) <= 1,
      `${size} px: the C is centred on the capsule`,
    );
  }
});

test('the C checks reject a capsule with no C, a closed O or a mirrored C', () => {
  const big = designFor(1024);
  const small = designFor(16);
  const without = (grid, keys, fill) =>
    grid.map((row) => row.map((key) => (keys.has(key) ? fill : key)));
  /** The C's counter filled in on its right edge, closing it into an O. */
  const closed = (grid, c, key) =>
    grid.map((row, y) =>
      row.map((k, x) => (y > c.y0 && y < c.y1 && (x === c.x1 || x === c.x1 - 1) ? key : k)),
    );
  const mirrored = (grid) => grid.map((row) => [...row].reverse());

  assert.equal(findC(without(big, GOLD_KEYS, 'c'), GOLD_KEYS), null);
  assert.equal(findC(closed(big, findC(big, GOLD_KEYS), 'g'), GOLD_KEYS), null);
  assert.equal(findC(mirrored(big), GOLD_KEYS), null);

  assert.equal(findPrintedC(without(small, DARK_KEYS, 'g')), null);
  assert.equal(findPrintedC(closed(small, findPrintedC(small), 'k')), null);
  assert.equal(findPrintedC(mirrored(small)), null);
  // A dark C on teal or cream instead of the collar.
  assert.equal(findPrintedC(without(small, GOLD_KEYS, 't')), null);
});

/** Groups of sparkle cells that touch, corners included. */
function sparkleGroups(grid) {
  const left = new Set(cellsOf(grid, (key) => SPARKLE_KEYS.has(key)).map((c) => `${c.x},${c.y}`));
  const groups = [];
  for (const start of left) {
    left.delete(start);
    const group = [start];
    for (let i = 0; i < group.length; i++) {
      const [x, y] = group[i].split(',').map(Number);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const next = `${x + dx},${y + dy}`;
          if (left.delete(next)) group.push(next);
        }
      }
    }
    groups.push(group.map((key) => key.split(',').map(Number)));
  }
  return groups;
}

test('two sparkles that touch neither each other nor the capsule', () => {
  const grid = designFor(1024);
  assert.equal(sparkleGroups(grid).length, 2);
  for (const { x, y } of cellsOf(grid, (key) => SPARKLE_KEYS.has(key))) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = grid[y + dy][x + dx];
        assert.ok(!key || SPARKLE_KEYS.has(key), `sparkle (${x}, ${y}) touches the capsule`);
      }
    }
  }
  assert.equal(cellsOf(designFor(16), (key) => SPARKLE_KEYS.has(key)).length, 0, 'none at 16 px');
});

test('a whole cell of tile lies between every sparkle and the tile edge, iOS mask included', () => {
  const sizes = [32, 64, 128, 256, 512, 1024].map((size) => ({ size, fullBleed: false }));
  // The 180 px home-screen icon fills the canvas, and iOS cuts its corners.
  for (const { size, fullBleed } of [...sizes, { size: 180, fullBleed: true }]) {
    const grid = designFor(size);
    const { edge } = cellLayout(size, grid.length, { fullBleed });
    const tile = bodyCoverage(size, fullBleed ? { fraction: 1 } : {});
    for (const { x, y } of cellsOf(grid, (key) => SPARKLE_KEYS.has(key))) {
      // The sparkle cell and the ring of cells round it are all tile.
      assert.ok(edge(x - 1) > 0 && edge(y - 1) > 0, `${size} px: sparkle (${x}, ${y}) off canvas`);
      for (let py = edge(y - 1); py < edge(y + 2); py++) {
        for (let px = edge(x - 1); px < edge(x + 2); px++) {
          assert.equal(tile[py * size + px], 1, `${size} px: sparkle (${x}, ${y}) near the edge`);
        }
      }
    }
  }
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

/** HSV value (0 to 1) of a cell key's colour. */
const valueOf = (key) => Math.max(...INK[key]) / 255;

test('no dark band runs across the capsule at any size', () => {
  for (const size of DESIGN_SIZES) {
    const cells = capsuleCells(designFor(size));
    const { y0, y1 } = box(cells);
    for (let y = y0 + 1; y < y1; y++) {
      const row = cells.filter((c) => c.y === y).sort((a, b) => a.x - b.x);
      const span = row.at(-1).x - row[0].x + 1;
      let longest = 0;
      let current = 0;
      for (const [i, cell] of row.entries()) {
        const touching = i > 0 && cell.x === row[i - 1].x + 1;
        current = valueOf(cell.key) < 0.25 ? (touching ? current : 0) + 1 : 0;
        longest = Math.max(longest, current);
      }
      assert.ok(longest < span / 2, `${size} px: row ${y} has a dark run of ${longest}/${span}`);
    }
  }
});

test('the teal cap and the cream body sit side by side, not top over bottom', () => {
  for (const size of DESIGN_SIZES) {
    const grid = designFor(size);
    const { width, height } = box(capsuleCells(grid));
    const teal = cellsOf(grid, (key) => TEAL_KEYS.has(key));
    const cream = cellsOf(grid, (key) => CREAM_KEYS.has(key));
    const dx = mean(cream.map((c) => c.x)) - mean(teal.map((c) => c.x));
    const dy = mean(cream.map((c) => c.y)) - mean(teal.map((c) => c.y));
    assert.ok(dx > width / 4, `${size} px: the cream body is right of the teal cap (${dx})`);
    assert.ok(Math.abs(dy) < height / 8, `${size} px: neither half is on top (${dy})`);
  }
});

test("the capsule uses the office capsule's teal, cream and gold", () => {
  const sprite = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'webview-ui/src/office/sprites/capsule.json'), 'utf8'),
  );
  for (const key of 'TtdcCgGo') {
    const want = sprite.palette[key].toLowerCase();
    const got = `#${INK[key].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    assert.equal(got, want, `ink ${key}`);
  }
});

test('at 16 px a full pixel of tile surrounds the capsule', () => {
  const grid = designFor(16);
  const body = bodyCoverage(16);
  for (const { x, y } of capsuleCells(grid)) {
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (grid[ny][nx] && !SPARKLE_KEYS.has(grid[ny][nx])) continue;
      assert.equal(body[ny * 16 + nx], 1, `tile around (${x}, ${y})`);
    }
  }
});
