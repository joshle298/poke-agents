/**
 * Canonical tool names and Activity labels for Conductor sessions (CN §5.4).
 *
 * Every harness is normalized into Claude Code's tool vocabulary so the
 * webview's typing/reading animation and Subtask rules keep working. Status
 * text delegates to Claude's formatter for the names it already knows.
 */

import * as path from 'path';

import { TASK_DESCRIPTION_DISPLAY_MAX_LENGTH } from '../../../constants.js';
import { claudeProvider, formatToolStatus } from '../../hook/claude/claude.js';

/** Codex `collabAgentToolCall` (waiting on native sub-agents). Not a subagent
 *  spawn, so it must not be named Agent/Task. */
export const AGENT_WAIT_TOOL = 'AgentWait';
/** Context compaction (Claude `system/status`, Codex `contextCompaction`). */
export const COMPACT_TOOL = 'Compact';
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';

const RAW_TO_CANONICAL: ReadonlyMap<string, string> = new Map([
  ['grep', 'Grep'],
  ['bash', 'Bash'],
  ['glob', 'Glob'],
  ['read', 'Read'],
  ['edit', 'Edit'],
  ['write', 'Write'],
  ['updateTodos', 'TodoWrite'],
  ['readLints', 'Read'],
  ['delete', 'Write'],
  ['mcp__conductor__AskUserQuestion', ASK_USER_QUESTION_TOOL],
]);

export function conductorToolName(rawName: string): string {
  return RAW_TO_CANONICAL.get(rawName) ?? rawName;
}

export const CONDUCTOR_READING_TOOLS: ReadonlySet<string> = new Set([
  ...claudeProvider.readingTools,
  'ToolSearch',
  'Monitor',
]);

export const CONDUCTOR_SUBAGENT_TOOLS: ReadonlySet<string> = new Set(
  claudeProvider.subagentToolNames,
);

/** Unused by the poller (it never infers permissions), required by the interface. */
export const CONDUCTOR_PERMISSION_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  ...claudeProvider.permissionExemptTools,
  EXIT_PLAN_MODE_TOOL,
  'Monitor',
]);

export function isSubagentTool(toolName: string): boolean {
  return CONDUCTOR_SUBAGENT_TOOLS.has(toolName);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function formatConductorToolStatus(toolName: string, input?: unknown): string {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  switch (toolName) {
    case 'TodoWrite':
      return 'Updating todos';
    case 'Sleep':
      return 'Waiting';
    case EXIT_PLAN_MODE_TOOL:
      return 'Plan ready for review';
    case 'Monitor': {
      const desc = typeof inp.description === 'string' ? inp.description.trim() : '';
      return desc ? `Watching: ${clip(desc, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH)}` : 'Watching';
    }
    case COMPACT_TOOL:
      return 'Compacting context';
    case AGENT_WAIT_TOOL:
      return 'Waiting for subtasks';
    case 'ToolSearch':
      return 'Searching tools';
    case 'Read': {
      // Cursor's readLints reads a list of paths.
      if (typeof inp.file_path !== 'string' && Array.isArray(inp.paths)) {
        const first = inp.paths.find((p): p is string => typeof p === 'string');
        return first ? `Reading ${path.basename(first)}` : 'Reading';
      }
      return formatToolStatus(toolName, input);
    }
    default:
      break;
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return `Using ${mcp[1]}: ${mcp[2]}`;
  return formatToolStatus(toolName, input);
}
