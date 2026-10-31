/**
 * The activity line of a character's status label, from its tools and
 * status. Pure and DOM-free (Node-tested).
 */

import type { ToolActivity } from '../types.js';

// Both turn-end states show the green checkmark bubble. A finished turn (Stop)
// shows ONLY the checkmark (the label falls through to its normal idle text);
// going idle waiting on the user (Notification(idle_prompt)) additionally
// surfaces this label. Driven by Character.waitingAwaitingInput.
export const WAITING_INPUT_ACTIVITY_TEXT = 'Waiting for input';
/** An active agent with no tool running yet (thinking, writing a reply). */
export const WORKING_ACTIVITY_TEXT = 'Working';
export const IDLE_ACTIVITY_TEXT = 'Idle';

/** Derive a short human-readable activity string from tools/status */
export function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  bubbleType: 'permission' | 'waiting' | null,
  waitingAwaitingInput: boolean,
  errorMessage?: string,
): string {
  // Only stream sessions report errors; upstream agents never reach this.
  if (errorMessage !== undefined) return errorMessage || 'Error';
  if (bubbleType === 'permission') return 'Needs approval';
  // Only the idle case ("Waiting for input") gets a dedicated label. A finished
  // turn (Stop, waitingAwaitingInput=false) falls through so the checkmark alone
  // signals "done", same as the original behavior.
  if (bubbleType === 'waiting' && waitingAwaitingInput) return WAITING_INPUT_ACTIVITY_TEXT;

  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval';
      return activeTool.status;
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }

  // Active with no tool yet: working, not idle (it sits at its desk).
  return isActive ? WORKING_ACTIVITY_TEXT : IDLE_ACTIVITY_TEXT;
}
