/**
 * A tiny pixel canvas for drawing the world's art in code. Colors are
 * [r, g, b, a] arrays; `null` means transparent. Everything is integer pixel
 * math with no randomness except the seeded `rng` below, so the generator
 * writes byte-identical PNGs on every run.
 */
import { PNG } from 'pngjs';

/** '#RRGGBB' (+ optional alpha 0..255) → [r, g, b, a]. */
export function hex(color, alpha = 255) {
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

/** A gray level 0..255 as an opaque color (floors are grayscale patterns). */
export function gray(level, alpha = 255) {
  return [level, level, level, alpha];
}

/** Mulberry32: a small seeded PRNG. Same seed, same sequence. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4);
  }

  has(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  get(x, y) {
    if (!this.has(x, y)) return null;
    const i = (y * this.w + x) * 4;
    if (this.data[i + 3] === 0) return null;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  opaque(x, y) {
    return this.get(x, y) !== null;
  }

  set(x, y, c) {
    if (!this.has(x, y)) return;
    const i = (y * this.w + x) * 4;
    if (!c) {
      this.data[i] = this.data[i + 1] = this.data[i + 2] = this.data[i + 3] = 0;
      return;
    }
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = c[3] ?? 255;
  }

  /** Set with wrap-around coordinates (seamless floor tiles). */
  setWrap(x, y, c) {
    this.set(((x % this.w) + this.w) % this.w, ((y % this.h) + this.h) % this.h, c);
  }

  getWrap(x, y) {
    return this.get(((x % this.w) + this.w) % this.w, ((y % this.h) + this.h) % this.h);
  }

  rect(x, y, w, h, c) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c);
    return this;
  }

  hline(x0, x1, y, c) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, c);
    return this;
  }

  vline(x, y0, y1, c) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) this.set(x, y, c);
    return this;
  }

  /** Fill every pixel whose center satisfies `test(x + 0.5, y + 0.5, x, y)`. */
  fillWhere(test, c) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (test(x + 0.5, y + 0.5, x, y)) this.set(x, y, typeof c === 'function' ? c(x, y) : c);
      }
    }
    return this;
  }

  ellipse(cx, cy, rx, ry, c) {
    return this.fillWhere((px, py) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1, c);
  }

  disc(cx, cy, r, c) {
    return this.ellipse(cx, cy, r, r, c);
  }

  /** Pixel rows from a string matrix: one char per pixel, mapped by `palette`
   *  (a space or '.' is transparent unless the palette names it). */
  pattern(x, y, rows, palette) {
    rows.forEach((line, dy) => {
      [...line].forEach((ch, dx) => {
        if (ch in palette) this.set(x + dx, y + dy, palette[ch]);
      });
    });
    return this;
  }

  /** Add a 1px outline of color `c` on transparent pixels touching opaque ones
   *  (4-neighborhood; `diagonal` adds corners). Only pixels for which
   *  `where(x, y)` holds are outlined. */
  outline(c, { diagonal = false, where = () => true } = {}) {
    const marks = [];
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    if (diagonal) dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.opaque(x, y) || !where(x, y)) continue;
        if (dirs.some(([dx, dy]) => this.opaque(x + dx, y + dy))) marks.push([x, y]);
      }
    }
    for (const [x, y] of marks) this.set(x, y, c);
    return this;
  }

  /** Recolor opaque pixels: `fn(color, x, y)` returns a color (or the same). */
  recolor(fn) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const c = this.get(x, y);
        if (c) this.set(x, y, fn(c, x, y));
      }
    }
    return this;
  }

  /** Draw another canvas on top (transparent pixels skipped). */
  blit(src, dx, dy, { flipX = false } = {}) {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const c = src.get(flipX ? src.w - 1 - x : x, y);
        if (c) this.set(dx + x, dy + y, c);
      }
    }
    return this;
  }

  clone() {
    const out = new Canvas(this.w, this.h);
    out.data.set(this.data);
    return out;
  }

  png() {
    const png = new PNG({ width: this.w, height: this.h });
    png.data.set(this.data);
    return PNG.sync.write(png, { colorType: 6 });
  }
}

/**
 * Shade a round volume lit from the top-left: returns the palette index for
 * a pixel at (px, py) in a sphere of radius r centered at (cx, cy). The
 * palette runs dark → light; the bands stay crisp (no dithering), which is
 * what reads as hand-placed pixel shading at 1×.
 */
export function sphereShade(px, py, cx, cy, r, steps, bias = 0) {
  const nx = (px - cx) / r;
  const ny = (py - cy) / r;
  const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  // Light from the upper left, slightly toward the viewer.
  const lx = -0.55;
  const ly = -0.65;
  const lz = 0.52;
  const lambert = Math.max(0, nx * lx + ny * ly + nz * lz) + bias;
  const idx = Math.floor(lambert * steps);
  return Math.max(0, Math.min(steps - 1, idx));
}
