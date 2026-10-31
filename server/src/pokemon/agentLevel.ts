/**
 * Levels for agents without a message count: Claude Code agents (`--claude`)
 * level up from the tool calls their hooks and transcripts report, the same
 * DESIGN fallback the stream driver uses (`1 + floor(sqrt(toolCallCount))`).
 * Stream agents are levelled by their StreamAgentDriver. Change Pokémon on
 * such an agent announces through announceSpeciesChange too.
 *
 * A level or species change is announced with agentDetails. An evolution waits
 * for its new species' sprites when the host registered a preloader
 * (standalone does; VS Code keeps upstream characters and fetches nothing), so
 * the office can play the evolution flash instead of dropping to the upstream
 * character.
 */

import { agentDetailsMessage } from '../agentMessages.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { STREAM_SPECIES_LOAD_TIMEOUT_MS } from '../constants.js';
import type { AgentState } from '../types.js';
import { updateLevel } from './speciesAssigner.js';

type Preloader = (dex: number, shiny: boolean) => Promise<unknown>;

let evolutionPreloader: Preloader | null = null;

/** Register (or clear) the loader an evolution waits for before it is announced. */
export function setEvolutionPreloader(preloader: Preloader | null): void {
  evolutionPreloader = preloader;
}

/** Agents whose evolution is waiting for its sprites; that announcement sends
 *  their newest details. */
const evolving = new WeakSet<AgentState>();

/** One tool call by the agent: count it, re-level, and announce a change. */
export function countToolCall(id: number, agent: AgentState, store: AgentStateStore): void {
  agent.toolCallCount = (agent.toolCallCount ?? 0) + 1;
  const change = updateLevel(agent, {
    messageCount: agent.details?.messageCount,
    toolCalls: agent.toolCallCount,
  });
  if (!change.levelChanged && !change.speciesChanged) return;
  if (change.speciesChanged) store.persist();
  if (change.speciesChanged) announceSpeciesChange(id, agent, store);
  else if (!evolving.has(agent)) announce(id, agent, store);
}

/**
 * The agent's species changed (an evolution, or the user's Change Pokémon):
 * announce it with agentDetails once the new species' sprites are loaded (or
 * after STREAM_SPECIES_LOAD_TIMEOUT_MS), so the office plays the evolution
 * flash. Agents of a stream provider go through their StreamAgentDriver.
 */
export function announceSpeciesChange(id: number, agent: AgentState, store: AgentStateStore): void {
  if (evolving.has(agent)) return;
  if (!evolutionPreloader || agent.species === undefined) {
    announce(id, agent, store);
    return;
  }
  evolving.add(agent);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, STREAM_SPECIES_LOAD_TIMEOUT_MS);
    timer.unref?.();
  });
  void Promise.race([evolutionPreloader(agent.species, agent.shiny === true), timedOut])
    .catch(() => undefined)
    .then(() => {
      clearTimeout(timer);
      evolving.delete(agent);
      if (store.get(id) === agent) announce(id, agent, store);
    });
}

function announce(id: number, agent: AgentState, store: AgentStateStore): void {
  const message = agentDetailsMessage(id, agent);
  if (message) store.broadcast({ ...message });
}
