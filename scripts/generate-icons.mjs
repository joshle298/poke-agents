// Poke Agents app icon, drawn in code so every size is reproducible.
//
//   node scripts/generate-icons.mjs                 write every icon file
//   node scripts/generate-icons.mjs --preview <dir> also write nearest-neighbor
//                                                  previews (1024/128/32/16 px)
//
// The art is original: Poke Agents' own capsule, the one thrown, recalled and
// flown in the office (webview-ui/src/office/sprites/capsule.json), drawn
// large with a bold gold C for Conductor where that capsule has its gold
// collar. It is a horizontal pill 22 cells wide and 15 tall, with a dark
// outline: a teal cap on the left and a cream body on the right, in the
// sprite's colours. Light comes from the upper left: a rim of light and a
// two-cell glint on the cap, a lit top edge on the body, and shade along the
// bottom and the body's right end. The C is our own pixel letter, outlined so
// it reads on teal and on cream, with a lit top and left edge and a darker
// underside. Two gold sparkles sit at the upper right, and everything is on a
// macOS-style rounded square in the app's night palette.
//
// It is not a ball: the colours meet side by side, not top over bottom, with
// no band, no round button and no red, and the C is not Conductor's logo.
//
// Each size is drawn on an integer pixel grid, so edges stay crisp. 32 px and
// up draw the 32-cell design. 16 px is drawn by hand: the pill with no outline
// and the C alone on it, its inner edge dark so it stands out from the pill.
//
// Outputs (all committed; scripts/generate-icons.test.mjs fails when they
// drift from this script):
//   desktop/resources/icon.icns      macOS app icon (PNG entries, icp4..ic14)
//   desktop/resources/icon.png       1024 px master (Linux window, dev Dock icon)
//   webview-ui/public/icons/icon-{192,256,512}.png
//   webview-ui/public/apple-touch-icon.png, apple-touch-icon-precomposed.png
//                                    180 px, full-bleed (iOS rounds it itself)
//   webview-ui/public/favicon.ico    16, 32 and 48 px
//   icon.png                         128 px (package icon)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pngjs from 'pngjs';

const { PNG } = pngjs;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Palette ───────────────────────────────────────────────────
// The tile keeps the app's night blues. The capsule uses the office capsule's
// teal, cream and gold (capsule.json), plus a deeper shade of each half, a
// lit cream and the icon's own dark outline. No red and no red/white split.

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const BG_TOP = hex('#363f60');
/** Light enough that the tile's lower half still separates from a dark Dock. */
const BG_BOTTOM = hex('#202439');
const GLOW = hex('#4f6a8f');
/** A faint light line just inside the tile's edge, all the way round. */
const INNER_STROKE_ALPHA = 0.1;
/** The brighter part of that line along the top edge. */
const TOP_RIM_ALPHA = 0.2;

/** Cell colors by key. */
export const INK = {
  k: hex('#0e1a26'), // outline
  T: hex('#9af2dd'), // teal cap, lit
  t: hex('#45c9b4'), // teal cap
  d: hex('#2a9a9c'), // teal in shadow
  D: hex('#1d6c7c'), // teal in deep shadow
  P: hex('#ffffff'), // glint on the cap
  w: hex('#fffbea'), // cream body, lit
  c: hex('#fdf3d2'), // cream body
  C: hex('#e6cf9c'), // cream in shadow
  b: hex('#c4a46c'), // cream in deep shadow
  G: hex('#ffe58a'), // the C, lit
  g: hex('#f2c23a'), // the C
  o: hex('#b07a1e'), // the C in shadow
  y: hex('#f8d030'), // sparkle tips
  Y: hex('#ffe878'), // sparkle arms
  W: hex('#ffffff'), // sparkle core
};

// ── Designs ───────────────────────────────────────────────────
// A design is a square grid of cell keys covering the whole icon canvas
// (null = transparent). The rounded square behind it is drawn separately, as
// a smooth shape, at each output size. Grids are drawn by hand: '.' is empty.

const parseGrid = (rows) => rows.map((row) => [...row].map((c) => (c === '.' ? null : c)));

/**
 * The capsule on a 32-cell grid (32 px and up): a pill 22 cells wide and 15
 * tall with round ends, centred left to right and low enough for the two
 * sparkles to fit above it, clear of the tile's corner. The teal cap and the
 * cream body meet behind the C; their seam shows above and below it. The C
 * is 8 cells wide and 9 tall: a 3-cell spine, 2-cell arms and a 3-row
 * counter open to the right.
 */
const GRID_32 = parseGrid([
  '................................',
  '................................',
  '................................',
  '................................',
  '....................y....y......',
  '...................yWy...Y......',
  '....................y..yYWYy....',
  '.........................Y......',
  '.........................y......',
  '..........kkkkkkkkkkkk..........',
  '........kkPTttttwwwwwCkk........',
  '.......kTPtttkkkkkkkccCbk.......',
  '......kTttttkGGGGGGGkccCbk......',
  '......kTtttkGGggggggkccCbk......',
  '.....kTttttkGggkkkkkkcccCbk.....',
  '.....kTttttkGggkccccccccCbk.....',
  '.....ktttttkGggkccccccccCbk.....',
  '.....ktttttkGggkccccccccCbk.....',
  '.....kdttttkgggkkkkkkcccCbk.....',
  '......kdtttkggggggggkccCbk......',
  '......kDddttkoooooookCCCbk......',
  '.......kDDdddkkkkkkkCCbbk.......',
  '........kkDDDDDDbbbbbbkk........',
  '..........kkkkkkkkkkkk..........',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
]);

/** Hand-drawn 16 px design: the pill, 10 px wide and 7 tall with a pixel of
 *  tile all round, and the C alone on it, 4 px wide and 5 tall. No outline
 *  round the pill (it would melt into the dark square) and no sparkles; the
 *  C's inner edge is dark, because gold barely differs from teal and cream
 *  in lightness at this size. */
const GRID_16 = parseGrid([
  '................',
  '................',
  '................',
  '................',
  '....TTttwwcC....',
  '...TtttGGGccC...',
  '...tttGkkkccC...',
  '...tttgkccccC...',
  '...dttgkkkcCb...',
  '...ddttgggCCb...',
  '....DDddbbbb....',
  '................',
  '................',
  '................',
  '................',
  '................',
]);

/** The design drawn at a given output size. */
export function designFor(size) {
  return size <= 24 ? GRID_16 : GRID_32;
}

// ── Rendering ─────────────────────────────────────────────────

const lerp = (a, b, t) => a + (b - a) * t;

/** The rounded square: a superellipse close to the macOS icon shape, 824/1024
 *  of the canvas with an even margin. */
const BODY_FRACTION = 824 / 1024;
const SUPERELLIPSE_N = 5;
const SUPERSAMPLE = 4;
/** Sizes at or below this get no drop shadow: a blurred pixel or two reads
 *  as a grey frame on a light background. */
const NO_SHADOW_MAX_SIZE = 48;

export function bodyCoverage(size, offsetY = 0) {
  const half = (size * BODY_FRACTION) / 2;
  const c = size / 2;
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = (x + (sx + 0.5) / SUPERSAMPLE - c) / half;
          const py = (y + (sy + 0.5) / SUPERSAMPLE - c - offsetY) / half;
          if (Math.abs(px) ** SUPERELLIPSE_N + Math.abs(py) ** SUPERELLIPSE_N <= 1) hits++;
        }
      }
      out[y * size + x] = hits / (SUPERSAMPLE * SUPERSAMPLE);
    }
  }
  return out;
}

/** Three box blurs approximate a Gaussian. */
function blur(values, size, radius) {
  let src = values;
  for (let pass = 0; pass < 3; pass++) {
    const tmp = new Float32Array(size * size);
    const dst = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = Math.min(size - 1, Math.max(0, x + k));
          sum += src[y * size + xx];
        }
        tmp[y * size + x] = sum / (2 * radius + 1);
      }
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = Math.min(size - 1, Math.max(0, y + k));
          sum += tmp[yy * size + x];
        }
        dst[y * size + x] = sum / (2 * radius + 1);
      }
    }
    src = dst;
  }
  return src;
}

/** Straight-alpha "over" of one color onto the RGBA buffer at pixel i. */
function over(data, i, rgb, alpha) {
  if (alpha <= 0) return;
  const da = data[i + 3] / 255;
  const oa = alpha + da * (1 - alpha);
  for (let c = 0; c < 3; c++) {
    data[i + c] = Math.round((rgb[c] * alpha + data[i + c] * da * (1 - alpha)) / oa);
  }
  data[i + 3] = Math.round(oa * 255);
}

/**
 * How much of pixel p lies in the band `width` px wide just inside the
 * rounded square's edge (0 deep inside or outside, up to 1 on the edge).
 * `fromAbove` only counts the top edge.
 */
function edgeBand(body, size, p, width, fromAbove) {
  const x = p % size;
  const y = (p - x) / size;
  const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= size || yy >= size ? 0 : body[yy * size + xx]);
  const neighbors = fromAbove
    ? [at(x, y - width)]
    : [at(x, y - width), at(x, y + width), at(x - width, y), at(x + width, y)];
  return Math.max(0, body[p] - Math.min(...neighbors));
}

/**
 * Render the icon at `size` px as an RGBA buffer. Deterministic.
 *
 * `fullBleed` fills the whole square with the background and scales the art
 * up to match, with no rounding, shadow or edge lines: for iOS home-screen
 * icons, which the system masks itself (transparent corners would turn black).
 */
export function renderIcon(size, { fullBleed = false } = {}) {
  const data = Buffer.alloc(size * size * 4);
  const grid = designFor(size);
  const cells = grid.length;
  const body = fullBleed ? new Float32Array(size * size).fill(1) : bodyCoverage(size);

  // Where cell (cx, cy) lands. Normally the grid spans the canvas; full-bleed
  // scales it so the rounded square's area fills the canvas, keeping every
  // cell the same whole number of pixels.
  const cellPx = fullBleed ? Math.round(size / (cells * BODY_FRACTION)) : size / cells;
  const origin = fullBleed ? Math.round(size / 2 - (cells / 2) * cellPx) : 0;
  const edge = (cell) => Math.min(size, Math.max(0, Math.round(origin + cell * cellPx)));

  if (!fullBleed && size > NO_SHADOW_MAX_SIZE) {
    // Drop shadow under the rounded square.
    const shadowOffset = Math.max(1, Math.round(size * 0.012));
    const shadowRadius = Math.max(1, Math.round(size * 0.01));
    const shadow = blur(bodyCoverage(size, shadowOffset), size, shadowRadius);
    for (let p = 0; p < size * size; p++) over(data, p * 4, [0, 0, 0], shadow[p] * 0.32);
  }

  // The rounded square: a vertical gradient, a soft glow behind the capsule,
  // and a faint light line just inside the edge, brighter along the top.
  const top = fullBleed ? 0 : (size * (1 - BODY_FRACTION)) / 2;
  const span = fullBleed ? size : size * BODY_FRACTION;
  const glowX = origin + (cells / 2) * cellPx;
  const glowY = origin + (cells / 2) * cellPx;
  const glowR = cells * cellPx * 0.4;
  const lineWidth = Math.max(1, Math.round(size / 160));
  for (let y = 0; y < size; y++) {
    const t = Math.min(1, Math.max(0, (y + 0.5 - top) / span));
    const base = [0, 1, 2].map((c) => lerp(BG_TOP[c], BG_BOTTOM[c], t));
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      if (body[p] <= 0) continue;
      const d = Math.hypot(x + 0.5 - glowX, y + 0.5 - glowY) / glowR;
      const glow = d < 1 ? (1 - d) ** 2 * 0.45 : 0;
      let rgb = [0, 1, 2].map((c) => lerp(base[c], GLOW[c], glow));
      if (!fullBleed) {
        const light =
          edgeBand(body, size, p, lineWidth, false) * INNER_STROKE_ALPHA +
          (size >= 64 ? edgeBand(body, size, p, lineWidth, true) * TOP_RIM_ALPHA : 0);
        rgb = rgb.map((c) => lerp(c, 255, Math.min(1, light)));
      }
      over(data, p * 4, rgb, body[p]);
    }
  }

  // The pixel art, one integer-edged block per cell.
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const key = grid[cy][cx];
      if (!key) continue;
      const ink = INK[key];
      for (let y = edge(cy); y < edge(cy + 1); y++) {
        for (let x = edge(cx); x < edge(cx + 1); x++) over(data, (y * size + x) * 4, ink, 1);
      }
    }
  }
  return { width: size, height: size, data };
}

export function encodePng(image) {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return PNG.sync.write(png, { colorType: 6 });
}

/** Nearest-neighbor upscale, for looking at small sizes. */
export function upscale(image, factor) {
  const size = image.width * factor;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (Math.floor(y / factor) * image.width + Math.floor(x / factor)) * 4;
      image.data.copy(data, (y * size + x) * 4, src, src + 4);
    }
  }
  return { width: size, height: size, data };
}

// ── Containers ────────────────────────────────────────────────

/**
 * ICNS entries, each a PNG: `[type, pixel size]`. The @2x types (ic11-ic14,
 * ic10) hold the same pixels as the next size up, as iconutil writes them.
 */
export const ICNS_ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

/** An Apple Icon Image file: 'icns', total length, a TOC, then each entry
 *  (4-byte type, 4-byte length including the 8-byte header, PNG data). All
 *  integers big-endian. */
export function buildIcns(entries) {
  const blocks = entries.map(([type, png]) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const toc = Buffer.alloc(8 + entries.length * 8);
  toc.write('TOC ', 0, 'ascii');
  toc.writeUInt32BE(toc.length, 4);
  entries.forEach(([type, png], i) => {
    toc.write(type, 8 + i * 8, 'ascii');
    toc.writeUInt32BE(png.length + 8, 12 + i * 8);
  });
  const body = Buffer.concat([toc, ...blocks]);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

/** A Windows .ico with PNG-compressed entries (every current browser reads them). */
export function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach(({ size, png }, i) => {
    const at = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, at);
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt8(0, at + 2);
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}

// ── Outputs ───────────────────────────────────────────────────

/** iOS home-screen icon size (iPhone @3x). */
const TOUCH_ICON_SIZE = 180;

/** Every committed icon file, as repo-relative path → bytes. */
export function buildOutputs() {
  const pngCache = new Map();
  const png = (size) => {
    if (!pngCache.has(size)) pngCache.set(size, encodePng(renderIcon(size)));
    return pngCache.get(size);
  };
  const touchIcon = encodePng(renderIcon(TOUCH_ICON_SIZE, { fullBleed: true }));
  return new Map([
    [
      'desktop/resources/icon.icns',
      buildIcns(ICNS_ENTRIES.map(([type, size]) => [type, png(size)])),
    ],
    ['desktop/resources/icon.png', png(1024)],
    ['webview-ui/public/icons/icon-192.png', png(192)],
    ['webview-ui/public/icons/icon-256.png', png(256)],
    ['webview-ui/public/icons/icon-512.png', png(512)],
    ['webview-ui/public/apple-touch-icon.png', touchIcon],
    ['webview-ui/public/apple-touch-icon-precomposed.png', touchIcon],
    [
      'webview-ui/public/favicon.ico',
      buildIco([16, 32, 48].map((size) => ({ size, png: png(size) }))),
    ],
    ['icon.png', png(128)],
  ]);
}

/** Previews for review: each size scaled up with nearest-neighbor to ~512 px
 *  on a light and a dark backdrop, plus the 1024 master as is. */
function writePreviews(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const size of [1024, 128, 32, 16]) {
    const image = renderIcon(size);
    const big = size >= 512 ? image : upscale(image, Math.round(512 / size));
    fs.writeFileSync(path.join(dir, `icon-${size}.png`), encodePng(onBackdrops(big)));
  }
}

/** The icon twice, side by side: on light grey and on near-black. */
function onBackdrops(image) {
  const pad = Math.round(image.width / 16);
  const w = image.width * 2 + pad * 3;
  const h = image.height + pad * 2;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dark = x >= w / 2;
      data.fill(dark ? 0x1e : 0xec, i, i + 3);
      data[i + 3] = 255;
    }
  }
  for (const [ox, oy] of [
    [pad, pad],
    [pad * 2 + image.width, pad],
  ]) {
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const s = (y * image.width + x) * 4;
        const d = ((y + oy) * w + (x + ox)) * 4;
        over(
          data,
          d,
          [image.data[s], image.data[s + 1], image.data[s + 2]],
          image.data[s + 3] / 255,
        );
      }
    }
  }
  return { width: w, height: h, data };
}

function main() {
  for (const [rel, bytes] of buildOutputs()) {
    const file = path.join(REPO_ROOT, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    console.log(`wrote ${rel} (${bytes.length} bytes)`);
  }
  const previewAt = process.argv.indexOf('--preview');
  if (previewAt !== -1 && process.argv[previewAt + 1]) {
    writePreviews(path.resolve(process.argv[previewAt + 1]));
    console.log(`wrote previews to ${process.argv[previewAt + 1]}`);
  }
}

// Run only when executed, not when the test imports it.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
