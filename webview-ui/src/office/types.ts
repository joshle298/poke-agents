export {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MATRIX_EFFECT_DURATION_SEC as MATRIX_EFFECT_DURATION,
  MAX_COLS,
  MAX_ROWS,
  TILE_SIZE,
} from '../constants.js';

export const TileType = {
  WALL: 0,
  FLOOR_1: 1,
  FLOOR_2: 2,
  FLOOR_3: 3,
  FLOOR_4: 4,
  FLOOR_5: 5,
  FLOOR_6: 6,
  FLOOR_7: 7,
  FLOOR_8: 8,
  FLOOR_9: 9,
  VOID: 255,
} as const;
export type TileType = (typeof TileType)[keyof typeof TileType];

/** Re-export ColorValue for consumers that import color types from office/types */
export type { ColorValue } from '../components/ui/types.js';
import type { AgentLinkKind } from '../../../core/src/messages.js';
import type { ColorValue } from '../components/ui/types.js';

export const CharacterState = {
  IDLE: 'idle',
  WALK: 'walk',
  TYPE: 'type',
} as const;
export type CharacterState = (typeof CharacterState)[keyof typeof CharacterState];

export const Direction = {
  DOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  UP: 3,
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

/** 2D array of hex color strings: '' = transparent, '#RRGGBB' = opaque, '#RRGGBBAA' = semi-transparent. [row][col] */
export type SpriteData = string[][];

export interface Seat {
  /** Chair furniture uid */
  uid: string;
  /** Tile col where agent sits */
  seatCol: number;
  /** Tile row where agent sits */
  seatRow: number;
  /** Direction character faces when sitting (toward adjacent desk) */
  facingDir: Direction;
  assigned: boolean;
}

export interface FurnitureInstance {
  sprite: SpriteData;
  /** Pixel x (top-left) */
  x: number;
  /** Pixel y (top-left) */
  y: number;
  /** Y value used for depth sorting (typically bottom edge) */
  zY: number;
  /** Render-time horizontal flip flag (for mirrored side variants) */
  mirrored?: boolean;
}

export interface ToolActivity {
  toolId: string;
  status: string;
  done: boolean;
  permissionWait?: boolean;
}

export const EditTool = {
  TILE_PAINT: 'tile_paint',
  WALL_PAINT: 'wall_paint',
  FURNITURE_PLACE: 'furniture_place',
  FURNITURE_PICK: 'furniture_pick',
  SELECT: 'select',
  EYEDROPPER: 'eyedropper',
  ERASE: 'erase',
  PETS: 'pets',
  CARPET_PAINT: 'carpet_paint',
  CARPET_PICK: 'carpet_pick',
  AREA_PAINT: 'area_paint',
  /** Colour-only eyedropper: takes a placed item's colour, leaves its type alone. */
  COLOR_PICK: 'color_pick',
} as const;
export type EditTool = (typeof EditTool)[keyof typeof EditTool];

export interface FurnitureCatalogEntry {
  type: string; // asset ID from furniture manifest
  label: string;
  footprintW: number;
  footprintH: number;
  sprite: SpriteData;
  isDesk: boolean;
  category?: string;
  /** Orientation from rotation group: 'front' | 'back' | 'left' | 'right' */
  orientation?: string;
  /** Whether this item can be placed on top of desk/table surfaces */
  canPlaceOnSurfaces?: boolean;
  /** Number of tile rows from the top of the footprint that are "background" (allow placement, still block walking). Default 0. */
  backgroundTiles?: number;
  /** Whether this item can be placed on wall tiles */
  canPlaceOnWalls?: boolean;
  /** Whether this is a side-oriented asset that produces a mirrored "left" variant */
  mirrorSide?: boolean;
}

export interface PlacedFurniture {
  uid: string;
  type: string; // asset ID from furniture manifest
  col: number;
  row: number;
  /** Optional color override for furniture */
  color?: ColorValue;
}

// ─────────────────────────────────────────────────────────────────────────────
// CARPETS — visual layer between floor and furniture. Walkable, decorative.
// ─────────────────────────────────────────────────────────────────────────────

export interface CarpetTile {
  /** Variant index into the loaded carpet sprite sets (0 .. getCarpetSetCount()-1). */
  variant: number;
  /** Main colorization (lowest-luminance pixels). Defaults to CARPET_DEFAULT_COLOR when omitted. */
  color?: ColorValue;
  /** Accent colorization (highest-luminance pixels). Defaults to CARPET_DEFAULT_ACCENT_COLOR when omitted. */
  accentColor?: ColorValue;
  /** Stacking order at overlapping junctions. Higher draws on top. Defaults to 0. */
  order?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// AREAS — translucent named overlays for Directory ↔ seat preference.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What an Area does beyond Directory mapping. Idle characters wander and nap in
 * the `meadow`; fainted (errored) ones walk to the `center` and rest there until
 * revived; the seats of a `lectern` are kept for Leads. A layout with none of
 * them keeps the upstream behavior.
 */
export const AreaRole = {
  MEADOW: 'meadow',
  CENTER: 'center',
  LECTERN: 'lectern',
} as const;
export type AreaRole = (typeof AreaRole)[keyof typeof AreaRole];

export interface AreaDefinition {
  /** Stable label used as the FK in `areaTiles` and `OfficeState.areaMappings`. */
  label: string;
  /** Hex color (e.g. "#ff6b6b"). RGB only — alpha applied at render time. */
  color: string;
  /** Optional behavior role (see AreaRole). Survives rename and recolor. */
  role?: AreaRole;
}

export interface OfficeLayout {
  version: 1;
  cols: number;
  rows: number;
  tiles: TileType[];
  furniture: PlacedFurniture[];
  /** Per-tile color settings, parallel to tiles array. null = wall/no color */
  tileColors?: Array<ColorValue | null>;
  /** Bumped when the bundled default layout changes; forces a reset on existing installs */
  layoutRevision?: number;
  /** Pets placed in the office. Optional for backward-compat; migrateLayout coerces to []. */
  pets?: PlacedPet[];
  /** Per-tile carpet data, parallel to tiles array. null/undefined = no carpet on tile. */
  carpetTiles?: Array<CarpetTile | null>;
  /** Area definitions referenced by `areaTiles` labels. Distinct labels required. */
  areas?: AreaDefinition[];
  /** Per-tile Area label, parallel to tiles array. null = no area assignment. */
  areaTiles?: Array<string | null>;
}

export interface Character {
  id: number;
  state: CharacterState;
  dir: Direction;
  /** Pixel position */
  x: number;
  y: number;
  /** Current tile column */
  tileCol: number;
  /** Current tile row */
  tileRow: number;
  /** Remaining path steps (tile coords) */
  path: Array<{ col: number; row: number }>;
  /** 0-1 lerp between current tile and next tile */
  moveProgress: number;
  /** Current tool name for typing vs reading animation, or null */
  currentTool: string | null;
  /** Palette index (0-5) */
  palette: number;
  /** Hue shift in degrees (0 = no shift, ≥45 for repeated palettes) */
  hueShift: number;
  /** Animation frame index */
  frame: number;
  /** Time accumulator for animation */
  frameTimer: number;
  /** Timer for idle wander decisions */
  wanderTimer: number;
  /** Number of wander moves completed in current roaming cycle */
  wanderCount: number;
  /** Max wander moves before returning to seat for rest */
  wanderLimit: number;
  /** Whether the agent is actively working */
  isActive: boolean;
  /** Assigned seat uid, or null if no seat */
  seatId: string | null;
  /** Active speech bubble type, or null if none showing */
  bubbleType: 'permission' | 'waiting' | null;
  /** Only meaningful while bubbleType === 'waiting': true when the agent went
   *  idle waiting on the user (surfaces the "Waiting for input" label);
   *  false/undefined when the agent simply finished its turn (checkmark only,
   *  label falls through to idle). */
  waitingAwaitingInput?: boolean;
  /** Countdown timer for bubble (waiting: 2→0, permission: unused) */
  bubbleTimer: number;
  /** Timer to stay seated while inactive after seat reassignment (counts down to 0) */
  seatTimer: number;
  /** Whether this character represents a sub-agent (spawned by Task tool) */
  isSubagent: boolean;
  /** Parent agent ID if this is a sub-agent, null otherwise */
  parentAgentId: number | null;
  /** Active matrix spawn/despawn effect, or null */
  matrixEffect: 'spawn' | 'despawn' | null;
  /** Timer counting up from 0 to MATRIX_EFFECT_DURATION */
  matrixEffectTimer: number;
  /** Per-column random seeds (16 values) for staggered rain timing */
  matrixEffectSeeds: number[];
  /** Directory name — the agent's origin label (only set for multi-root workspaces) */
  directoryName?: string;
  /** Headless agent: adopted from outside the office, so there is no terminal to
   *  focus. Rendered translucent. Teammates and sub-agents are never headless —
   *  clicking them reaches their lead's / parent's terminal. */
  isHeadless?: boolean;
  /** The first-run consent greeter. A MARKER, not a gate: the greeter lives in
   *  OfficeState.greeter, outside the agent map, so seat assignment, palette
   *  diversity, the FSM, hit-testing and seat persistence never see it — no
   *  per-consumer guard reads this flag. It exists for the render/e2e snapshot
   *  (testHooks.getCharacters) to tell the greeter from agents. */
  isGreeter?: boolean;

  // -- Agent Teams --
  /** Team name this agent belongs to */
  teamName?: string;
  /** Role name within the team (null for lead) */
  agentName?: string;
  /** Whether this agent is the team lead */
  isTeamLead?: boolean;
  /** ID of the lead agent (set on teammates) */
  leadAgentId?: number;
  /** True when lead spawns teammates via tmux (run_in_background Agent calls) */
  teamUsesTmux?: boolean;

  // -- Context gauge --
  /** Tokens in the agent's context as of its newest turn; 0 until reported.
   *  Sub-agents have no session of their own and stay at 0. */
  contextTokens: number;
  /** Window `contextTokens` is measured against. */
  maxContextTokens: number;

  // -- Pokémon office (all optional: upstream characters never set them) --
  /** National dex number of the Pokémon shown for this agent. */
  species?: number;
  shiny?: boolean;
  level?: number;
  /** Nickname shown on the overlay (for Conductor, the session name). */
  label?: string;
  /** Provider feeding this agent. Set = a stream agent (never auto-selected). */
  providerId?: string;
  /** The session errored: the Pokémon faints until the agent turns active. */
  isErrored?: boolean;
  errorMessage?: string;
  /** Blocked on the user's answer. Unlike `waitingAwaitingInput` (which lives
   *  only as long as the waiting bubble), this holds until the agent is active. */
  awaitingInput?: boolean;
  /** One-shot animation override, or null when the state-driven anim plays. */
  pmdAnim?: PokemonOneShot | null;
  /** Seconds into the displayed PMD animation (restarts when it changes). */
  pmdAnimTime?: number;
  /** Which animation `pmdAnimTime` belongs to (situation + anim name). */
  pmdAnimKey?: string;
  /** Seconds since the agent was last active. */
  idleSec?: number;
  /** PMD row (0-7) to face instead of `dir` while a one-shot plays. */
  faceOverride?: number | null;
  /** World point the capsule is thrown from on spawn (the Lead or parent);
   *  absent = the capsule drops from above. */
  effectOrigin?: { x: number; y: number };
  /** Seconds into the evolution flash; undefined when not evolving. */
  evolveTimer?: number;
  /** Species (and shininess) swapped in at the evolution flash's midpoint. */
  nextSpecies?: number;
  nextShiny?: boolean;

  // -- Town areas (only set in layouts with meadow / center Area roles) --
  /** Where the character is headed this frame (see townBehavior.ts); undefined
   *  when the upstream FSM drives it. */
  townGoal?: TownGoal;
  /** Seconds until the next try at heading toward `townGoal`'s area. */
  townRetryTimer?: number;
  /** Seconds left in which a status that sends it to the Meadow or the Center
   *  places it there directly (just created); undefined once over. */
  townSpawnGrace?: number;
  /** The bed a fainted character lies in (head on the pillow, `x` moved to
   *  the bed's middle; see bedLie.ts for where it is drawn); undefined when it
   *  isn't lying in one. */
  bedRest?: BedRest;
}

/** Where an inactive character belongs in a layout with Area roles. */
export type TownGoal = 'meadow' | 'center' | 'stay';

/** A bed in the Pokémon Center, as a character lying in it needs it drawn. */
export interface BedRest {
  /** The end the pillow is at: the sleeper's head points there. */
  pillow: 'left' | 'right';
  /** World x of the bed's middle (the sleeper's `x` while it lies there). */
  midX: number;
  /** The bed's box, world px (its sprite's top-left and size). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The bed's blanket (its foreground pixels, opaque) and where it is drawn
   *  (world px, top-left), laid over the sleeper; null when it has none. */
  blanket: { sprite: SpriteData; x: number; y: number } | null;
}

/** One-shot animations: a tool burst, sending a message, a finished turn,
 *  waking up, and the hurt flinch that leads into a faint. */
export type PokemonOneShot = 'toolBurst' | 'message' | 'turnEnd' | 'wake' | 'hurt';

/** A message capsule in flight from one agent to another (agentMessage). */
export interface Projectile {
  id: number;
  fromId: number;
  toId: number;
  kind: AgentLinkKind;
  /** Shown near the receiver once the capsule lands. */
  preview?: string;
  /** Seconds in flight, and the flight's length. */
  t: number;
  dur: number;
}

/** A landed message's preview, shown near its receiver for a few seconds. */
export interface MessagePreview {
  id: number;
  fromId: number;
  toId: number;
  text: string;
  /** Seconds left on screen. */
  timer: number;
}

/** A short note above an agent (agentNotice). */
export interface AgentNoticeBubble {
  text: string;
  tone: 'info' | 'error';
  /** Seconds left on screen. */
  timer: number;
}

/** One link to draw: both ends are characters in the office. */
export interface LinkSegment {
  from: Character;
  to: Character;
  kind: AgentLinkKind;
  /** Drawn faint: in the town, unless its family is hovered or selected. */
  dim?: boolean;
}

export const PetState = { IDLE: 'idle', WALK: 'walk', FOLLOW: 'follow' } as const;
export type PetState = (typeof PetState)[keyof typeof PetState];

/** Runtime pet (mutated by FSM tick). */
export interface Pet {
  /** Stable identifier; matches PlacedPet.id in the layout. */
  id: string;
  /** Display name from sprite manifest (e.g. "Claudio", "Gitcat"). */
  name: string;
  /** Index into the loaded PetSpriteFrames[] array. */
  petType: number;
  state: PetState;
  dir: Direction;
  /** Pixel position (bottom-center anchor). */
  x: number;
  y: number;
  /** Current tile column / row (integer). */
  tileCol: number;
  tileRow: number;
  /** Remaining path steps (tile coords). */
  path: Array<{ col: number; row: number }>;
  /** 0..1 lerp progress between current tile and next tile. */
  moveProgress: number;
  /** Animation cycle index 0..3. */
  frame: number;
  frameTimer: number;
  /** Countdown for next IDLE→WALK/FOLLOW decision. */
  wanderTimer: number;
  /** ID of the character being followed, or null. */
  followTargetId: number | null;
  /** Countdown until next path re-computation while following. */
  followRecalcTimer: number;
  /** Time spent in current FOLLOW episode. */
  followDuration: number;
  /** Random [5, 15] limit; FOLLOW exits when followDuration >= this. */
  followDurationLimit: number;
  /** Pet's heart-bubble overlay (set on click), or null. */
  bubbleType: 'heart' | null;
  /** Countdown timer for the heart bubble (mirrors character waiting bubble). */
  bubbleTimer: number;
}

/** Persisted record (lives on OfficeLayout). */
export interface PlacedPet {
  /** crypto.randomUUID() generated when first toggled on. */
  id: string;
  /** Index into the loaded pet sprite array. */
  petType: number;
}
