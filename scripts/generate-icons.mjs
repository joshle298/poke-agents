// Poke Agents app icon, drawn in code so every size is reproducible.
//
//   node scripts/generate-icons.mjs                 write every icon file
//   node scripts/generate-icons.mjs --preview <dir> also write nearest-neighbor
//                                                  previews (1024/128/32/16 px)
//
// The art is original: a pixel capsule (red top, white bottom, dark band)
// whose center button is a tiny terminal showing `>_`, with a sparkle, on a
// macOS-style rounded square in the app's palette. It copies no official
// Pokémon art or logo. Each size is drawn on an integer pixel grid, so edges
// stay crisp; 16 and 32 px use simplified hand-tuned grids.
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
// The app's Pokémon theme (webview-ui/src/index.css): night-dark #1a1c2c,
// accent red #dc0a2d, dialog white #f8f8f0, panel slate, status green/yellow.

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const BG_TOP = hex('#323c5a');
const BG_BOTTOM = hex('#161927');
const GLOW = hex('#5a6a96');

/** Cell colors by key. */
const INK = {
  k: hex('#12141f'), // outline, band, button ring, prompt
  r: hex('#dc0a2d'), // capsule red
  R: hex('#98081f'), // red in shadow
  p: hex('#ff6b7d'), // red highlight
  P: hex('#fff4f0'), // specular glint
  w: hex('#f8f8f0'), // capsule white
  s: hex('#bcc6d6'), // white in shadow
  S: hex('#7f8ba6'), // white in deep shadow
  y: hex('#f8d030'), // sparkle tips
  Y: hex('#ffe878'), // sparkle arms
  W: hex('#ffffff'), // sparkle core
};

// ── Designs ───────────────────────────────────────────────────
// A design is a square grid of cell keys covering the whole icon canvas
// (null = transparent). The rounded square behind it is drawn separately, as
// a smooth shape, at each output size.

function emptyGrid(n) {
  return Array.from({ length: n }, () => Array(n).fill(null));
}

/**
 * The capsule on a 32-cell grid, centered on cell (15, 16), 19 cells across,
 * lit from the upper left. `detail` prints `>_` on the button and adds a
 * second sparkle; without it (the 32 px icon) the button is a plain white dot.
 */
function capsuleGrid({ detail }) {
  const n = 32;
  const grid = emptyGrid(n);
  const cx = 15;
  const cy = 16;
  const radius = 9.5;
  const inBall = (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!inBall(x, y)) continue;
      const dx = x - cx;
      const dy = y - cy;
      const edge = !inBall(x - 1, y) || !inBall(x + 1, y) || !inBall(x, y - 1) || !inBall(x, y + 1);
      if (edge || Math.abs(dy) <= 1) {
        grid[y][x] = 'k';
        continue;
      }
      // How far out (0 center .. 1 rim) and how much the cell faces away from
      // the light (toward the lower right).
      const d = Math.hypot(dx, dy);
      const rim = d / radius;
      const away = (dx * 0.6 + dy * 0.8) / d;
      if (dy < 0) grid[y][x] = rim > 0.74 && away > -0.25 ? 'R' : 'r';
      else if (rim > 0.8 && away > 0.55) grid[y][x] = 'S';
      else if (rim > 0.66 && away > 0.2) grid[y][x] = 's';
      else grid[y][x] = 'w';
    }
  }

  // The button: a dark ring that joins the band around a white disc. The
  // detailed design prints a terminal prompt, `>_`, on it.
  const ring = detail ? 4.6 : 3.2;
  const white = detail ? 3.6 : 2.2;
  for (let y = cy - 5; y <= cy + 5; y++) {
    for (let x = cx - 5; x <= cx + 5; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= white) grid[y][x] = !detail && x - cx + (y - cy) >= 2 ? 's' : 'w';
      else if (d <= ring) grid[y][x] = 'k';
    }
  }
  if (detail) {
    for (const [dx, dy] of [
      [-2, -1],
      [-1, 0],
      [-2, 1],
      [1, 1],
      [2, 1],
    ]) {
      grid[cy + dy][cx + dx] = 'k';
    }
  }

  // Glint on the red cap.
  const glint = detail
    ? [
        ['p', -6, -4],
        ['p', -5, -5],
        ['p', -4, -6],
        ['p', -6, -3],
        ['P', -5, -4],
        ['P', -4, -5],
      ]
    : [
        ['p', -5, -4],
        ['P', -4, -5],
      ];
  for (const [key, dx, dy] of glint) grid[cy + dy][cx + dx] = key;

  // Sparkles at the upper right: a four-point star that brightens toward
  // its middle, and in the detailed design a small one beside it.
  const star = (sx, sy, arm) => {
    for (let i = -arm; i <= arm; i++) {
      const key = Math.abs(i) === arm ? 'y' : 'Y';
      grid[sy][sx + i] = key;
      grid[sy + i][sx] = key;
    }
    grid[sy][sx] = 'W';
  };
  star(24, 7, 2);
  if (detail) star(26, 12, 1);
  return grid;
}

/** Hand-drawn 16 px design: the same capsule, reduced to what 16 px can show.
 *  No outline: at this size it would melt into the dark square. */
const GRID_16 = [
  '................',
  '................',
  '......rrrr......',
  '....rrPrrrrr....',
  '...rrprrrrrrR...',
  '...rrrrrrrrRR...',
  '..rrrrkkkkrrRR..',
  '..kkkkkwwkkkkk..',
  '..kkkkkwskkkkk..',
  '..wwwwkkkkwwss..',
  '...wwwwwwwwss...',
  '...wwwwwwwsss...',
  '....ssssssss....',
  '......SSSS......',
  '................',
  '................',
].map((row) => [...row].map((c) => (c === '.' ? null : c)));

const DESIGNS = {
  small: GRID_16,
  medium: capsuleGrid({ detail: false }),
  large: capsuleGrid({ detail: true }),
};

/** The design drawn at a given output size. */
export function designFor(size) {
  if (size <= 24) return DESIGNS.small;
  if (size <= 48) return DESIGNS.medium;
  return DESIGNS.large;
}

// ── Rendering ─────────────────────────────────────────────────

function normalize(v) {
  const len = Math.hypot(...v);
  return v.map((c) => c / len);
}

const lerp = (a, b, t) => a + (b - a) * t;

/** The rounded square: a superellipse close to the macOS icon shape, 824/1024
 *  of the canvas with an even margin. */
const BODY_FRACTION = 824 / 1024;
const SUPERELLIPSE_N = 5;
const SUPERSAMPLE = 4;

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
 * Render the icon at `size` px as an RGBA buffer. Deterministic.
 *
 * `fullBleed` fills the whole square with the background and scales the art
 * up to match, with no rounding or shadow: for iOS home-screen icons, which
 * the system masks itself (transparent corners would turn black).
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

  if (!fullBleed) {
    // Drop shadow under the rounded square.
    const shadowOffset = Math.max(1, Math.round(size * 0.012));
    const shadowRadius = Math.max(1, Math.round(size * 0.01));
    const shadow = blur(bodyCoverage(size, shadowOffset), size, shadowRadius);
    for (let p = 0; p < size * size; p++) over(data, p * 4, [0, 0, 0], shadow[p] * 0.32);
  }

  // The rounded square: a vertical gradient, a soft glow behind the capsule
  // and, from 64 px up, a faint light edge along the top.
  const top = fullBleed ? 0 : (size * (1 - BODY_FRACTION)) / 2;
  const span = fullBleed ? size : size * BODY_FRACTION;
  const glowX = origin + (15.5 / 32) * cells * cellPx;
  const glowY = origin + (16.5 / 32) * cells * cellPx;
  const glowR = cells * cellPx * 0.38;
  const edgeShift = Math.max(1, Math.round(size / 160));
  for (let y = 0; y < size; y++) {
    const t = Math.min(1, Math.max(0, (y + 0.5 - top) / span));
    const base = [0, 1, 2].map((c) => lerp(BG_TOP[c], BG_BOTTOM[c], t));
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      if (body[p] <= 0) continue;
      const d = Math.hypot(x + 0.5 - glowX, y + 0.5 - glowY) / glowR;
      const glow = d < 1 ? (1 - d) ** 2 * 0.45 : 0;
      let rgb = [0, 1, 2].map((c) => lerp(base[c], GLOW[c], glow));
      if (size >= 64 && !fullBleed) {
        const above = y - edgeShift >= 0 ? body[(y - edgeShift) * size + x] : 0;
        const rim = Math.max(0, body[p] - above);
        rgb = rgb.map((c) => lerp(c, 255, rim * 0.18));
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
