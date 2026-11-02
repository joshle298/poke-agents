/**
 * Pokémon species assignment: which evolution line an agent belongs to, which
 * member of the line it shows at its current level, and whether it is shiny.
 *
 * Contract (callers rely on it):
 * - assignSpeciesIfNeeded is idempotent and cheap. It is called at the end of
 *   assignPaletteIfNeeded, so every agent creation path picks it up. It only
 *   fills what is missing: an agent restored with a valid line keeps it.
 * - updateLevel recomputes level (and evolution) from activity and reports what
 *   changed so the caller can re-broadcast agentDetails. On an evolution, load
 *   the new species (pokemonAssets.ensureSpeciesLoaded) before broadcasting.
 * - promoteToOrchestrator switches an agent to a legendary when it starts
 *   delegating to other sessions. Returns true when the species (or its shiny
 *   flag) changed.
 * - choosePokemon applies the user's choice (Change Pokémon): a line (or a
 *   legendary, for a Lead), the shiny flag, or a reset to automatic. A chosen
 *   Pokémon is never replaced by assignment or promotion; the level still
 *   picks the stage within the chosen line.
 * None of them persists; callers persist after a change.
 *
 * Policy:
 * - Stable key: the provider's session id (Conductor session UUID, Claude
 *   session id), else the agent id. It breaks ties with FNV-1a, so the same
 *   session in the same office lands on the same Pokémon.
 * - Pick the least-used line; once every line is in use, a duplicate is shiny.
 * - Leads get a legendary from the catalog's leadDefaults, least-used first.
 *   Legendaries don't evolve.
 * - Level = 1 + floor(sqrt(messageCount / k)), k = 2 for Codex and 4 for
 *   Claude, Cursor and unknown harnesses; without a message count,
 *   1 + floor(sqrt(toolCallCount)). Clamped to 1..100.
 * - Stage 1 below Lv 16, 2 from Lv 16, 3 from Lv 36, bounded by the line.
 *   Where a line branches the key picks the branch along its evolution path. A shown
 *   species never de-evolves: a restored Charmeleon stays a Charmeleon while
 *   its level is recounted.
 * - Large species are never assigned (they dwarf the office); a line stops
 *   evolving before its first large stage (Magikarp, Shelgon).
 */

import type { AgentStateStore } from '../agentStateStore.js';
import type { AgentState } from '../types.js';
import {
  EVOLVE_STAGE_2_LEVEL,
  EVOLVE_STAGE_3_LEVEL,
  LEVEL_MAX,
  LEVEL_MESSAGES_PER_STEP_CODEX,
  LEVEL_MESSAGES_PER_STEP_DEFAULT,
  LEVEL_MIN,
} from './constants.js';
import type { CatalogLegendary, CatalogLine, CatalogMember } from './speciesCatalog.js';
import { POKEMON_CATALOG } from './speciesCatalog.js';

export interface SpeciesAssignOptions {
  /** Stable identity used to pick the same Pokémon across restarts (Conductor
   *  session id, Claude session id). Falls back to the agent id. */
  stableKey?: string;
  /** Sessions that delegate to other sessions get a legendary. */
  orchestrator?: boolean;
}

/** A user's Change Pokémon request: `line` null = back to automatic, absent =
 *  keep the line (change only `shiny`). */
export interface PokemonChoice {
  line?: string | null;
  shiny?: boolean;
}

export interface LevelChange {
  levelChanged: boolean;
  /** True when the agent evolved (species changed). */
  speciesChanged: boolean;
}

// ── Catalog views ──────────────────────────────────────────────

/** A line as the assigner sees it: members grouped by stage, large ones out. */
interface PoolLine {
  id: string;
  /** stages[0] = stage-1 members. Ends before the first stage with no
   *  assignable member, so evolution stops there. */
  stages: CatalogMember[][];
  explicitPaths: boolean;
}

function toPoolLine(line: CatalogLine): PoolLine | null {
  const stages: CatalogMember[][] = [];
  const maxStage = Math.max(...line.members.map((m) => m.stage));
  for (let stage = 1; stage <= maxStage; stage++) {
    const members = line.members.filter(
      (m) =>
        m.stage === stage &&
        m.size !== 'large' &&
        (m.evolvesFrom === undefined ||
          stages[stage - 2]?.some((parent) => parent.dex === m.evolvesFrom)),
    );
    if (members.length === 0) break;
    stages.push(members);
  }
  return stages.length > 0
    ? { id: line.id, stages, explicitPaths: line.members.some((m) => m.evolvesFrom !== undefined) }
    : null;
}

const POOL_LINES: readonly PoolLine[] = POKEMON_CATALOG.lines
  .map(toPoolLine)
  .filter((line): line is PoolLine => line !== null);
const POOL_LINE_BY_ID = new Map(POOL_LINES.map((line) => [line.id, line]));

const SHOWABLE_LEGENDARIES = POKEMON_CATALOG.legendaries.filter((l) => l.size !== 'large');
const LEGENDARY_BY_ID = new Map(SHOWABLE_LEGENDARIES.map((l) => [l.id, l]));
const LEAD_POOL: readonly CatalogLegendary[] = POKEMON_CATALOG.leadDefaults
  .map((dex) => SHOWABLE_LEGENDARIES.find((l) => l.dex === dex))
  .filter((l): l is CatalogLegendary => l !== undefined);

// ── Keys and tie-breaks ────────────────────────────────────────

/** 32-bit FNV-1a over the UTF-8 bytes of `text`. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The provider's own session id (namespace prefix dropped), else the agent id. */
export function stableKeyFor(agent: AgentState, explicit?: string): string {
  if (explicit) return explicit;
  const sessionId = agent.sessionId;
  if (!sessionId) return `agent:${agent.id}`;
  const prefix = agent.providerId ? `${agent.providerId}:` : '';
  return prefix && sessionId.startsWith(prefix) ? sessionId.slice(prefix.length) : sessionId;
}

interface Usage {
  normal: number;
  shiny: number;
}

/** Users per line id among the other agents in the store. */
function usageByLine(store: AgentStateStore, self: AgentState): Map<string, Usage> {
  const usage = new Map<string, Usage>();
  for (const other of store.values()) {
    if (other === self || other.id === self.id || !other.pokemonLine) continue;
    const entry = usage.get(other.pokemonLine) ?? { normal: 0, shiny: 0 };
    if (other.shiny) entry.shiny++;
    else entry.normal++;
    usage.set(other.pokemonLine, entry);
  }
  return usage;
}

function totalOf(usage: Usage | undefined): number {
  return usage ? usage.normal + usage.shiny : 0;
}

/** Least-used candidate; ties broken by FNV-1a of the key over catalog order. */
function pickLeastUsed<T extends { id: string }>(
  candidates: readonly T[],
  usage: Map<string, Usage>,
  key: string,
): T {
  const min = Math.min(...candidates.map((c) => totalOf(usage.get(c.id))));
  const tied = candidates.filter((c) => totalOf(usage.get(c.id)) === min);
  return tied[fnv1a(key) % tied.length];
}

/** A first user is normal; a duplicate takes whichever variant is rarer, shiny first. */
function shinyFor(usage: Usage | undefined): boolean {
  return usage !== undefined && usage.shiny < usage.normal;
}

// ── Level and stage ────────────────────────────────────────────

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function levelFor(activity: {
  harness?: string;
  messageCount?: number;
  toolCalls?: number;
}): number {
  let level: number;
  if (isCount(activity.messageCount)) {
    const k =
      activity.harness?.toLowerCase() === 'codex'
        ? LEVEL_MESSAGES_PER_STEP_CODEX
        : LEVEL_MESSAGES_PER_STEP_DEFAULT;
    level = 1 + Math.floor(Math.sqrt(activity.messageCount / k));
  } else {
    level = 1 + Math.floor(Math.sqrt(isCount(activity.toolCalls) ? activity.toolCalls : 0));
  }
  return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, level));
}

export function stageForLevel(level: number): 1 | 2 | 3 {
  if (level >= EVOLVE_STAGE_3_LEVEL) return 3;
  if (level >= EVOLVE_STAGE_2_LEVEL) return 2;
  return 1;
}

function agentLevel(
  agent: AgentState,
  activity: { messageCount?: number; toolCalls?: number } = {},
): number {
  return levelFor({
    harness: agent.details?.harness,
    messageCount: activity.messageCount ?? agent.details?.messageCount,
    toolCalls: activity.toolCalls ?? agent.toolCallCount,
  });
}

/** 1-based stage of `dex` in the line, or 0 when it isn't a member. */
function stageOf(line: PoolLine, dex: number | undefined): number {
  if (dex === undefined) return 0;
  const index = line.stages.findIndex((members) => members.some((m) => m.dex === dex));
  return index + 1;
}

/** The species to show for a line at `level`, never below the current one. */
function speciesForLevel(
  line: PoolLine,
  level: number,
  current: number | undefined,
  key: string,
): number {
  const target = Math.min(stageForLevel(level), line.stages.length);
  const currentStage = stageOf(line, current);
  if (current !== undefined && currentStage >= target) return current;
  if (line.explicitPaths) {
    const first = line.stages[0];
    let dex =
      current !== undefined && currentStage > 0
        ? current
        : first[fnv1a(`${key}:${line.id}:1`) % first.length].dex;
    for (let stage = Math.max(2, currentStage + 1); stage <= target; stage++) {
      const candidates = line.stages[stage - 1].filter((m) => m.evolvesFrom === dex);
      if (candidates.length === 0) break;
      dex = candidates[fnv1a(`${key}:${line.id}:${stage}`) % candidates.length].dex;
    }
    return dex;
  }
  const members = line.stages[target - 1];
  return members[fnv1a(`${key}:${line.id}:${target}`) % members.length].dex;
}

// ── Contract ───────────────────────────────────────────────────

export function assignSpeciesIfNeeded(
  agent: AgentState,
  store: AgentStateStore,
  opts: SpeciesAssignOptions = {},
): void {
  const key = stableKeyFor(agent, opts.stableKey);
  if (opts.orchestrator) promote(agent, store, key);

  const legendary = agent.pokemonLine ? LEGENDARY_BY_ID.get(agent.pokemonLine) : undefined;
  let line = agent.pokemonLine ? POOL_LINE_BY_ID.get(agent.pokemonLine) : undefined;
  if (!line && !legendary) {
    const usage = usageByLine(store, agent);
    line = pickLeastUsed(POOL_LINES, usage, key);
    agent.pokemonLine = line.id;
    agent.shiny = shinyFor(usage.get(line.id));
    agent.species = undefined;
  }
  if (agent.shiny === undefined) agent.shiny = false;
  if (agent.level === undefined) agent.level = agentLevel(agent);
  if (legendary) {
    agent.species = legendary.dex;
  } else if (line && stageOf(line, agent.species) === 0) {
    agent.species = speciesForLevel(line, agent.level, undefined, key);
  }
}

export function updateLevel(
  agent: AgentState,
  activity: { messageCount?: number; toolCalls?: number } = {},
): LevelChange {
  const level = agentLevel(agent, activity);
  const levelChanged = agent.level !== level;
  agent.level = level;

  const line = agent.pokemonLine ? POOL_LINE_BY_ID.get(agent.pokemonLine) : undefined;
  if (!line) return { levelChanged, speciesChanged: false };
  const species = speciesForLevel(line, level, agent.species, stableKeyFor(agent));
  const speciesChanged = species !== agent.species;
  agent.species = species;
  return { levelChanged, speciesChanged };
}

export function promoteToOrchestrator(agent: AgentState, store: AgentStateStore): boolean {
  return promote(agent, store, stableKeyFor(agent));
}

function promote(agent: AgentState, store: AgentStateStore, key: string): boolean {
  // The user's choice stands, legendary or not.
  if (agent.pokemonChosen) return false;
  if (agent.pokemonLine && LEGENDARY_BY_ID.has(agent.pokemonLine)) return false;
  if (LEAD_POOL.length === 0) return false;
  const before = { species: agent.species, shiny: agent.shiny };
  const usage = usageByLine(store, agent);
  const pick = pickLeastUsed(LEAD_POOL, usage, key);
  agent.pokemonLine = pick.id;
  agent.species = pick.dex;
  agent.shiny = shinyFor(usage.get(pick.id));
  if (agent.level === undefined) agent.level = agentLevel(agent);
  return before.species !== agent.species || before.shiny !== agent.shiny;
}

// ── The user's choice (Change Pokémon) ─────────────────────────

/** What the picker offers: every assignable line (members by stage, large
 *  stages out) and the legendaries a Lead can be. */
export function pokemonPickerCatalog(): {
  lines: Array<{ id: string; members: Array<{ dex: number; name: string; stage: number }> }>;
  legendaries: Array<{ id: string; dex: number; name: string }>;
} {
  return {
    lines: POOL_LINES.map((line) => ({
      id: line.id,
      members: line.stages.flatMap((members, index) =>
        members.map((m) => ({ dex: m.dex, name: m.name, stage: index + 1 })),
      ),
    })),
    legendaries: SHOWABLE_LEGENDARIES.map((l) => ({ id: l.id, dex: l.dex, name: l.name })),
  };
}

/** Why a line can't be chosen for an agent, or null when it can: a pool line
 *  for anyone, a Lead legendary for a Lead only. */
export function choiceRefusal(line: string, opts: { lead: boolean }): string | null {
  if (POOL_LINE_BY_ID.has(line)) return null;
  if (LEGENDARY_BY_ID.has(line)) {
    return opts.lead ? null : 'Only a Lead can be a legendary.';
  }
  return 'Unknown Pokémon.';
}

/** A line id the assigner knows (a pool line or a showable legendary). */
function isKnownLine(id: unknown): id is string {
  return typeof id === 'string' && (POOL_LINE_BY_ID.has(id) || LEGENDARY_BY_ID.has(id));
}

/**
 * Apply a Change Pokémon request (validate it with choiceRefusal first). A
 * line is shown at the stage the agent's level reaches in it (a legendary as
 * itself), and stays the agent's until a reset. The first choice remembers
 * the automatic line and shiny flag it replaces; `line: null` drops the
 * choice and gives them back, at the stage the level reaches now (without
 * them, it assigns automatically again; either way a delegating Lead gets a
 * legendary with `orchestrator`). Returns true when anything the office shows
 * changed.
 */
export function choosePokemon(
  agent: AgentState,
  store: AgentStateStore,
  choice: PokemonChoice,
  opts: SpeciesAssignOptions = {},
): boolean {
  const before = JSON.stringify([
    agent.pokemonLine,
    agent.species,
    agent.shiny,
    agent.pokemonChosen,
  ]);
  const key = stableKeyFor(agent, opts.stableKey);
  if (choice.line === null) {
    if (!agent.pokemonChosen) return false;
    const autoLine = isKnownLine(agent.pokemonAutoLine) ? agent.pokemonAutoLine : undefined;
    agent.pokemonChosen = undefined;
    agent.pokemonLine = autoLine;
    agent.species = undefined;
    agent.shiny = autoLine ? (agent.pokemonAutoShiny ?? false) : undefined;
    agent.pokemonAutoLine = undefined;
    agent.pokemonAutoShiny = undefined;
    assignSpeciesIfNeeded(agent, store, { ...opts, stableKey: key });
  } else {
    if (!agent.pokemonChosen && agent.pokemonLine) {
      agent.pokemonAutoLine = agent.pokemonLine;
      agent.pokemonAutoShiny = agent.shiny === true;
    }
    if (typeof choice.line === 'string' && choice.line !== agent.pokemonLine) {
      const legendary = LEGENDARY_BY_ID.get(choice.line);
      const line = POOL_LINE_BY_ID.get(choice.line);
      if (!legendary && !line) return false;
      if (agent.level === undefined) agent.level = agentLevel(agent);
      agent.pokemonLine = choice.line;
      if (legendary) agent.species = legendary.dex;
      else if (line) agent.species = speciesForLevel(line, agent.level, undefined, key);
    }
    if (typeof choice.shiny === 'boolean') agent.shiny = choice.shiny;
    else if (agent.shiny === undefined) agent.shiny = false;
    agent.pokemonChosen = true;
  }
  return (
    before !== JSON.stringify([agent.pokemonLine, agent.species, agent.shiny, agent.pokemonChosen])
  );
}

// ── Persistence ────────────────────────────────────────────────

/**
 * The Pokémon fields of a persisted agent that still make sense against the
 * catalog, for restore paths. Anything stale or malformed is dropped, and
 * assignSpeciesIfNeeded fills it in again.
 */
export function restoredPokemonFields(
  persisted: object,
): Pick<
  AgentState,
  'pokemonLine' | 'species' | 'shiny' | 'pokemonChosen' | 'pokemonAutoLine' | 'pokemonAutoShiny'
> {
  const { pokemonLine, species, shiny, pokemonChosen, pokemonAutoLine, pokemonAutoShiny } =
    persisted as Record<string, unknown>;
  if (typeof pokemonLine !== 'string') return {};
  const restoredShiny = typeof shiny === 'boolean' ? shiny : undefined;
  // A choice survives only with the line it chose, and with it the automatic
  // Pokémon it replaced (when that line still exists).
  const chosen =
    pokemonChosen === true
      ? {
          pokemonChosen: true,
          ...(isKnownLine(pokemonAutoLine)
            ? { pokemonAutoLine, pokemonAutoShiny: pokemonAutoShiny === true }
            : {}),
        }
      : {};
  const legendary = LEGENDARY_BY_ID.get(pokemonLine);
  if (legendary) return { pokemonLine, species: legendary.dex, shiny: restoredShiny, ...chosen };
  const line = POOL_LINE_BY_ID.get(pokemonLine);
  if (!line) return {};
  const restoredSpecies =
    typeof species === 'number' && stageOf(line, species) > 0 ? species : undefined;
  return { pokemonLine, species: restoredSpecies, shiny: restoredShiny, ...chosen };
}
