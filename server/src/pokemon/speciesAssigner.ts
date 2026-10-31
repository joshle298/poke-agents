/**
 * Pokémon species assignment: which evolution line an agent belongs to, which
 * member of the line it shows at its current level, and whether it is shiny.
 *
 * Contract (implemented in the Pokémon server stream; callers already rely on it):
 * - assignSpeciesIfNeeded is idempotent and cheap. It is called at the end of
 *   assignPaletteIfNeeded, so every agent creation path picks it up.
 * - updateLevel recomputes level (and evolution) from activity and reports what
 *   changed so the caller can re-broadcast agentDetails.
 * - promoteToOrchestrator switches an agent to a legendary when it starts
 *   delegating to other sessions. Returns true when the species changed.
 */

import type { AgentStateStore } from '../agentStateStore.js';
import type { AgentState } from '../types.js';

export interface SpeciesAssignOptions {
  /** Stable identity used to pick the same Pokémon across restarts (Conductor
   *  session id, Claude session id). Falls back to the agent id. */
  stableKey?: string;
  /** Sessions that delegate to other sessions get a legendary. */
  orchestrator?: boolean;
}

export interface LevelChange {
  levelChanged: boolean;
  /** True when the agent evolved (species changed). */
  speciesChanged: boolean;
}

export function assignSpeciesIfNeeded(
  _agent: AgentState,
  _store: AgentStateStore,
  _opts?: SpeciesAssignOptions,
): void {
  // Implemented by the Pokémon server stream.
}

export function updateLevel(
  _agent: AgentState,
  _activity: { messageCount?: number; toolCalls?: number },
): LevelChange {
  return { levelChanged: false, speciesChanged: false };
}

export function promoteToOrchestrator(_agent: AgentState, _store: AgentStateStore): boolean {
  return false;
}
