/**
 * Builders for the per-agent server messages that more than one place sends,
 * so every copy carries the same fields: the standalone WebSocket and the VS
 * Code webview both announce agents with agentCreatedMessage, and the stream
 * driver and the reconnect replay both describe them with agentDetailsMessage.
 */

import type { AgentCreated, AgentDetails } from '../../core/src/messages.js';
import type { AgentState } from './types.js';

/** Provider id whose agents carry Conductor session and workspace fields. */
const CONDUCTOR_PROVIDER_ID = 'conductor';

/**
 * `agentCreated` for a freshly added agent. `seatId` is the adapter's saved
 * seat for this id (`adapter.loadSeats()[id]?.seatId`), so an agent adopted
 * after the client connected still lands in its persisted seat.
 */
export function agentCreatedMessage(id: number, agent: AgentState, seatId?: string): AgentCreated {
  return {
    type: 'agentCreated',
    id,
    directoryName: agent.directoryName,
    isExternal: agent.isExternal || undefined,
    palette: agent.palette,
    hueShift: agent.hueShift,
    isTeammate: agent.leadAgentId !== undefined || undefined,
    teammateName: agent.agentName,
    parentAgentId: agent.leadAgentId,
    teamName: agent.teamName,
    hooksOnly: agent.hooksOnly || undefined,
    providerId: agent.providerId,
    label: agent.label,
    seatId,
    species: agent.species,
    shiny: agent.shiny,
    level: agent.level,
  };
}

/**
 * `agentDetails` for an agent, or null when there is nothing to say beyond
 * what `agentCreated` already carried (a plain Claude agent without a Pokémon).
 * Absent fields mean unknown, never cleared.
 */
export function agentDetailsMessage(id: number, agent: AgentState): AgentDetails | null {
  const d = agent.details;
  if (!agent.providerId && !agent.label && !d && agent.species === undefined) return null;
  const conductorSessionId =
    agent.providerId === CONDUCTOR_PROVIDER_ID &&
    agent.sessionId.startsWith(`${CONDUCTOR_PROVIDER_ID}:`)
      ? agent.sessionId.slice(CONDUCTOR_PROVIDER_ID.length + 1)
      : undefined;
  return {
    type: 'agentDetails',
    id,
    providerId: agent.providerId,
    label: agent.label,
    externalUrl: d?.externalUrl,
    model: d?.model,
    harness: d?.harness,
    conductorSessionId,
    conductorWorkspaceId: d?.workspaceId,
    conductorWorkspaceName: d?.workspaceName,
    conductorWorkspaceNumber: d?.workspaceNumber,
    repo: d?.repo,
    creatorName: d?.creatorName,
    messageCount: d?.messageCount,
    lastActivityAt: d?.lastActivityAt,
    species: agent.species,
    shiny: agent.shiny,
    level: agent.level,
  };
}
