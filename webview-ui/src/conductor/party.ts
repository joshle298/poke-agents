/**
 * Pure party-bar rules (DOM-free, Node-tested): slot order with Leads first
 * and their children nested, the condition a slot shows, the portrait
 * emotion for it, and the HP reading.
 */

import type { ConductorSessionSummary } from '../../../core/src/messages.js';
import {
  PARTY_MAX_NEST_DEPTH,
  PARTY_SLEEP_AFTER_MS,
  POKEMON_MAX_DEX,
  POKEMON_PORTRAIT_ROUTE_PREFIX,
} from '../constants.js';
import type { ConductorAgent, ConductorState, SpeciesRef } from './conductorStore.js';
import { agentNickname, currentActivity, findSpecies, isStreamProvider } from './conductorStore.js';

export interface PartyEntry {
  id: number;
  /** Nesting under a Lead, capped at PARTY_MAX_NEST_DEPTH. 0 = top level. */
  depth: number;
}

/**
 * Party order: every Lead (an agent with children in the office) first, each
 * followed by its children; then everyone else. Within each group the input
 * order (creation order) holds. A child whose Lead is not in the office is a
 * top-level slot. Cycles in the lead links never loop or drop an agent.
 */
export function partyOrder(
  ids: readonly number[],
  leadOf: (id: number) => number | undefined,
): PartyEntry[] {
  const present = new Set(ids);
  const parentOf = (id: number): number | undefined => {
    const lead = leadOf(id);
    return lead !== undefined && lead !== id && present.has(lead) ? lead : undefined;
  };
  const children = new Map<number, number[]>();
  for (const id of ids) {
    const parent = parentOf(id);
    if (parent === undefined) continue;
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }

  const out: PartyEntry[] = [];
  const visited = new Set<number>();
  const visit = (id: number, depth: number) => {
    if (visited.has(id)) return;
    visited.add(id);
    out.push({ id, depth: Math.min(depth, PARTY_MAX_NEST_DEPTH) });
    for (const child of children.get(id) ?? []) visit(child, depth + 1);
  };

  const roots = ids.filter((id) => parentOf(id) === undefined);
  for (const id of roots) if (children.has(id)) visit(id, 0);
  for (const id of roots) visit(id, 0);
  // Members of a lead cycle have no root; keep them rather than drop them.
  for (const id of ids) visit(id, 0);
  return out;
}

/** What a party slot shows for an agent. */
export type PartyCondition = 'working' | 'needsYou' | 'done' | 'asleep' | 'error';

/** The agent's condition, or null before it has shown any activity. */
export function agentCondition(
  agent: ConductorAgent | undefined,
  now: number,
): PartyCondition | null {
  if (!agent) return null;
  if (agent.status === 'error') return 'error';
  if (agent.permission || (agent.status === 'waiting' && agent.awaitingInput)) return 'needsYou';
  if (agent.status === 'active' || currentActivity(agent) !== null) return 'working';
  if (agent.status !== 'waiting') return null;
  const lastActive = Math.max(agent.lastActiveAt ?? 0, agent.lastActivityAt ?? 0);
  return lastActive > 0 && now - lastActive >= PARTY_SLEEP_AFTER_MS ? 'asleep' : 'done';
}

/** True when the agent needs the user (its slot blinks). */
export function needsAttention(condition: PartyCondition | null): boolean {
  return condition === 'needsYou';
}

const EMOTION_BY_CONDITION: Record<PartyCondition, string> = {
  working: 'Determined',
  needsYou: 'Worried',
  done: 'Happy',
  error: 'Pain',
  asleep: 'Sigh',
};

/** The PMD portrait emotion for a condition. */
export function portraitEmotion(condition: PartyCondition | null): string {
  return condition ? EMOTION_BY_CONDITION[condition] : 'Normal';
}

/** The portrait URL for an emotion, falling back to Normal, then any. */
export function pickPortrait(
  portraits: Readonly<Record<string, string>> | undefined,
  emotion: string,
): string | undefined {
  if (!portraits) return undefined;
  return portraits[emotion] ?? portraits.Normal ?? Object.values(portraits)[0];
}

/** The Pokémon a PC Box row shows: the summary's own species (the server
 *  sends it with every session, so it survives a reload), else the one this
 *  page last saw the session as. */
export function pcBoxSpecies(
  session: Pick<ConductorSessionSummary, 'sessionId' | 'species' | 'shiny'>,
  sessionSpecies: Readonly<Record<string, SpeciesRef>>,
): SpeciesRef | undefined {
  if (session.species !== undefined) {
    return { species: session.species, shiny: session.shiny === true };
  }
  return sessionSpecies[session.sessionId];
}

/**
 * The portrait for a PC Box row. A species this office has loaded gives its
 * own Normal portrait. An archived session's species usually isn't loaded
 * (nobody in the office uses it), so where the local server serves its
 * portrait route (standalone, theme on) the row asks it for the dex's Normal
 * portrait: the server downloads it into its cache on demand. A shiny shows
 * the base form's, as the server does when a shiny has no portraits of its
 * own. Otherwise undefined (the Poké Ball).
 */
export function pcBoxPortraitUrl(
  ref: SpeciesRef | undefined,
  state: Pick<ConductorState, 'species'>,
  portraitRoute: boolean,
): string | undefined {
  if (!ref) return undefined;
  const loaded = pickPortrait(findSpecies(state, ref.species, ref.shiny)?.portraits, 'Normal');
  if (loaded) return loaded;
  if (!portraitRoute || !Number.isInteger(ref.species)) return undefined;
  if (ref.species < 1 || ref.species > POKEMON_MAX_DEX) return undefined;
  const dex4 = String(ref.species).padStart(4, '0');
  return `${POKEMON_PORTRAIT_ROUTE_PREFIX}/${dex4}/portrait/Normal.png`;
}

/** Context left as a 0..1 fraction (HP), or null when there is no usage yet. */
export function hpFraction(agent: ConductorAgent | undefined): number | null {
  const used = agent?.contextTokens;
  const max = agent?.maxContextTokens;
  if (used === undefined || max === undefined || max <= 0) return null;
  return Math.min(1, Math.max(0, 1 - used / max));
}

export type HpTone = 'high' | 'mid' | 'low';

/** Green above half, yellow from a fifth, red below. */
export function hpTone(fraction: number): HpTone {
  if (fraction > 0.5) return 'high';
  if (fraction >= 0.2) return 'mid';
  return 'low';
}

/** The short status badge a slot or overlay shows, if any. */
export function conditionBadge(condition: PartyCondition | null): string | null {
  switch (condition) {
    case 'asleep':
      return 'SLP';
    case 'error':
      return 'FNT';
    case 'needsYou':
      return '!';
    default:
      return null;
  }
}

/** Everything one party slot renders. */
export interface PartySlot {
  nickname: string;
  speciesName?: string;
  level?: number;
  /** Context left (0..1), null before the first usage report. */
  hp: number | null;
  /** Portrait for the slot's condition; absent until the species loads. */
  portraitUrl?: string;
  condition: PartyCondition | null;
  depth: number;
  /** A stream (Conductor) agent: × hides it, a click opens its Pokédex. */
  isStream: boolean;
}

export function buildPartySlot(
  state: Pick<ConductorState, 'agents' | 'species'>,
  id: number,
  depth: number,
  now: number,
): PartySlot {
  const agent = state.agents[id];
  const species = findSpecies(state, agent?.species, agent?.shiny);
  const condition = agentCondition(agent, now);
  return {
    nickname: agentNickname(state, id),
    speciesName: species?.name,
    level: agent?.level,
    hp: hpFraction(agent),
    portraitUrl: pickPortrait(species?.portraits, portraitEmotion(condition)),
    condition,
    depth,
    isStream: isStreamProvider(agent?.providerId),
  };
}
