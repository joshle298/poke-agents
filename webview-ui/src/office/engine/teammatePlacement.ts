/**
 * Where a new teammate's character goes and what it looks like. Pure, so the
 * rule is unit-tested without React (the agentCreated handler calls it).
 *
 * Claude teammates keep upstream behaviour: the Lead's palette and
 * directory, seated beside the Lead. A stream teammate (a Conductor session
 * another session spawned) is its own session in its own repo, so it keeps
 * the palette and directory the server sent, and it clusters beside its Lead
 * only while the Lead has at most TEAMMATE_CLUSTER_MAX_CHILDREN visible
 * children — an orchestrator's dozens of children otherwise pile up around it
 * and drain every nearby seat.
 */

import { TEAMMATE_CLUSTER_MAX_CHILDREN } from '../../constants.js';

export interface TeammatePlacementInput {
  /** The teammate is fed by a stream provider (agentCreated carried providerId). */
  isStream: boolean;
  /** What agentCreated said about the teammate. */
  msg: { palette?: number; hueShift?: number; directoryName?: string };
  leadId: number;
  /** The Lead's character, when it is in the office. */
  lead?: { palette: number; hueShift: number; directoryName?: string };
  /** The Lead's visible children before this one is added. */
  visibleChildren: number;
}

export interface TeammatePlacement {
  palette?: number;
  hueShift?: number;
  directoryName?: string;
  /** Seat next to this agent; undefined = the usual seat search. */
  nearAgentId?: number;
}

export function placeTeammate(input: TeammatePlacementInput): TeammatePlacement {
  const { isStream, msg, lead, leadId } = input;
  if (!isStream) {
    return {
      palette: lead?.palette,
      hueShift: lead?.hueShift,
      directoryName: lead?.directoryName,
      nearAgentId: leadId,
    };
  }
  const ownPalette = msg.palette !== undefined;
  return {
    palette: ownPalette ? msg.palette : lead?.palette,
    hueShift: ownPalette ? msg.hueShift : lead?.hueShift,
    directoryName: msg.directoryName ?? lead?.directoryName,
    nearAgentId:
      lead && input.visibleChildren + 1 <= TEAMMATE_CLUSTER_MAX_CHILDREN ? leadId : undefined,
  };
}
