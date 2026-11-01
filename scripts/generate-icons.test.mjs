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
const NEIGHBOURS_4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

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

/** The sphere's disc, found from its own colours: as wide as they reach and
 *  centred on them. */
function sphereDisc(grid) {
  const cells = cellsOf(grid, (key) => SPHERE_KEYS.has(key));
  const b = box(cells);
  const r = b.width / 2;
  return { cx: b.x0 + r, cy: b.y0 + r, r, box: b };
}

const distance = (cell, disc) => Math.hypot(cell.x + 0.5 - disc.cx, cell.y + 0.5 - disc.cy);

/** Why the sphere isn't round, or null: it shows whole (as tall as it is
 *  wide), every row and column of it is centred on the disc (no egg, lemon
 *  or pill), every sphere colour lies in the disc, and the disc holds
 *  nothing but the sphere. */
function roundProblem(grid) {
  const disc = sphereDisc(grid);
  if (disc.box.height !== disc.box.width) {
    return `${disc.box.width} wide but ${disc.box.height} tall`;
  }
  const sphere = cellsOf(grid, (key) => SPHERE_KEYS.has(key));
  for (const [axis, across] of [
    ['y', 'x'],
    ['x', 'y'],
  ]) {
    const centre = across === 'x' ? disc.cx : disc.cy;
    const lines = Map.groupBy(sphere, (c) => c[axis]);
    for (const [at, line] of lines) {
      const b = box(line);
      const [lo, hi] = across === 'x' ? [b.x0, b.x1] : [b.y0, b.y1];
      if ((lo + hi + 1) / 2 !== centre) return `${axis} ${at} runs ${lo} to ${hi}, off centre`;
    }
  }
  for (const cell of sphere) {
    if (distance(cell, disc) > disc.r + 0.5) return `(${cell.x}, ${cell.y}) is off the disc`;
  }
  for (const [y, row] of grid.entries()) {
    for (const [x, key] of row.entries()) {
      if (distance({ x, y }, disc) <= disc.r - 1 && !SPHERE_KEYS.has(key)) {
        return `(${x}, ${y}) inside the disc is ${key ?? 'empty'}`;
      }
    }
  }
  return null;
}

/** Why the sphere's outline isn't whole and one cell thick, or null: every
 *  cell beside the sphere is outline, and every outline cell is beside it. */
function outlineProblem(grid) {
  const at = (x, y) => grid[y]?.[x] ?? null;
  for (const { x, y } of cellsOf(grid, (key) => SPHERE_KEYS.has(key))) {
    for (const [dx, dy] of NEIGHBOURS_4) {
      const key = at(x + dx, y + dy);
      if (!SPHERE_KEYS.has(key) && key !== 'k')
        return `a gap in the outline at (${x + dx}, ${y + dy})`;
    }
  }
  for (const { x, y } of cellsOf(grid, (key) => key === 'k')) {
    if (!NEIGHBOURS_4.some(([dx, dy]) => SPHERE_KEYS.has(at(x + dx, y + dy)))) {
      return `outline (${x}, ${y}) is away from the sphere`;
    }
  }
  return null;
}

/**
 * The C ring, or null. Free-standing: no gold inside the sphere's disc or
 * touching the sphere or its outline. Close to face-on: its gold spans
 * nearly as much down as across. Round the sphere: it passes above and
 * below it, in one stroke on the left (the spine) and in two ends on the
 * right with at least two rows of clean tile between them beside the sphere
 * (the opening).
 */
function findRingC(grid) {
  const disc = sphereDisc(grid);
  const gold = cellsOf(grid, (key) => RING_KEYS.has(key));
  if (gold.length === 0) return null;
  const solid = (key) => key && (SPHERE_KEYS.has(key) || key === 'k');
  for (const { x, y } of gold) {
    if (distance({ x, y }, disc) <= disc.r + 0.5) return null;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) if (solid(grid[y + dy]?.[x + dx])) return null;
    }
  }
  const ring = box(gold);
  if (ring.height < 0.85 * ring.width || ring.width < 0.85 * ring.height) return null;
  const middle = Math.floor(disc.cx);
  if (!gold.some((c) => c.x === middle && c.y < disc.box.y0)) return null;
  if (!gold.some((c) => c.x === middle && c.y > disc.box.y1)) return null;
  const left = gold.filter((c) => c.x + 1 <= disc.cx - disc.r);
  const right = gold.filter((c) => c.x >= disc.cx + disc.r);
  if (left.length === 0 || groups(left).length !== 1) return null;
  const ends = groups(right).map(box);
  if (ends.length !== 2) return null;
  const [upper, lower] = ends.sort((a, b) => a.y0 - b.y0);
  const [x0, x1] = [Math.min(upper.x0, lower.x0), Math.max(upper.x1, lower.x1)];
  let open = 0;
  for (let y = upper.y1 + 1; y < lower.y0; y++) {
    if (grid[y].slice(x0, x1 + 1).some((key) => key && !solid(key))) return null;
    open++;
  }
  if (open < 2) return null;
  return { spine: box(left), upper, lower, open };
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

test('the orb is a whole round sphere at every size, not a pill or an egg', () => {
  for (const size of DESIGN_SIZES) assert.equal(roundProblem(designFor(size)), null, `${size} px`);
});

test('from 48 px the sphere has a whole outline one cell thick', () => {
  for (const size of [48, 64, 1024]) {
    assert.equal(outlineProblem(designFor(size)), null, `${size} px`);
  }
});

test('a free gold C stands round the sphere at every size, open on the right', () => {
  for (const size of DESIGN_SIZES) {
    const ring = findRingC(designFor(size));
    assert.ok(ring, `${size} px shows the C ring`);
    // The C's spine reaches above and below the ends of its arms' opening.
    assert.ok(ring.spine.height >= 3, `${size} px: a spine ${ring.spine.height} tall`);
    assert.ok(ring.open >= 2, `${size} px: ${ring.open} rows open`);
  }
});

test('no band splits the sphere and no button sits in its middle, at any size', () => {
  for (const size of DESIGN_SIZES) {
    assert.equal(bandProblem(designFor(size)), null, `${size} px band`);
    assert.equal(buttonProblem(designFor(size)), null, `${size} px button`);
  }
});

test('the shape checks reject a pill, an egg, a broken outline, rings that are no free C, a band and a button', () => {
  const grid = designFor(1024);
  const swap = (from, to) =>
    grid.map((row, y) => row.map((key, x) => (from({ x, y, key }) ? to : key)));
  const disc = sphereDisc(grid);
  const ring = findRingC(grid);

  const pill = grid.map((row) => row.flatMap((key) => [key, key]));
  assert.notEqual(roundProblem(pill), null, 'a pill');
  const lowerLeft = ({ x, y, key }) =>
    SPHERE_KEYS.has(key) && x + 0.5 < disc.cx - 2 && y + 0.5 > disc.cy + 2;
  assert.notEqual(roundProblem(swap(lowerLeft, 'k')), null, 'an egg, its lower left cut');
  assert.notEqual(
    outlineProblem(swap(({ x, y }) => y === disc.box.y1 + 2 && x === Math.floor(disc.cx), 'k')),
    null,
    'an outline two cells thick',
  );
  assert.equal(findRingC(swap(({ key }) => RING_KEYS.has(key), null)), null, 'no ring');
  const closed = swap(
    ({ x, y }) =>
      y > ring.upper.y1 && y < ring.lower.y0 && x >= ring.lower.x0 && x <= ring.upper.x1,
    'g',
  );
  assert.equal(findRingC(closed), null, 'a closed O');
  assert.equal(findRingC(grid.map((row) => [...row].reverse())), null, 'a mirrored C');
  const gap = ({ x, y, key }) =>
    !key && distance({ x, y }, disc) > disc.r && distance({ x, y }, disc) < disc.r + 2.5;
  assert.equal(findRingC(swap(gap, 'g')), null, 'a ring against the sphere, a crescent on it');
  const middle = Math.floor(disc.cy);
  const across = ({ x, y }) => y === middle && Math.abs(x + 0.5 - disc.cx) < disc.r;
  assert.equal(findRingC(swap(across, 'g')), null, 'a ring across the middle, a planet');
  const flat = grid.filter((_, y) => y % 3 !== 0);
  assert.equal(findRingC(flat), null, 'a ring seen edge-on');
  assert.notEqual(bandProblem(swap(across, 'k')), null, 'a dark band across the middle');
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
  const hexOf = (key) => `#${INK[key].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  for (const key of 'BbnNMRhWwGgo') {
    assert.equal(hexOf(key), sprite.palette[key].toLowerCase(), `ink ${key}`);
  }
  assert.equal(hexOf('k'), sprite.palette.K.toLowerCase(), 'one outline colour');
});

test("the sparkles wear the ring's gold and the glint's white", () => {
  assert.deepEqual(INK.Y, INK.G);
  assert.deepEqual(INK.y, INK.g);
  assert.deepEqual(INK['*'], INK.W);
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
  for (const size of [16, 48]) {
    const sparkles = cellsOf(designFor(size), (key) => SPARKLE_KEYS.has(key));
    assert.equal(sparkles.length, 0, `none at ${size} px`);
  }
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
