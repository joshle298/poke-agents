/**
 * Agent status transitions shared by every event source: Claude hooks
 * (HookEventHandler) and stream providers (StreamAgentDriver). Each one
 * mutates the agent and broadcasts the same message sequence, so the office
 * renders a turn ending identically whatever reported it.
 */

import type { AgentStateStore } from './agentStateStore.js';
import { hasPromotedBackgroundAgent } from './teamUtils.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import { notifyBackgroundAgentCompleted } from './transcriptParser.js';
import type { AgentState } from './types.js';

/** What a transition needs besides the agent itself. */
export interface TransitionDeps {
  store: AgentStateStore;
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  /** Tool names that spawn sub-agents; their sub-agent maps go with them. */
  subagentToolNames: ReadonlySet<string>;
}

/**
 * End the agent's turn without announcing its new status: cancel its timers,
 * clear foreground tools (background agents survive), broadcast
 * `agentToolsClear`, and re-send the surviving background tools. Callers then
 * broadcast the status the turn ended in (`markAgentWaiting` sends waiting).
 */
export function endAgentTurn(agent: AgentState, agentId: number, deps: TransitionDeps): void {
  const { store, waitingTimers, permissionTimers, subagentToolNames } = deps;
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  // Clear foreground tools, preserve background agents (same logic as turn_duration handler).
  // ALWAYS send agentToolsClear at turn end -- even when activeToolIds is empty by now
  // (because tool_results already processed and removed them). Without this, stale
  // sub-agent characters and permission bubbles from the turn would never clear.
  for (const toolId of [...agent.activeToolIds]) {
    if (agent.backgroundAgentToolIds.has(toolId)) continue;
    agent.activeToolIds.delete(toolId);
    agent.activeToolStatuses.delete(toolId);
    const toolName = agent.activeToolNames.get(toolId);
    agent.activeToolNames.delete(toolId);
    if (toolName && subagentToolNames.has(toolName)) {
      agent.activeSubagentToolIds.delete(toolId);
      agent.activeSubagentToolNames.delete(toolId);
      // A foreground spawn dropped at Stop without a tool_result: stop its
      // shadow watch too, or it lingers until sessionEnd.
      notifyBackgroundAgentCompleted(agentId, toolId);
    }
  }
  store.broadcast({ type: 'agentToolsClear', id: agentId });
  // Re-send background agent tools to restore them after the clear.
  // toolName + runInBackground are REQUIRED: without them the webview can't
  // recognize the re-sent tool as a subagent spawn and never recreates the
  // Subtask sub-character (extractToolName("Subtask: ...") is not a tool).
  // Skip tools whose background agent was promoted to its own character.
  for (const toolId of agent.backgroundAgentToolIds) {
    if (hasPromotedBackgroundAgent(agentId, toolId, store)) continue;
    const status = agent.activeToolStatuses.get(toolId);
    if (status) {
      store.broadcast({
        type: 'agentToolStart',
        id: agentId,
        toolId,
        status,
        toolName: agent.activeToolNames.get(toolId),
        runInBackground: true,
        isTeammateSpawn: agent.teammateSpawnToolIds?.has(toolId) || undefined,
      });
    }
  }

  agent.isWaiting = true;
  agent.permissionSent = false;
  agent.hadToolsInTurn = false;
  agent.currentHookToolId = undefined;
}

/**
 * Transition agent to waiting state. Clears foreground tools (preserves background
 * agents), cancels timers, and notifies the webview. Same logic as the turn_duration
 * handler in transcriptParser.ts.
 *
 * `awaitingInput` = the agent asked the user something ("Waiting for input");
 * false = it finished its turn ("Done").
 */
export function markAgentWaiting(
  agent: AgentState,
  agentId: number,
  deps: TransitionDeps,
  awaitingInput = false,
): void {
  endAgentTurn(agent, agentId, deps);
  deps.store.broadcast({
    type: 'agentStatus',
    id: agentId,
    status: 'waiting',
    awaitingInput,
  });
}
