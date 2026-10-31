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
/** Conifers use the same greens as the broadleaf trees, one step darker. */
const CONIFER = LEAF.slice(0, 5);
const BARK = ['#3E2716', '#5C3B22', '#7C522F', '#9E6C3E'].map((c) => hex(c));
const BARK_OUT = hex('#2B1A0E');
const WOOD = ['#6E4424', '#93603A', '#B9824F', '#DBA86F', '#F0CC94'].map((c) => hex(c));
const WOOD_OUT = hex('#3A2414');
const STONE = ['#4E5562', '#6C7484', '#8E97A6', '#B4BCC8', '#DCE2EA'].map((c) => hex(c));
const STONE_OUT = hex('#2C313B');
const WATER = ['#1E4D8A', '#2A68AE', '#3E86CC', '#68AEE6', '#A9D6F6', '#EAF7FF'].map((c) => hex(c));
const METAL = ['#2E333F', '#454C5C', '#646D80', '#8C95A8', '#C2C9D6'].map((c) => hex(c));
const MOSS = ['#2E6B31', '#3F8238', '#4F9A41'].map((c) => hex(c));
const EARTH = ['#4A3420', '#6B4C2E', '#7A4A26'].map((c) => hex(c));
const MAT = ['#5E2A1E', '#8E4430', '#B8673F', '#DB9461'].map((c) => hex(c));
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
 * Tall-grass variants: two staggered courses of blades per tile (an 8 px
 * rhythm, so no band runs along every 16 px row), each blade as
 * [center x, tip y]. The upper course is rooted at row 8, the lower at the
 * tile's bottom; every blade stays inside its tile, so neighboring tiles of
 * different variants never cut one in two.
 */
const TALL_GRASS_VARIANTS = [
  {
    upper: [
      [2, 1],
      [6, 0],
      [10, 2],
      [14, 1],
    ],
    lower: [
      [0, 9],
      [4, 10],
      [8, 8],
      [12, 9],
    ],
  },
  {
    upper: [
      [1, 0],
      [5, 2],
      [9, 1],
      [13, 1],
    ],
    lower: [
      [3, 10],
      [7, 8],
      [11, 9],
      [15, 10],
    ],
  },
  {
    upper: [
      [3, 2],
      [7, 1],
      [11, 0],
      [15, 2],
    ],
    lower: [
      [1, 8],
      [5, 10],
      [9, 9],
      [13, 8],
    ],
  },
];
export const TALL_GRASS_VARIANT_COUNT = TALL_GRASS_VARIANTS.length;

/**
 * Tall grass: pointed, shaded blades in two staggered courses, lit from the
 * top left, with a dark line only along the upper sides and tips (the bases
 * melt into the shade between blades). Variants move the blades sideways; the
 * town picks one per tile.
 *
 * Foreground pixels (alpha 254), drawn again in front of characters: rows
 * 2-11 entirely and the blades of rows 0-1 cover the lower body of a
 * character standing here (feet sit at about row 7); the blades of rows
 * 12-15 cover the next few pixels of whoever stands on the tile below.
 */
export function tallGrassFloor(variant = 0) {
  const c = new Canvas(16, 16).rect(0, 0, 16, 16, gray(100));
  const blade = new Set();
  const put = (x, y, level) => {
    if (x < 0 || x > 15 || y < 0 || y > 15) return;
    c.set(x, y, gray(level));
    blade.add(`${x},${y}`);
  };
  const course = (blades, baseY) => {
    for (const [cx, ty] of blades) {
      // a dark tip cap and dark upper sides
      put(cx, ty - 1, 64);
      for (let y = ty; y <= baseY; y++) {
        const half = Math.min(2, Math.floor((y - ty + 1) / 2));
        if (y - ty <= 3) {
          put(cx - half - 1, y, 84);
          put(cx + half + 1, y, 56);
        }
        for (let x = cx - half; x <= cx + half; x++) {
          let level = x < cx ? 200 : x === cx ? 164 : 128;
          if (y === ty) level = 220;
          if (y >= baseY - 1) level -= 24;
          put(x, y, level);
        }
      }
    }
  };
  const v = TALL_GRASS_VARIANTS[variant];
  course(v.upper, 8);
  course(v.lower, 15);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const own = y >= 2 && y < FOREGROUND_BELOW_ROW;
      if (!own && !blade.has(`${x},${y}`)) continue;
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

/**
 * A trunk drawn on its own layer and outlined there, so the outline never
 * rings the ground shadow under it (the shadow stays a flat soft ellipse).
 */
function trunkLayer(w, h, draw) {
  const t = new Canvas(w, h);
  draw(t);
  t.outline(BARK_OUT);
  return t;
}

/** A round broadleaf tree, 2×2 tiles: canopy over the top row (walk-behind). */
export function tree() {
  const c = new Canvas(32, 32);
  c.ellipse(16.5, 28.5, 12, 3.3, SHADOW);
  c.blit(
    trunkLayer(32, 32, (t) => {
      // trunk with a root flare
      t.rect(13, 20, 6, 8, BARK[1]);
      t.rect(13, 20, 2, 8, BARK[2]);
      t.rect(17, 20, 2, 8, BARK[0]);
      t.rect(12, 26, 8, 2, BARK[1]);
      t.set(12, 26, BARK[2]);
      t.set(19, 27, BARK[0]);
    }),
    0,
    0,
  );
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
  c.blit(canopy, 0, 0);
  return c;
}

/**
 * A tall broadleaf tree, 2×3 tiles: a three-tier crown over a short trunk.
 * Taller than the PMD sprites that walk past it, so a forest edge of these
 * keeps its scale; the top two rows are walk-behind.
 */
export function tallTree() {
  const c = new Canvas(32, 48);
  c.ellipse(16.5, 44.5, 12.5, 3.2, SHADOW);
  c.blit(
    trunkLayer(32, 48, (t) => {
      t.rect(13, 33, 6, 11, BARK[1]);
      t.rect(13, 33, 2, 11, BARK[2]);
      t.rect(17, 33, 2, 11, BARK[0]);
      t.rect(12, 42, 8, 2, BARK[1]);
      t.set(12, 42, BARK[2]);
      t.set(19, 43, BARK[0]);
      // a knot
      t.set(15, 38, BARK[0]);
      t.set(16, 38, BARK[0]);
    }),
    0,
    0,
  );
  const crown = new Canvas(32, 48);
  puffs(
    crown,
    [
      // top tier
      [16, 8, 7.5],
      [11, 11.5, 5.5],
      [21, 11.5, 5.5],
      // middle tier
      [7.5, 19.5, 6],
      [24.5, 19.5, 6],
      [16, 17, 9],
      // bottom tier
      [5.5, 28, 5],
      [26.5, 28, 5],
      [10.5, 30.5, 6.5],
      [21.5, 30.5, 6.5],
      [16, 27, 8.5],
    ],
    LEAF,
    { bias: 0.08, seed: 19, speckle: 110 },
  );
  crown.outline(LEAF_OUT);
  c.blit(crown, 0, 0);
  return c;
}

/** A conifer, 2×3 tiles: three tiers over a short trunk. */
export function pineTree() {
  const c = new Canvas(32, 48);
  c.ellipse(16.5, 44.5, 10, 2.8, SHADOW);
  c.blit(
    trunkLayer(32, 48, (t) => {
      t.rect(14, 37, 4, 7, BARK[1]);
      t.rect(14, 37, 1, 7, BARK[2]);
      t.rect(17, 37, 1, 7, BARK[0]);
    }),
    0,
    0,
  );
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
        crown.set(x, y, CONIFER[idx]);
      }
    }
  }
  crown.outline(LEAF_OUT);
  c.blit(crown, 0, 0);
  return c;
}

/** A slim cypress, 1×2 tiles: the crown is walk-behind, the trunk blocks. */
export function cypress() {
  const c = new Canvas(16, 32);
  c.ellipse(8.5, 29.5, 5, 1.8, SHADOW);
  c.blit(
    trunkLayer(16, 32, (t) => {
      t.rect(7, 25, 2, 4, BARK[1]);
      t.set(7, 25, BARK[2]);
    }),
    0,
    0,
  );
  const crown = new Canvas(16, 32);
  crown.fillWhere(
    (px, py) => ((px - 8) / 6) ** 2 + ((py - 14.5) / 12.5) ** 2 <= 1,
    (x, y) => CONIFER[sphereShade(x + 0.5, y + 0.5, 7.5, 12, 7, CONIFER.length, 0.12)],
  );
  // layered fronds: short dark strokes down the shaded side
  for (const y of [8, 13, 18, 22]) {
    crown.hline(9, 12, y, CONIFER[1]);
    crown.set(8, y - 1, CONIFER[3]);
  }
  crown.outline(LEAF_OUT);
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
  const f = new Canvas(16, 16);
  f.vline(6, 0, 15, WOOD_OUT);
  f.vline(7, 0, 15, WOOD[3]);
  f.vline(8, 0, 15, WOOD[1]);
  f.vline(9, 0, 15, WOOD_OUT);
  f.rect(5, 3, 6, 9, WOOD[2]);
  f.hline(5, 10, 3, WOOD[4]);
  f.vline(5, 3, 11, WOOD[3]);
  f.vline(10, 4, 11, WOOD[1]);
  f.hline(5, 10, 11, WOOD[0]);
  f.outline(WOOD_OUT, { where: (x, y) => y >= 2 && y <= 12 });
  c.blit(f, 0, 0);
  return c;
}

/** A wooden signpost, 1×2 tiles: the board is walk-behind, the post blocks. */
export function signpost() {
  const c = new Canvas(16, 32);
  c.ellipse(8.5, 29.5, 4.5, 1.6, SHADOW);
  const post = new Canvas(16, 32);
  post.rect(7, 18, 2, 11, WOOD[1]);
  post.vline(7, 18, 28, WOOD[2]);
  post.outline(WOOD_OUT);
  c.blit(post, 0, 0);
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
  const lamp = new Canvas(16, 32);
  // base
  lamp.rect(5, 26, 6, 3, METAL[1]);
  lamp.hline(5, 10, 26, METAL[3]);
  // pole
  lamp.rect(7, 10, 2, 16, METAL[2]);
  lamp.vline(7, 10, 25, METAL[3]);
  // lantern
  lamp.rect(4, 4, 8, 6, YELLOW[3]);
  lamp.rect(5, 5, 2, 2, YELLOW[4]);
  lamp.rect(10, 6, 1, 3, YELLOW[2]);
  lamp.hline(3, 12, 3, METAL[2]);
  lamp.hline(4, 11, 2, METAL[3]);
  lamp.hline(6, 9, 1, METAL[2]);
  lamp.hline(4, 11, 10, METAL[1]);
  lamp.vline(4, 4, 9, METAL[1]);
  lamp.vline(11, 4, 9, METAL[1]);
  lamp.outline(METAL[0]);
  c.blit(lamp, 0, 0);
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

/**
 * A pond, 5×3 tiles, blocking: an irregular shoreline (three overlapping
 * lobes), a mossy lip, the far bank's earth wall, water that lightens toward
 * the near shore, stones on the bank and reeds at two edges. `frame` shifts
 * the ripples (the ambient shimmer).
 */
export function pond(frame) {
  const c = new Canvas(80, 48);
  const lobes = [
    [37, 24, 29, 15.5],
    [58, 18.5, 16.5, 12],
    [20, 29, 15.5, 11.5],
  ];
  const inside = (px, py, inset) =>
    lobes.some(
      ([cx, cy, rx, ry]) => ((px - cx) / (rx - inset)) ** 2 + ((py - cy) / (ry - inset)) ** 2 <= 1,
    );
  const water = (px, py) => inside(px, py, 2);
  // the shadow the near bank casts on the grass, under everything
  c.fillWhere((px, py) => inside(px, py - 1.5, -0.5) && !inside(px, py, 0), SHADOW_SOFT);

  const p = new Canvas(80, 48);
  // mossy lip, darker where it turns away from the light
  p.fillWhere(
    (px, py) => inside(px, py, 0),
    (x, y) => (inside(x + 0.5 - 1, y + 0.5 - 1, 0) ? MOSS[1] : MOSS[2]),
  );
  // the far bank's wall: earth showing between the lip and the water
  p.fillWhere((px, py) => water(px, py) && !water(px, py - 3), EARTH[1]);
  p.fillWhere((px, py) => water(px, py) && !water(px, py - 1), EARTH[0]);
  // water: deeper (darker) under the far bank, lighter toward the near shore
  p.fillWhere(
    (px, py) => water(px, py) && water(px, py - 3),
    (x, y) => {
      if (!water(x + 0.5, y + 0.5 + 2)) return WATER[3];
      if (!water(x + 0.5, y + 0.5 - 6)) return WATER[1];
      return WATER[2];
    },
  );
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
      if (!inside(px + 0.5, y + 0.5, 5) || !inside(px + 0.5, y - 3.5, 2)) continue;
      p.set(px, y, k === 0 || k === len - 1 ? WATER[3] : WATER[4]);
    }
    if (phase === 1 && inside(x + 2.5, y - 0.5, 5)) p.set(x + 2, y - 1, WATER[5]);
  }
  // lily pads
  for (const [x, y, rad] of [
    [18, 33, 3.2],
    [25, 36, 2.6],
    [58, 21, 3],
  ]) {
    p.fillWhere(
      (px, py) =>
        ((px - x) / rad) ** 2 + ((py - y) / (rad * 0.75)) ** 2 <= 1 &&
        !(px > x && Math.abs(py - y) < 0.8),
      (px, py) => (px < x && py < y ? LEAF[4] : LEAF[3]),
    );
  }
  p.set(18, 32, RED[3]);
  p.set(17, 32, RED[2]);
  p.set(18, 31, RED[4]);
  // stones on the bank
  for (const [x, y, w] of [
    [6, 31, 4],
    [44, 39, 5],
    [70, 26, 4],
    [33, 7, 3],
  ]) {
    p.fillWhere(
      (px, py) => ((px - x - w / 2) / (w / 2)) ** 2 + ((py - y - 1.5) / 1.8) ** 2 <= 1,
      (px, py) => STONE[sphereShade(px + 0.5, py + 0.5, x + w / 2 - 0.6, y + 1, w / 2, 4, 0.15)],
    );
  }
  // reeds: a few blades with cattail heads at the far-left and near-right edges
  for (const [x, y, h, head] of [
    [10, 20, 7, true],
    [12, 19, 9, false],
    [14, 21, 6, true],
    [64, 32, 7, true],
    [66, 30, 9, true],
    [68, 33, 5, false],
  ]) {
    p.vline(x, y - h, y, LEAF[2]);
    p.set(x, y - h, LEAF[4]);
    p.set(x - 1, y - 1, LEAF[3]);
    if (head) {
      p.vline(x, y - h + 1, y - h + 3, EARTH[2]);
      p.set(x, y - h, LEAF[3]);
    }
  }
  p.outline(hex('#24502C'));
  c.blit(p, 0, 0);
  return c;
}

// ── Pokémon Center and Lab furniture ─────────────────────────

/**
 * A building's front (south) wall, one tile high so it never hides the room
 * behind it: a façade seen from outside, with a cap, a plinth and, in the
 * window variant, a small window. Light grays so it reads as a wall in the
 * editor palette; the town colorizes it (`colorize: true`) with its
 * building's wall color, brightness raised by LOW_WALL_BRIGHTNESS_LIFT so the
 * face matches the walls' (whose face is pure white).
 */
export function lowWall({ window = false } = {}) {
  const c = new Canvas(16, 16);
  const DARK = gray(20);
  c.rect(0, 0, 16, 16, gray(216));
  c.hline(0, 15, 0, DARK);
  c.hline(0, 15, 1, gray(240));
  c.hline(0, 15, 2, gray(184));
  c.hline(0, 15, 3, gray(160));
  c.hline(0, 15, 12, gray(186));
  c.rect(0, 13, 16, 2, gray(156));
  c.hline(0, 15, 15, DARK);
  if (window) {
    c.rect(4, 5, 8, 6, gray(92));
    c.rect(5, 6, 6, 4, gray(246));
    c.rect(5, 8, 6, 2, gray(214));
    c.vline(8, 6, 9, gray(132));
    c.set(5, 6, gray(255));
    c.set(6, 6, gray(255));
    c.hline(3, 12, 11, gray(234));
  }
  return c;
}

/**
 * Brightness to add to a wall color so LOW_WALL's face (gray 216) colorizes
 * like a wall's white face at contrast -50: 200 × (0.75 − (0.5 + 0.347 / 2)).
 */
export const LOW_WALL_BRIGHTNESS_LIFT = 15;

/**
 * A roof edge for a building's back wall: a wall item whose top rows cover
 * the top face of the wall tile it hangs on, so the back wall reads as a
 * roofline from outside. Grays, colorized by the town like the walls (a
 * darker shade). Every row is background, so it stacks over the wall and the
 * wall items there without blocking them.
 */
export function roofTrim() {
  const c = new Canvas(16, 32);
  c.hline(0, 15, 0, gray(20));
  c.hline(0, 15, 1, gray(214));
  c.rect(0, 2, 16, 4, gray(150));
  // two staggered courses of shingles
  for (const [y, offset] of [
    [3, 0],
    [5, 2],
  ]) {
    c.hline(0, 15, y, gray(118));
    for (let x = offset; x < 16; x += 4) {
      c.set(x, y - 1, gray(118));
      c.set(x + 1, y - 1, gray(176));
    }
  }
  c.hline(0, 15, 6, gray(92));
  c.hline(0, 15, 7, gray(20));
  return c;
}

/** A woven doormat, 2×1 tiles, walkable (characters step over it). */
export function doormat() {
  const c = new Canvas(32, 16);
  const m = new Canvas(32, 16);
  m.rect(1, 3, 30, 10, MAT[1]);
  m.rect(3, 5, 26, 6, MAT[2]);
  for (let y = 5; y <= 10; y++) {
    for (let x = 3; x <= 28; x++) if ((x + y) % 3 === 0) m.set(x, y, MAT[1]);
  }
  m.hline(1, 30, 3, MAT[3]);
  m.hline(1, 30, 12, MAT[0]);
  m.outline(hex('#3A1A12'));
  c.blit(m, 0, 0);
  return c;
}

/** The Pokémon Center's floor: large soft tiles and a light grout line, low
 *  contrast so a resting Pokémon reads clearly on it. */
export function centerTileFloor() {
  const c = new Canvas(16, 16).rect(0, 0, 16, 16, gray(226));
  c.hline(0, 15, 15, gray(198));
  c.vline(15, 0, 15, gray(198));
  c.hline(0, 14, 0, gray(236));
  c.vline(0, 0, 14, gray(236));
  return c;
}

/**
 * A Pokémon Center bed, 2×1 tiles, walkable: a fainted Pokémon rests on it.
 * White sheet and pillow, a red blanket. `pillow` is the side the head goes.
 */
export function centerBed(pillow = 'left') {
  const b = new Canvas(32, 16);
  b.rect(0, 2, 32, 13, METAL[3]);
  b.hline(0, 31, 14, METAL[2]);
  b.rect(1, 3, 30, 10, CREAM[3]);
  // pillow
  b.rect(2, 4, 7, 8, WHITE);
  b.hline(3, 7, 11, CREAM[1]);
  b.vline(8, 5, 10, CREAM[1]);
  b.set(3, 6, CREAM[2]);
  for (const [x, y] of [
    [2, 4],
    [8, 4],
    [2, 11],
    [8, 11],
  ]) {
    b.set(x, y, CREAM[3]);
  }
  // the sheet folded back over the blanket, then the blanket
  b.rect(10, 3, 2, 10, CREAM[2]);
  b.vline(10, 3, 12, WHITE);
  b.rect(12, 3, 19, 10, RED[2]);
  b.hline(12, 30, 3, RED[3]);
  b.hline(12, 30, 12, RED[1]);
  b.vline(21, 4, 11, RED[1]);
  b.set(16, 6, RED[3]);
  b.set(25, 8, RED[3]);
  b.outline(INK);
  const c = new Canvas(32, 16);
  c.rect(1, 15, 30, 1, SHADOW_SOFT);
  c.blit(b, 0, 0, { flipX: pillow === 'right' });
  return c;
}

/**
 * The professor's desk, 4×2 tiles (a desk: things stand on it), for the
 * Lab's lectern: a Lead stands behind it, facing the room. Papers, an open
 * book, a stack of books and a brass name plate on the front.
 */
export function professorDesk() {
  const c = new Canvas(64, 32);
  c.rect(3, 30, 58, 2, SHADOW_SOFT);
  const d = new Canvas(64, 32);
  // top surface
  d.rect(1, 8, 62, 12, WOOD[1]);
  d.hline(1, 62, 8, WOOD[2]);
  d.hline(1, 62, 19, WOOD[0]);
  // front panel: two drawers and a name plate
  d.rect(1, 20, 62, 10, WOOD[0]);
  d.hline(1, 62, 20, WOOD[1]);
  for (const x of [5, 47]) {
    d.rect(x, 22, 12, 6, WOOD[1]);
    d.hline(x, x + 11, 22, WOOD[2]);
    d.set(x + 5, 25, YELLOW[3]);
    d.set(x + 6, 25, YELLOW[2]);
  }
  d.rect(25, 23, 14, 4, YELLOW[1]);
  d.hline(25, 38, 23, YELLOW[3]);
  d.hline(27, 36, 25, YELLOW[0]);
  // papers, slightly askew
  d.rect(6, 10, 10, 8, CREAM[3]);
  d.rect(8, 9, 10, 8, WHITE);
  for (const y of [11, 13, 15]) d.hline(10, 16, y, CREAM[0]);
  // an open book
  d.rect(40, 10, 14, 8, CREAM[3]);
  d.vline(47, 10, 17, CREAM[0]);
  d.hline(41, 45, 12, CREAM[1]);
  d.hline(41, 45, 14, CREAM[1]);
  d.hline(49, 53, 12, CREAM[1]);
  d.rect(40, 17, 14, 1, BLUE[1]);
  // a stack of books
  d.rect(22, 13, 10, 3, RED[2]);
  d.rect(23, 10, 9, 3, TEAL[2]);
  d.rect(22, 7, 10, 3, YELLOW[2]);
  d.hline(22, 31, 13, RED[3]);
  d.hline(23, 31, 10, TEAL[3]);
  d.hline(22, 31, 7, YELLOW[3]);
  d.outline(WOOD_OUT);
  c.blit(d, 0, 0);
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

/**
 * A standing sign board on two posts, 2×2 tiles: the board row is walk-behind
 * (it may hang over a building's front wall), the posts block. `emblem`
 * paints the plate.
 */
function signBoard(plate, emblem) {
  const c = new Canvas(32, 32);
  c.ellipse(7.5, 29.5, 3.5, 1.3, SHADOW);
  c.ellipse(24.5, 29.5, 3.5, 1.3, SHADOW);
  const posts = new Canvas(32, 32);
  for (const x of [6, 23]) {
    posts.rect(x, 14, 3, 15, WOOD[1]);
    posts.vline(x, 14, 28, WOOD[2]);
  }
  posts.outline(WOOD_OUT);
  c.blit(posts, 0, 0);
  const b = new Canvas(32, 32);
  b.rect(1, 2, 30, 14, WOOD[2]);
  b.hline(1, 30, 2, WOOD[3]);
  b.hline(1, 30, 15, WOOD[1]);
  b.rect(3, 4, 26, 10, plate[2]);
  b.hline(3, 28, 4, plate[3]);
  b.hline(3, 28, 13, plate[1]);
  emblem(b);
  b.outline(WOOD_OUT);
  c.blit(b, 0, 0);
  return c;
}

/** The Pokémon Center's sign: a red plate with a white cross. */
export function centerSign() {
  return signBoard(RED, (b) => {
    b.rect(14, 5, 4, 8, WHITE);
    b.rect(12, 7, 8, 4, WHITE);
  });
}

/** The Lab's sign: a blue plate with a flask. */
export function labSign() {
  return signBoard(BLUE, (b) => {
    b.pattern(13, 5, ['  ww  ', '  ww  ', ' wwww ', 'wwttww', 'wttttw', 'wwwwww'], {
      w: WHITE,
      t: TEAL[3],
    });
    b.set(14, 11, TEAL[4]);
  });
}

// ── Carpets (auto-tiled, two colors) ─────────────────────────

/**
 * A path as a carpet variant: the office auto-tiles carpets with marching
 * squares (16 junction pieces in a 4×4 sheet, case N at col N%4, row N/4;
 * corners NW=1, NE=2, SE=4, SW=8), so painted paths get rounded corners and a
 * rim where they meet the grass. Two colors only (the renderer recolors the
 * darkest as the carpet's color and the lightest as its accent): the rim is
 * the darker one, the fill the lighter; the town colors the rim a mid sand.
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
    sheet.blit(piece, (msCase % 4) * 16, Math.floor(msCase / 4) * 16);
  }
  return sheet;
}
