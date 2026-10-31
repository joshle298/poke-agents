/**
 * The Pokémon Town's art, drawn in code: grayscale floor patterns (colorized
 * per tile by the office), and full-color furniture. All original: shapes are
 * built from discs, ellipses and hand-placed pixel rows, shaded with a
 * top-left light, outlined with soft darks — a GBA-era look without copying
 * any game's tiles, sprites or palettes.
 */
import { Canvas, gray, hex, rng, sphereShade } from './pixels.mjs';

/** Alpha that marks a floor pixel as foreground (drawn over characters in it).
 *  Mirrors FLOOR_FOREGROUND_ALPHA in webview-ui/src/constants.ts. */
export const FOREGROUND_ALPHA = 254;
/** Mirrors FLOOR_FOREGROUND_BELOW_ROW: foreground rows from here down cover the
 *  occupant of the tile below. */
export const FOREGROUND_BELOW_ROW = 12;

// ── Palettes (dark → light) ──────────────────────────────────

const LEAF = ['#1F4F2B', '#2A6B35', '#3A8A3F', '#58A947', '#86C95A', '#B5E27A'].map((c) => hex(c));
const LEAF_OUT = hex('#173A22');
const PINE = ['#163F2E', '#1E5638', '#2A6F43', '#3D8A4E', '#62A95E'].map((c) => hex(c));
const BARK = ['#3E2716', '#5C3B22', '#7C522F', '#9E6C3E'].map((c) => hex(c));
const BARK_OUT = hex('#2B1A0E');
const WOOD = ['#6E4424', '#93603A', '#B9824F', '#DBA86F', '#F0CC94'].map((c) => hex(c));
const WOOD_OUT = hex('#3A2414');
const STONE = ['#4E5562', '#6C7484', '#8E97A6', '#B4BCC8', '#DCE2EA'].map((c) => hex(c));
const STONE_OUT = hex('#2C313B');
const WATER = ['#1E4D8A', '#2A68AE', '#3E86CC', '#68AEE6', '#A9D6F6', '#EAF7FF'].map((c) => hex(c));
const METAL = ['#2E333F', '#454C5C', '#646D80', '#8C95A8', '#C2C9D6'].map((c) => hex(c));
const SHADOW = hex('#123018', 72);
const SHADOW_SOFT = hex('#123018', 44);
const CREAM = ['#B9AE9C', '#D8CFBF', '#EEE8DC', '#FBF8F1'].map((c) => hex(c));
const RED = ['#7C1F2A', '#B3303A', '#DA4B4B', '#F07B70', '#FBB3A6'].map((c) => hex(c));
const TEAL = ['#164A50', '#1F6D72', '#2E9A98', '#55C6B9', '#A5EEDB'].map((c) => hex(c));
const YELLOW = ['#9A6A12', '#D6A021', '#F2C94C', '#FBE58A', '#FFF7D1'].map((c) => hex(c));
const BLUE = ['#1D3A78', '#2B57A6', '#4377CF', '#73A2EA', '#B5D3FA'].map((c) => hex(c));
const INK = hex('#2A2430');
const WHITE = hex('#FFFFFF');

// ── Floors (16×16 grayscale, seamless) ───────────────────────

/** Short dark strokes with a light tip: the grass texture, wrapped. */
function grassMarks(c, seed, count, dark, light) {
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const x = Math.floor(r() * 16);
    const y = Math.floor(r() * 16);
    const shape = Math.floor(r() * 3);
    if (shape === 0) {
      // a "v" of two blades
      c.setWrap(x, y, dark);
      c.setWrap(x + 2, y, dark);
      c.setWrap(x + 1, y + 1, dark);
      c.setWrap(x, y - 1, light);
      c.setWrap(x + 2, y - 1, light);
    } else if (shape === 1) {
      // a single blade
      c.setWrap(x, y, dark);
      c.setWrap(x, y + 1, dark);
      c.setWrap(x, y - 1, light);
    } else {
      // a tuft
      c.setWrap(x, y, dark);
      c.setWrap(x + 1, y, dark);
      c.setWrap(x - 1, y - 1, light);
      c.setWrap(x + 2, y - 1, light);
    }
  }
}

export function grassFloor() {
  const c = new Canvas(16, 16).rect(0, 0, 16, 16, gray(150));
  grassMarks(c, 11, 7, gray(118), gray(176));
  return c;
}

export function grassFloorSpeckled() {
  const c = new Canvas(16, 16).rect(0, 0, 16, 16, gray(150));
  grassMarks(c, 23, 4, gray(118), gray(176));
  // clover dots: pale specks with a darker heart
  const dots = [
    [3, 4],
    [11, 10],
    [7, 13],
  ];
  for (const [x, y] of dots) {
    c.setWrap(x, y, gray(206));
    c.setWrap(x + 1, y, gray(196));
    c.setWrap(x, y + 1, gray(188));
    c.setWrap(x + 1, y + 1, gray(130));
  }
  return c;
}

/**
 * Tall grass: a tuft of pointed, outlined blades per tile. A tuft's tips poke
 * into rows 12-15 and its body fills rows 0-9 of the tile below (the pattern
 * wraps). Foreground pixels (alpha 254): rows 0-9 entirely, the bodies in
 * front of a character standing here, and rows 12-15 (solid from 14, the
 * blade tips above that), which cover the lower body of whoever stands on
 * the tile below.
 */
export function tallGrassFloor() {
  const c = new Canvas(16, 16).rect(0, 0, 16, 16, gray(104));
  const blade = new Set();
  // [tip x, tip y, base left x, base right x]; y runs 12..25 (25 = row 9 below).
  const blades = [
    [2, 13, -1, 5],
    [13, 13, 10, 16],
    [7, 12, 4, 10],
    [4, 17, 1, 8],
    [11, 18, 8, 14],
  ];
  const baseY = 25;
  for (const [tx, ty, bl, br] of blades) {
    const mask = new Set();
    for (let y = ty; y <= baseY; y++) {
      const t = (y - ty) / (baseY - ty);
      const left = Math.round(tx + (bl - tx) * Math.min(1, t * 1.6));
      const right = Math.round(tx + (br - tx) * Math.min(1, t * 1.6));
      for (let x = left; x <= right; x++) mask.add(`${x},${y}`);
    }
    // outline first (over whatever is behind), then the fill
    for (const key of mask) {
      const [x, y] = key.split(',').map(Number);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, -1],
      ]) {
        const k = `${x + dx},${y + dy}`;
        if (mask.has(k) || y + dy < ty - 1) continue;
        c.setWrap(x + dx, y + dy, gray(52));
        blade.add(`${(((x + dx) % 16) + 16) % 16},${(y + dy) % 16}`);
      }
    }
    for (const key of mask) {
      const [x, y] = key.split(',').map(Number);
      const t = (y - ty) / (baseY - ty);
      const left = Math.round(tx + (bl - tx) * Math.min(1, t * 1.6));
      const right = Math.round(tx + (br - tx) * Math.min(1, t * 1.6));
      const u = right === left ? 0 : (x - left) / (right - left);
      let level = u < 0.34 ? 204 : u < 0.67 ? 164 : 128;
      if (y === ty) level = 220;
      c.setWrap(x, y, gray(level));
      blade.add(`${((x % 16) + 16) % 16},${y % 16}`);
    }
  }
  // Foreground: rows 0..9 and 14..15 entirely, rows 12..13 wherever a blade
  // is (the jagged tips).
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const inBody = y <= 9 || y >= 14;
      const inTips = y >= FOREGROUND_BELOW_ROW && blade.has(`${x},${y}`);
      if (!inBody && !inTips) continue;
      const px = c.get(x, y);
      c.set(x, y, [px[0], px[1], px[2], FOREGROUND_ALPHA]);
    }
  }
  return c;
}

export function dirtPathFloor() {
  const c = new Canvas(16, 16).rect(0, 0, 16, 16, gray(172));
  const r = rng(41);
  for (let i = 0; i < 6; i++) {
    const x = Math.floor(r() * 16);
    const y = Math.floor(r() * 16);
    // a pebble: light top-left, dark bottom-right
    c.setWrap(x, y, gray(204));
    c.setWrap(x + 1, y, gray(188));
    c.setWrap(x, y + 1, gray(150));
    c.setWrap(x + 1, y + 1, gray(132));
  }
  for (let i = 0; i < 7; i++) {
    c.setWrap(Math.floor(r() * 16), Math.floor(r() * 16), gray(154));
  }
  return c;
}

export function cobbleFloor() {
  const c = new Canvas(16, 16).rect(0, 0, 16, 16, gray(110));
  // Four rounded stones per tile, offset rows so the seams stagger.
  const stones = [
    { x: 0, y: 0, w: 8, h: 8 },
    { x: 8, y: 0, w: 8, h: 8 },
    { x: 4, y: 8, w: 8, h: 8 },
    { x: 12, y: 8, w: 8, h: 8 },
  ];
  for (const s of stones) {
    for (let y = 1; y < s.h - 1; y++) {
      for (let x = 1; x < s.w - 1; x++) {
        const corner = (x === 1 || x === s.w - 2) && (y === 1 || y === s.h - 2);
        if (corner) continue;
        let level = 168;
        if (y === 1 || x === 1) level = 196;
        if (y === s.h - 2 || x === s.w - 2) level = 140;
        c.setWrap(s.x + x, s.y + y, gray(level));
      }
    }
  }
  return c;
}

// ── Helpers for round, shaded volumes ────────────────────────

/** Fill a union of discs, each shaded as its own sphere (later discs in front). */
function puffs(c, discs, palette, { bias = 0, seed = 1, speckle = 0 } = {}) {
  const r = rng(seed);
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      let owner = null;
      for (const d of discs) {
        const ry = d[3] ?? d[2];
        if (((x + 0.5 - d[0]) / d[2]) ** 2 + ((y + 0.5 - d[1]) / ry) ** 2 <= 1) owner = d;
      }
      if (!owner) continue;
      const idx = sphereShade(x + 0.5, y + 0.5, owner[0], owner[1], owner[2], palette.length, bias);
      c.set(x, y, palette[idx]);
    }
  }
  // Leafy speckles: a few light pixels on the lit half, dark ones on the shade.
  for (let i = 0; i < speckle; i++) {
    const x = Math.floor(r() * c.w);
    const y = Math.floor(r() * c.h);
    const px = c.get(x, y);
    if (!px) continue;
    const idx = palette.findIndex((p) => p[0] === px[0] && p[1] === px[1] && p[2] === px[2]);
    if (idx < 0) continue;
    if (idx >= palette.length - 3 && idx < palette.length - 1) c.set(x, y, palette[idx + 1]);
    else if (idx > 0 && idx <= 2) c.set(x, y, palette[idx - 1]);
  }
}

// ── Outdoor furniture ────────────────────────────────────────

/** A round broadleaf tree, 2×2 tiles: canopy over the top row (walk-behind). */
export function tree() {
  const c = new Canvas(32, 32);
  c.ellipse(16.5, 28.5, 12, 3.3, SHADOW);
  // trunk with a root flare
  c.rect(13, 20, 6, 8, BARK[1]);
  c.rect(13, 20, 2, 8, BARK[2]);
  c.rect(17, 20, 2, 8, BARK[0]);
  c.rect(12, 26, 8, 2, BARK[1]);
  c.set(12, 26, BARK[2]);
  c.set(19, 27, BARK[0]);
  const canopy = new Canvas(32, 32);
  puffs(
    canopy,
    [
      [16, 9.5, 10],
      [10, 7, 6],
      [22, 7, 6],
      [7.5, 14, 6.5],
      [24.5, 14, 6.5],
      [12, 17, 6.5],
      [20, 17, 6.5],
      [16, 12, 7],
    ],
    LEAF,
    { bias: 0.08, seed: 7, speckle: 70 },
  );
  canopy.outline(LEAF_OUT);
  c.outline(BARK_OUT, { where: (x, y) => y >= 20 });
  c.blit(canopy, 0, 0);
  return c;
}

/** A conifer, 2×3 tiles: three tiers over a short trunk. */
export function pineTree() {
  const c = new Canvas(32, 48);
  c.ellipse(16.5, 44.5, 10, 2.8, SHADOW);
  c.rect(14, 37, 4, 7, BARK[1]);
  c.rect(14, 37, 1, 7, BARK[2]);
  c.rect(17, 37, 1, 7, BARK[0]);
  c.outline(BARK_OUT, { where: (x, y) => y >= 37 });
  const crown = new Canvas(32, 48);
  const tiers = [
    { top: 1, bottom: 16, half: 8 },
    { top: 9, bottom: 27, half: 12 },
    { top: 18, bottom: 39, half: 15 },
  ];
  for (const t of tiers) {
    for (let y = t.top; y <= t.bottom; y++) {
      const k = (y - t.top) / (t.bottom - t.top);
      const half = Math.max(1, Math.round(t.half * k));
      for (let x = 16 - half; x < 16 + half; x++) {
        const u = (x - (16 - half)) / (2 * half); // 0 left .. 1 right
        let idx = u < 0.25 ? 4 : u < 0.5 ? 3 : u < 0.78 ? 2 : 1;
        if (y > t.bottom - 3) idx = Math.max(0, idx - 1);
        crown.set(x, y, PINE[idx]);
      }
    }
  }
  crown.outline(hex('#0F2A1F'));
  c.blit(crown, 0, 0);
  return c;
}

/** A slim cypress, 1×2 tiles: the crown is walk-behind, the trunk blocks. */
export function cypress() {
  const c = new Canvas(16, 32);
  c.ellipse(8.5, 29.5, 5, 1.8, SHADOW);
  c.rect(7, 25, 2, 4, BARK[1]);
  c.set(7, 25, BARK[2]);
  c.outline(BARK_OUT, { where: (x, y) => y >= 25 });
  const crown = new Canvas(16, 32);
  crown.fillWhere(
    (px, py) => ((px - 8) / 6) ** 2 + ((py - 14.5) / 12.5) ** 2 <= 1,
    (x, y) => PINE[sphereShade(x + 0.5, y + 0.5, 7.5, 12, 7, PINE.length, 0.12)],
  );
  // layered fronds: short dark strokes down the shaded side
  for (const y of [8, 13, 18, 22]) {
    crown.hline(9, 12, y, PINE[1]);
    crown.set(8, y - 1, PINE[3]);
  }
  crown.outline(hex('#0F2A1F'));
  c.blit(crown, 0, 0);
  return c;
}

/** A round shrub, one tile, blocking. */
export function bush() {
  const c = new Canvas(16, 16);
  c.ellipse(8.5, 13.5, 6.5, 2.2, SHADOW);
  const leaves = new Canvas(16, 16);
  puffs(
    leaves,
    [
      [8, 8, 5.5],
      [4.5, 10, 3.6],
      [11.5, 10, 3.6],
      [8, 11, 4],
    ],
    LEAF.slice(1),
    { bias: 0.1, seed: 3, speckle: 18 },
  );
  leaves.outline(LEAF_OUT);
  c.blit(leaves, 0, 0);
  return c;
}

/** A small flower: four petals around a center, darker rim. */
function flower(c, x, y, petals, center) {
  const p = [
    [0, -1],
    [-1, 0],
    [1, 0],
    [0, 1],
  ];
  for (const [dx, dy] of p) c.set(x + dx, y + dy, petals[2]);
  c.set(x - 1, y - 1, petals[3]);
  c.set(x, y, center);
  c.set(x + 1, y + 1, petals[1]);
}

/** A patch of flowers on the grass, walkable (characters step over it). */
export function flowers() {
  const c = new Canvas(16, 16);
  const stem = LEAF[2];
  const spots = [
    { x: 3, y: 4, petals: RED, center: YELLOW[3] },
    { x: 11, y: 3, petals: YELLOW, center: hex('#E07A2E') },
    { x: 7, y: 9, petals: RED, center: YELLOW[3] },
    { x: 13, y: 11, petals: YELLOW, center: hex('#E07A2E') },
    { x: 3, y: 13, petals: YELLOW, center: hex('#E07A2E') },
  ];
  for (const s of spots) {
    c.set(s.x, s.y + 2, stem);
    c.set(s.x - 1, s.y + 3, LEAF[3]);
    c.set(s.x + 1, s.y + 2, LEAF[3]);
  }
  for (const s of spots) flower(c, s.x, s.y, s.petals, s.center);
  // a dark rim under each bloom reads as shade on the grass
  c.outline(hex('#2D5A2A', 150), { where: (x, y) => c.opaque(x, y - 1) });
  return c;
}

/** Wildflowers: white daisies and violet bells, walkable. */
export function wildflowers() {
  const c = new Canvas(16, 16);
  const VIOLET = ['#4B2E7A', '#6A43A8', '#8E66D1', '#B79AF0', '#E0D2FF'].map((x) => hex(x));
  const DAISY = ['#8E8A80', '#C9C4B8', '#F4F1EA', '#FFFFFF', '#FFFFFF'].map((x) => hex(x));
  const spots = [
    { x: 4, y: 3, petals: DAISY, center: YELLOW[2] },
    { x: 12, y: 5, petals: VIOLET, center: VIOLET[4] },
    { x: 8, y: 10, petals: DAISY, center: YELLOW[2] },
    { x: 2, y: 12, petals: VIOLET, center: VIOLET[4] },
    { x: 13, y: 13, petals: DAISY, center: YELLOW[2] },
  ];
  for (const s of spots) {
    c.set(s.x, s.y + 2, LEAF[2]);
    c.set(s.x + 1, s.y + 3, LEAF[3]);
    c.set(s.x - 1, s.y + 2, LEAF[3]);
  }
  for (const s of spots) flower(c, s.x, s.y, s.petals, s.center);
  c.outline(hex('#2D5A2A', 150), { where: (x, y) => c.opaque(x, y - 1) });
  return c;
}

/** Wooden fence, horizontal run: rails cross the whole tile so runs connect. */
export function fenceFront() {
  const c = new Canvas(16, 16);
  c.rect(0, 13, 16, 2, SHADOW_SOFT);
  for (const y of [5, 9]) {
    c.hline(0, 15, y - 1, WOOD_OUT);
    c.hline(0, 15, y, WOOD[3]);
    c.hline(0, 15, y + 1, WOOD[1]);
    c.hline(0, 15, y + 2, WOOD_OUT);
  }
  // the post
  c.rect(6, 2, 4, 12, WOOD[2]);
  c.vline(6, 2, 13, WOOD[3]);
  c.vline(9, 2, 13, WOOD[1]);
  c.hline(6, 9, 2, WOOD[4]);
  c.vline(5, 2, 13, WOOD_OUT);
  c.vline(10, 2, 13, WOOD_OUT);
  c.hline(5, 10, 1, WOOD_OUT);
  c.hline(5, 10, 14, WOOD_OUT);
  return c;
}

/** Wooden fence, vertical run: the rail seen from above, a post at the middle. */
export function fenceSide() {
  const c = new Canvas(16, 16);
  c.rect(10, 0, 2, 16, SHADOW_SOFT);
  c.vline(6, 0, 15, WOOD_OUT);
  c.vline(7, 0, 15, WOOD[3]);
  c.vline(8, 0, 15, WOOD[1]);
  c.vline(9, 0, 15, WOOD_OUT);
  c.rect(5, 3, 6, 9, WOOD[2]);
  c.hline(5, 10, 3, WOOD[4]);
  c.vline(5, 3, 11, WOOD[3]);
  c.vline(10, 4, 11, WOOD[1]);
  c.hline(5, 10, 11, WOOD[0]);
  c.outline(WOOD_OUT, { where: (x, y) => y >= 2 && y <= 12 });
  return c;
}

/** A wooden signpost, 1×2 tiles: the board is walk-behind, the post blocks. */
export function signpost() {
  const c = new Canvas(16, 32);
  c.ellipse(8.5, 29.5, 4.5, 1.6, SHADOW);
  c.rect(7, 18, 2, 11, WOOD[1]);
  c.vline(7, 18, 28, WOOD[2]);
  c.outline(WOOD_OUT, { where: (x, y) => y >= 19 });
  const board = new Canvas(16, 32);
  board.rect(1, 9, 14, 10, WOOD[3]);
  board.hline(1, 14, 9, WOOD[4]);
  board.vline(1, 9, 18, WOOD[4]);
  board.hline(2, 14, 18, WOOD[1]);
  board.vline(14, 10, 18, WOOD[2]);
  // carved lines of text
  board.hline(3, 11, 12, WOOD[0]);
  board.hline(3, 9, 15, WOOD[0]);
  board.outline(WOOD_OUT);
  c.blit(board, 0, 0);
  return c;
}

/** A street lamp, 1×2 tiles: the lantern is walk-behind, the base blocks. */
export function lampPost() {
  const c = new Canvas(16, 32);
  c.ellipse(8.5, 29.5, 4, 1.5, SHADOW);
  // base
  c.rect(5, 26, 6, 3, METAL[1]);
  c.hline(5, 10, 26, METAL[3]);
  // pole
  c.rect(7, 10, 2, 16, METAL[2]);
  c.vline(7, 10, 25, METAL[3]);
  // lantern
  c.rect(4, 4, 8, 6, YELLOW[3]);
  c.rect(5, 5, 2, 2, YELLOW[4]);
  c.rect(10, 6, 1, 3, YELLOW[2]);
  c.hline(3, 12, 3, METAL[2]);
  c.hline(4, 11, 2, METAL[3]);
  c.hline(6, 9, 1, METAL[2]);
  c.hline(4, 11, 10, METAL[1]);
  c.vline(4, 4, 9, METAL[1]);
  c.vline(11, 4, 9, METAL[1]);
  c.outline(METAL[0]);
  return c;
}

/** A boulder, one tile, blocking. */
export function rock() {
  const c = new Canvas(16, 16);
  c.ellipse(8.5, 13, 6.5, 2.2, SHADOW);
  const body = new Canvas(16, 16);
  body.fillWhere(
    (px, py) => ((px - 8) / 6) ** 2 + ((py - 9.5) / 4.6) ** 2 <= 1,
    (x, y) => STONE[sphereShade(x + 0.5, y + 0.5, 7.2, 8.5, 6.3, STONE.length, 0.1)],
  );
  body.set(6, 7, STONE[4]);
  body.set(5, 8, STONE[4]);
  body.hline(9, 11, 12, STONE[0]);
  body.outline(STONE_OUT);
  c.blit(body, 0, 0);
  return c;
}

/** A park bench, 2×1 tiles: slatted back and seat on iron legs. */
export function parkBench() {
  const c = new Canvas(32, 16);
  c.rect(3, 13, 26, 2, SHADOW_SOFT);
  const b = new Canvas(32, 16);
  // legs and arms
  for (const x of [3, 27]) {
    b.rect(x, 2, 2, 12, METAL[1]);
    b.vline(x, 2, 13, METAL[2]);
  }
  // back slats
  for (const y of [2, 5]) {
    b.rect(2, y, 28, 2, WOOD[2]);
    b.hline(2, 29, y, WOOD[3]);
  }
  // seat
  b.rect(2, 8, 28, 3, WOOD[2]);
  b.hline(2, 29, 8, WOOD[4]);
  b.hline(2, 29, 10, WOOD[1]);
  b.outline(WOOD_OUT);
  c.blit(b, 0, 0);
  return c;
}

/** Pond water and banks, 5×3 tiles, blocking. `frame` shifts the ripples. */
export function pond(frame) {
  const c = new Canvas(80, 48);
  const inside = (px, py, inset) => {
    const x0 = 3 + inset;
    const x1 = 77 - inset;
    const y0 = 4 + inset;
    const y1 = 45 - inset;
    const r = 12 - inset;
    if (px < x0 || px > x1 || py < y0 || py > y1) return false;
    const cx = px < x0 + r ? x0 + r : px > x1 - r ? x1 - r : px;
    const cy = py < y0 + r ? y0 + r : py > y1 - r ? y1 - r : py;
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
  };
  // soft bank shadow, then a mossy lip, then water
  c.fillWhere((px, py) => inside(px, py + 1, -1), SHADOW_SOFT);
  c.fillWhere((px, py) => inside(px, py, 0), hex('#3E7D3C'));
  c.fillWhere((px, py) => inside(px, py, 2), WATER[1]);
  c.fillWhere((px, py) => inside(px, py, 3) && !inside(px, py - 3, 3), WATER[0]);
  c.fillWhere((px, py) => inside(px, py, 3) && inside(px, py - 3, 3), WATER[2]);
  c.fillWhere((px, py) => inside(px, py, 3) && !inside(px, py + 2, 3), WATER[3]);
  // ripples: short light strokes, drifting one pixel per frame
  const r = rng(91);
  for (let i = 0; i < 16; i++) {
    const x = 10 + Math.floor(r() * 58);
    const y = 12 + Math.floor(r() * 26);
    const len = 3 + Math.floor(r() * 4);
    const phase = (Math.floor(r() * 3) + frame) % 3;
    const shift = phase - 1;
    for (let k = 0; k < len; k++) {
      const px = x + k + shift;
      if (!inside(px + 0.5, y + 0.5, 4)) continue;
      c.set(px, y, k === 0 || k === len - 1 ? WATER[3] : WATER[4]);
    }
    if (phase === 1 && inside(x + 2.5, y - 0.5, 4)) c.set(x + 2, y - 1, WATER[5]);
  }
  // lily pads
  for (const [x, y, rad] of [
    [18, 32, 3.2],
    [24, 36, 2.6],
    [60, 18, 3],
  ]) {
    c.fillWhere(
      (px, py) =>
        ((px - x) / rad) ** 2 + ((py - y) / (rad * 0.75)) ** 2 <= 1 &&
        !(px > x && Math.abs(py - y) < 0.8),
      (px, py) => (px < x && py < y ? LEAF[4] : LEAF[3]),
    );
  }
  c.set(18, 31, RED[3]);
  c.set(17, 31, RED[2]);
  c.set(18, 30, RED[4]);
  c.outline(hex('#24502C'));
  return c;
}

// ── Pokémon Center and Lab furniture ─────────────────────────

/**
 * The front (south) wall of a building, one tile high so it never hides the
 * room behind it. Drawn in the wall sheet's own grays: placed with a
 * `colorize` color equal to the building's wall color, it matches the walls.
 */
export function lowWall() {
  const c = new Canvas(16, 16);
  const DARK = [48, 42, 40, 255];
  c.rect(0, 0, 16, 16, gray(255));
  c.hline(0, 15, 0, DARK);
  c.hline(0, 15, 4, gray(202));
  c.hline(0, 15, 14, gray(202));
  c.hline(0, 15, 15, DARK);
  return c;
}

/** A service counter, 4×2 tiles (a desk: things stand on its top). */
export function counter() {
  const c = new Canvas(64, 32);
  // top surface, as deep as a desk's so a PC fits on it
  c.rect(1, 9, 62, 13, CREAM[2]);
  c.hline(1, 62, 9, CREAM[3]);
  c.hline(1, 62, 21, CREAM[1]);
  // front panel: red with a cream stripe
  c.rect(1, 22, 62, 9, RED[2]);
  c.hline(1, 62, 22, RED[3]);
  c.rect(1, 25, 62, 2, CREAM[2]);
  c.hline(1, 62, 30, RED[1]);
  for (let x = 16; x < 64; x += 16) c.vline(x, 23, 29, RED[1]);
  c.outline(INK);
  return c;
}

/** The healing machine, 2×2 tiles, stands on the counter. */
export function healingMachine() {
  const c = new Canvas(32, 32);
  const body = new Canvas(32, 32);
  // housing
  body.rect(3, 6, 26, 15, CREAM[2]);
  body.hline(3, 28, 6, CREAM[3]);
  body.rect(3, 18, 26, 3, CREAM[1]);
  // three capsule bays
  for (const [x, glass] of [
    [9, RED],
    [16, TEAL],
    [23, RED],
  ]) {
    body.disc(x, 12, 3.2, METAL[2]);
    body.disc(x, 12, 2.3, glass[3]);
    body.set(x - 1, 11, WHITE);
  }
  // status strip
  body.rect(6, 17, 20, 2, TEAL[0]);
  body.hline(8, 15, 17, TEAL[4]);
  // cross emblem on a little sign on top
  body.rect(13, 1, 6, 5, WHITE);
  body.rect(15, 2, 2, 3, RED[2]);
  body.rect(14, 3, 4, 1, RED[2]);
  body.outline(INK);
  c.blit(body, 0, 0);
  return c;
}

/** A research terminal, 2×2 tiles: screen, dials and a sample tube. */
export function labMachine() {
  const c = new Canvas(32, 32);
  c.ellipse(16.5, 29.5, 13, 2, SHADOW_SOFT);
  const m = new Canvas(32, 32);
  m.rect(2, 4, 28, 24, METAL[2]);
  m.rect(2, 4, 28, 2, METAL[3]);
  m.vline(2, 4, 27, METAL[3]);
  m.rect(2, 24, 28, 4, METAL[1]);
  // screen
  m.rect(5, 8, 13, 9, TEAL[0]);
  m.hline(6, 15, 10, TEAL[3]);
  m.hline(6, 12, 12, TEAL[2]);
  m.hline(6, 14, 14, TEAL[3]);
  m.set(16, 9, TEAL[4]);
  // lights
  for (const [x, col] of [
    [6, RED[3]],
    [9, YELLOW[3]],
    [12, TEAL[4]],
  ]) {
    m.set(x, 20, col);
    m.set(x + 1, 20, col);
  }
  // sample tube
  m.rect(21, 7, 6, 16, BLUE[4]);
  m.rect(22, 12, 4, 10, TEAL[3]);
  m.vline(22, 8, 21, WHITE);
  m.hline(20, 27, 6, METAL[1]);
  m.hline(20, 27, 23, METAL[1]);
  m.outline(METAL[0]);
  c.blit(m, 0, 0);
  return c;
}

/** Wall sign for the Pokémon Center: a red plate with a white cross. */
export function centerSign() {
  const c = new Canvas(32, 16);
  c.rect(2, 3, 28, 10, RED[2]);
  c.hline(2, 29, 3, RED[3]);
  c.hline(2, 29, 12, RED[1]);
  c.rect(14, 4, 4, 8, WHITE);
  c.rect(12, 6, 8, 4, WHITE);
  c.outline(INK);
  return c;
}

/** Wall sign for the Lab: a blue plate with a flask. */
export function labSign() {
  const c = new Canvas(32, 16);
  c.rect(2, 3, 28, 10, BLUE[2]);
  c.hline(2, 29, 3, BLUE[3]);
  c.hline(2, 29, 12, BLUE[1]);
  c.pattern(12, 4, ['  ww  ', '  ww  ', ' wwww ', 'wwttww', 'wttttw', 'wwwwww'], {
    w: WHITE,
    t: TEAL[3],
  });
  c.outline(INK);
  return c;
}

// ── Carpets (auto-tiled, two colors) ─────────────────────────

/**
 * A path as a carpet variant: the office auto-tiles carpets with marching
 * squares (16 junction pieces in a 4×4 sheet, case N at col N%4, row N/4;
 * corners NW=1, NE=2, SE=4, SW=8), so painted paths get rounded corners and a
 * rim where they meet the grass. Two colors only (the renderer recolors the
 * darkest as the carpet's color and the lightest as its accent): the rim and
 * pebbles are dark, the fill is light.
 */
export function pathCarpet() {
  const sheet = new Canvas(64, 64);
  const FILL = gray(200);
  const RIM = gray(120);
  const R = 6.5; // corner radius, px
  // Quadrants around the junction point (8, 8): bit, x range, y range, corner.
  const quads = [
    { bit: 1, x0: 0, y0: 0, cx: 8 - R, cy: 8 - R, sides: [2, 8] },
    { bit: 2, x0: 8, y0: 0, cx: 8 + R, cy: 8 - R, sides: [1, 4] },
    { bit: 4, x0: 8, y0: 8, cx: 8 + R, cy: 8 + R, sides: [2, 8] },
    { bit: 8, x0: 0, y0: 8, cx: 8 - R, cy: 8 + R, sides: [1, 4] },
  ];
  // Pebbles at fixed spots per quadrant, so every tile shows the same pattern.
  const pebbles = [
    [3, 3],
    [12, 6],
    [6, 13],
  ];
  for (let msCase = 0; msCase < 16; msCase++) {
    const piece = new Canvas(16, 16);
    const inside = (x, y) => {
      if (x < 0 || y < 0 || x > 15 || y > 15) return null; // beyond the piece: unknown
      const q = quads.find((qq) => x >= qq.x0 && x < qq.x0 + 8 && y >= qq.y0 && y < qq.y0 + 8);
      const on = (msCase & q.bit) !== 0;
      const sidesOn = q.sides.filter((b) => (msCase & b) !== 0).length;
      const px = x + 0.5;
      const py = y + 0.5;
      // The square between the arc's center and the junction point.
      const inCornerBox = (px - q.cx) * (8 - q.cx) >= 0 && (py - q.cy) * (8 - q.cy) >= 0;
      const outsideArc = Math.hypot(px - q.cx, py - q.cy) > R;
      // Convex corner (alone in its row and column): round it off.
      if (on && sidesOn === 0) return !(inCornerBox && outsideArc);
      // Concave corner (both neighbors on): fill a fillet into the gap.
      if (!on && sidesOn === 2) return inCornerBox && outsideArc;
      return on;
    };
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (!inside(x, y)) continue;
        const edge = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => inside(x + dx, y + dy) === false);
        piece.set(x, y, edge ? RIM : FILL);
      }
    }
    for (const [x, y] of pebbles) {
      if (piece.get(x, y) && piece.get(x + 1, y) && inside(x + 1, y + 1)) {
        piece.set(x, y, RIM);
      }
    }
    sheet.blit(piece, (msCase % 4) * 16, Math.floor(msCase / 4) * 16);
  }
  return sheet;
}
