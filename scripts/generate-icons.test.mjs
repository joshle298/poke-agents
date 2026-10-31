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

/** The sparkles, which sit apart from the orb. */
const SPARKLE_KEYS = new Set('yY*');
/** The C ring's gold, its latch's glint included. */
const RING_KEYS = new Set('Ggow');
/** The sphere's own colours: its body, rim, highlight and glint. */
const SPHERE_KEYS = new Set('BbnNMRhW');
/** The sphere's body alone, without the highlight and glint. */
const BODY_KEYS = new Set('BbnNMR');
const DESIGN_SIZES = [16, 32, 48, 64, 128, 1024];

/** Every drawn cell of a grid whose key passes `keep`. */
function cellsOf(grid, keep) {
  return grid.flatMap((row, y) =>
    row.flatMap((key, x) => (key && keep(key) ? [{ x, y, key }] : [])),
  );
}

const orbCells = (grid) => cellsOf(grid, (key) => !SPARKLE_KEYS.has(key));

/** The box round some cells, in cells. */
function box(cells) {
  const xs = cells.map((c) => c.x);
  const ys = cells.map((c) => c.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { x0, x1, y0, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Groups of cells that touch, corners included. */
function groups(cells) {
  const left = new Set(cells.map((c) => `${c.x},${c.y}`));
  const found = [];
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
    found.push(group.map((key) => key.split(',').map(Number)).map(([x, y]) => ({ x, y })));
  }
  return found;
}

/**
 * The sphere's disc, found from its own colours: as wide as they reach,
 * centred on them left to right, its top where they start (the ring may
 * hide part of its bottom).
 */
function sphereDisc(grid) {
  const cells = cellsOf(grid, (key) => SPHERE_KEYS.has(key));
  const b = box(cells);
  const r = b.width / 2;
  return { cx: b.x0 + r, cy: b.y0 + r, r, box: b };
}

const distance = (cell, disc) => Math.hypot(cell.x + 0.5 - disc.cx, cell.y + 0.5 - disc.cy);

/** Why the orb isn't a round sphere, or null: every sphere colour lies in
 *  the disc, the disc holds nothing but the sphere, its outline and the
 *  ring, and the sphere shows at least 70% of its height. */
function roundProblem(grid) {
  const disc = sphereDisc(grid);
  for (const cell of cellsOf(grid, (key) => SPHERE_KEYS.has(key))) {
    if (distance(cell, disc) > disc.r + 0.5) return `(${cell.x}, ${cell.y}) is off the disc`;
  }
  for (const [y, row] of grid.entries()) {
    for (const [x, key] of row.entries()) {
      if (distance({ x, y }, disc) > disc.r - 1) continue;
      if (!key || !(SPHERE_KEYS.has(key) || RING_KEYS.has(key) || key === 'k')) {
        return `(${x}, ${y}) inside the disc is ${key ?? 'empty'}`;
      }
    }
  }
  if (disc.box.height < 0.7 * disc.box.width) {
    return `${disc.box.width} wide but ${disc.box.height} tall`;
  }
  return null;
}

/**
 * The C ring, or null: gold reaching past the sphere on both sides, in one
 * stroke on the left (the spine) and in two ends on the right with at least
 * a clear row between them (the opening). Inside the disc it only crosses
 * the sphere's lower half (in front), the upper half hiding it (behind).
 */
function findRingC(grid) {
  const disc = sphereDisc(grid);
  const gold = cellsOf(grid, (key) => RING_KEYS.has(key));
  const left = gold.filter((c) => c.x + 1 <= disc.cx - disc.r);
  const right = gold.filter((c) => c.x >= disc.cx + disc.r);
  if (left.length === 0 || right.length === 0) return null;
  if (groups(left).length !== 1) return null;
  const ends = groups(right).map(box);
  if (ends.length !== 2) return null;
  const [upper, lower] = ends.sort((a, b) => a.y0 - b.y0);
  if (lower.y0 - upper.y1 < 2) return null;
  const inside = gold.filter((c) => distance(c, disc) <= disc.r - 0.5);
  if (inside.length === 0 || inside.some((c) => c.y + 0.5 <= disc.cy)) return null;
  return { spine: box(left), upper, lower };
}

/** Why a band crosses the sphere, or null: on the rows within half a radius
 *  of its centre, no run of anything but the sphere covers half the chord. */
function bandProblem(grid) {
  const disc = sphereDisc(grid);
  for (let y = 0; y < grid.length; y++) {
    const dy = y + 0.5 - disc.cy;
    if (Math.abs(dy) > disc.r / 2) continue;
    const half = Math.sqrt(disc.r ** 2 - dy ** 2);
    const x0 = Math.ceil(disc.cx - half - 0.5);
    const x1 = Math.floor(disc.cx + half - 0.5);
    let run = 0;
    for (let x = x0; x <= x1; x++) {
      run = SPHERE_KEYS.has(grid[y][x]) ? 0 : run + 1;
      if (run >= (x1 - x0 + 1) / 2) return `row ${y}: a run of ${run} across ${x1 - x0 + 1}`;
    }
  }
  return null;
}

/** Why the sphere has a button, or null: within a third of its radius of
 *  its centre there is only its body colour. */
function buttonProblem(grid) {
  const disc = sphereDisc(grid);
  for (const [y, row] of grid.entries()) {
    for (const [x, key] of row.entries()) {
      if (distance({ x, y }, disc) <= disc.r / 3 && !BODY_KEYS.has(key)) {
        return `(${x}, ${y}) at the centre is ${key ?? 'empty'}`;
      }
    }
  }
  return null;
}

test('the orb is a round sphere at every size, not a pill', () => {
  for (const size of DESIGN_SIZES) assert.equal(roundProblem(designFor(size)), null, `${size} px`);
});

test('a gold C rings the sphere at every size: past it both sides, open on the right', () => {
  for (const size of DESIGN_SIZES) {
    const ring = findRingC(designFor(size));
    assert.ok(ring, `${size} px shows the C ring`);
    // The C's spine reaches above and below the ends of its arms' opening.
    assert.ok(ring.spine.height >= 3, `${size} px: a spine ${ring.spine.height} tall`);
  }
});

test('no band splits the sphere and no button sits in its middle, at any size', () => {
  for (const size of DESIGN_SIZES) {
    assert.equal(bandProblem(designFor(size)), null, `${size} px band`);
    assert.equal(buttonProblem(designFor(size)), null, `${size} px button`);
  }
});

test('the shape checks reject a pill, no ring, a closed O, a mirrored C, a band and a button', () => {
  const grid = designFor(1024);
  const swap = (from, to) =>
    grid.map((row, y) => row.map((key, x) => (from({ x, y, key }) ? to : key)));
  const disc = sphereDisc(grid);
  const ring = findRingC(grid);

  const pill = grid.map((row) => row.flatMap((key) => [key, key]));
  assert.notEqual(roundProblem(pill), null, 'a pill');
  assert.equal(findRingC(swap(({ key }) => RING_KEYS.has(key), null)), null, 'no ring');
  const closed = swap(
    ({ x, y }) =>
      y > ring.upper.y1 && y < ring.lower.y0 && x >= ring.lower.x0 && x <= ring.upper.x1,
    'g',
  );
  assert.equal(findRingC(closed), null, 'a closed O');
  assert.equal(findRingC(grid.map((row) => [...row].reverse())), null, 'a mirrored C');
  const middle = Math.floor(disc.cy);
  assert.notEqual(
    bandProblem(swap(({ x, y }) => y === middle && Math.abs(x + 0.5 - disc.cx) < disc.r, 'k')),
    null,
    'a dark band across the middle',
  );
  assert.notEqual(
    buttonProblem(swap((cell) => distance(cell, disc) <= 1.5, 'h')),
    null,
    'a pale button in the middle',
  );
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

test('the sphere is teal to indigo all round and the ring gold, with no white half', () => {
  for (const key of BODY_KEYS) {
    const { hue, sat } = hueSat(...INK[key]);
    assert.ok(hue >= 170 && hue <= 250 && sat >= 0.4, `body ${key}: hue ${hue}, sat ${sat}`);
  }
  for (const key of 'Ggo') {
    const { hue, sat } = hueSat(...INK[key]);
    assert.ok(hue >= 35 && hue <= 55 && sat >= 0.4, `ring ${key}: hue ${hue}, sat ${sat}`);
  }
  for (const size of DESIGN_SIZES) {
    const sphere = cellsOf(designFor(size), (key) => SPHERE_KEYS.has(key));
    const pale = sphere.filter((c) => !BODY_KEYS.has(c.key));
    assert.ok(pale.length <= 0.12 * sphere.length, `${size} px: ${pale.length} pale cells`);
  }
});

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

test("the orb uses the office orb's colours", () => {
  const sprite = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'webview-ui/src/office/sprites/orb.json'), 'utf8'),
  );
  for (const key of 'BbnNMRhWwGgo') {
    const want = sprite.palette[key].toLowerCase();
    const got = `#${INK[key].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    assert.equal(got, want, `ink ${key}`);
  }
});

test('two sparkles that touch neither each other nor the orb', () => {
  const grid = designFor(1024);
  assert.equal(groups(cellsOf(grid, (key) => SPARKLE_KEYS.has(key))).length, 2);
  for (const { x, y } of cellsOf(grid, (key) => SPARKLE_KEYS.has(key))) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = grid[y + dy][x + dx];
        assert.ok(!key || SPARKLE_KEYS.has(key), `sparkle (${x}, ${y}) touches the orb`);
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

test('at 16 px a full pixel of tile surrounds the orb', () => {
  const grid = designFor(16);
  const body = bodyCoverage(16);
  for (const { x, y } of orbCells(grid)) {
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
