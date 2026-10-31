/**
 * Claude harness normalizer: Conductor wraps Claude Code's stream-json events
 * in `agent.content.rawPayload` (CN §5.1).
 *
 * - Turns: `system/session_state_changed` running → idle; `result` carries the
 *   outcome (and ends the turn itself only for feeds without state changes).
 * - Waiting: an open AskUserQuestion is Waiting for input; `requires_action`
 *   with an open ExitPlanMode is a Permission request.
 * - Usage: main-chain `message.usage` only; sub-agent records (non-null
 *   `parent_tool_use_id`) never move the gauge.
 * - Sub-agents: records with `parent_tool_use_id` are the Agent/Task spawn's own
 *   tool calls; background spawns stay open until `task_notification`.
 *
 * The Claude-shaped block handling is shared with the Cursor normalizer.
 */

import { extractContextTokens } from '../../../../contextUsage.js';
import { LOG_ASSISTANT_MAX } from '../constants.js';
import {
  ASK_USER_QUESTION_TOOL,
  COMPACT_TOOL,
  conductorToolName,
  formatConductorToolStatus,
} from '../tools.js';
import type { ConductorItem } from '../types.js';
import {
  asRecord,
  asString,
  clipError,
  clipText,
  closeSubTool,
  closeTool,
  endTurn,
  handleUserMessage,
  itemTime,
  type NormState,
  noteItem,
  openSubTool,
  openTool,
  type ProviderEvent,
  rawPayload,
  reportUsage,
  startTurn,
  type TurnOutcome,
} from './shared.js';

type Raw = Record<string, unknown>;

function contentBlocks(raw: Raw): Array<Record<string, unknown>> {
  const content = asRecord(raw.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => !!asRecord(b));
}

/** Text of a tool_result block's content (string or text blocks). */
export function toolResultText(block: Record<string, unknown>, raw?: Raw): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c) => asRecord(c))
      .filter((c): c is Record<string, unknown> => !!c && typeof c.text === 'string')
      .map((c) => c.text as string);
    if (parts.length > 0) return parts.join('\n');
  }
  const stdout = asString(asRecord(raw?.tool_use_result)?.stdout);
  return stdout ?? '';
}

/** The window the harness reports for the session's model in a `result`. */
function windowFromResult(raw: Raw, state: NormState): number | undefined {
  const usage = asRecord(raw.modelUsage);
  if (!usage) return undefined;
  const pick = (key: string | undefined) => {
    const entry = key ? asRecord(usage[key]) : undefined;
    const value = entry?.contextWindow;
    return typeof value === 'number' && value > 0 ? value : undefined;
  };
  const direct = pick(state.resolvedModel) ?? pick(state.model);
  if (direct) return direct;
  let best: number | undefined;
  for (const key of Object.keys(usage)) {
    const value = pick(key);
    if (value && (!best || value > best)) best = value;
  }
  return best;
}

function usageModel(state: NormState, raw: Raw): string | undefined {
  return state.resolvedModel ?? state.model ?? asString(asRecord(raw.message)?.model);
}

/** True when a tool_result says the tool keeps running in the background. */
function resultIsBackground(raw: Raw): boolean {
  const result = asRecord(raw.tool_use_result);
  if (!result) return false;
  return (
    result.isAsync === true ||
    result.status === 'async_launched' ||
    typeof result.backgroundTaskId === 'string' ||
    typeof result.taskId === 'string'
  );
}

function handleAssistant(
  item: ConductorItem,
  raw: Raw,
  state: NormState,
  out: ProviderEvent[],
): void {
  const message = asRecord(raw.message);
  if (raw.is_api_error_message === true) {
    const text = contentBlocks(raw)
      .map((b) => asString(b.text))
      .find((t) => !!t);
    if (text) state.lastApiError = clipError(text);
    return;
  }
  const model = asString(message?.model);
  if (model && model !== '<synthetic>') state.model = state.model ?? model;
  const parentToolId = asString(raw.parent_tool_use_id);
  const at = itemTime(item);

  if (parentToolId) {
    const spawn = asString(raw.task_description) ?? '';
    for (const block of contentBlocks(raw)) {
      if (block.type !== 'tool_use') continue;
      const id = asString(block.id);
      const name = conductorToolName(asString(block.name) ?? 'Unknown');
      if (id) openSubTool(state, parentToolId, id, name, block.input, out, spawn);
    }
    return;
  }

  for (const block of contentBlocks(raw)) {
    if (block.type === 'tool_use') {
      const id = asString(block.id);
      if (!id) continue;
      startTurn(state, at, out);
      const name = conductorToolName(asString(block.name) ?? 'Unknown');
      const input = asRecord(block.input) ?? {};
      openTool(state, id, name, input, out, input.run_in_background === true);
    } else if (block.type === 'text') {
      const text = asString(block.text)?.trim();
      if (text) {
        startTurn(state, at, out);
        out.push({
          kind: 'log',
          role: 'assistant',
          text: clipText(text, LOG_ASSISTANT_MAX),
          at,
          itemId: item.id,
        });
      }
    }
  }
  reportUsage(state, extractContextTokens(raw), usageModel(state, raw), out);
}

function handleToolResults(raw: Raw, state: NormState, out: ProviderEvent[]): void {
  const parentToolId = asString(raw.parent_tool_use_id);
  for (const block of contentBlocks(raw)) {
    if (block.type !== 'tool_result') continue;
    const toolId = asString(block.tool_use_id);
    if (!toolId) continue;
    if (parentToolId) {
      closeSubTool(state, toolId, out);
      continue;
    }
    const tool = state.openTools.get(toolId);
    if (!tool) continue;
    if (block.is_error !== true && (tool.runInBackground || resultIsBackground(raw))) {
      // Launched, still running: task_notification ends it.
      tool.runInBackground = true;
      continue;
    }
    closeTool(state, toolId, out);
  }
}

function resultOutcome(raw: Raw): TurnOutcome {
  const terminal = asString(raw.terminal_reason);
  if (terminal?.startsWith('aborted')) return 'aborted';
  return raw.is_error === true ? 'error' : 'done';
}

function handleResult(raw: Raw, state: NormState, out: ProviderEvent[]): void {
  const outcome = resultOutcome(raw);
  const errorMessage =
    outcome === 'error'
      ? (state.lastApiError ?? state.lastError ?? clipError(asString(raw.result)) ?? 'Error')
      : undefined;
  state.lastApiError = undefined;
  state.lastError = undefined;
  const window = windowFromResult(raw, state);
  if (window && window !== state.contextWindow) {
    state.contextWindow = window;
    const usage = state.lastUsage;
    if (usage) reportUsage(state, usage.tokens, usage.model, out, window);
  }
  if (state.sawSessionStateChanged) {
    state.pendingOutcome = { outcome, errorMessage };
  } else {
    endTurn(state, outcome, errorMessage, out);
  }
}

function openToolNamed(state: NormState, name: string): boolean {
  for (const tool of state.openTools.values()) if (tool.name === name) return true;
  return false;
}

function handleStateChanged(raw: Raw, at: number, state: NormState, out: ProviderEvent[]): void {
  const next = asString(raw.state);
  state.sawSessionStateChanged = true;
  if (next === 'running') {
    if (state.lastState === 'requires_action' && state.permissionPending) {
      state.permissionPending = false;
      out.push({ kind: 'permissionClear' });
    }
    startTurn(state, at, out);
  } else if (next === 'idle') {
    const pending = state.pendingOutcome ?? { outcome: 'done' as const };
    endTurn(state, pending.outcome, pending.errorMessage, out);
  } else if (next === 'requires_action') {
    // AskUserQuestion also passes through requires_action (and flips straight
    // back to running); it is already Waiting for input.
    if (!openToolNamed(state, ASK_USER_QUESTION_TOOL) && !state.permissionPending) {
      startTurn(state, at, out);
      state.permissionPending = true;
      out.push({ kind: 'permissionRequest' });
    }
  }
  if (next === 'running' || next === 'idle' || next === 'requires_action') state.lastState = next;
}

function handleSystem(item: ConductorItem, raw: Raw, state: NormState, out: ProviderEvent[]): void {
  const at = itemTime(item);
  switch (raw.subtype) {
    case 'session_state_changed':
      handleStateChanged(raw, at, state, out);
      return;
    case 'init': {
      const model = asString(raw.model);
      if (model) state.model = model;
      return;
    }
    case 'task_started': {
      const taskId = asString(raw.task_id);
      const toolId = asString(raw.tool_use_id);
      if (taskId && toolId) state.taskTools.set(taskId, toolId);
      const tool = toolId ? state.openTools.get(toolId) : undefined;
      if (tool && raw.is_backgrounded === true) tool.runInBackground = true;
      const description = asString(raw.description)?.trim();
      if (!tool && description) {
        // A task we have no tool call for (often run by a sub-agent whose own
        // records never reach this feed): still worth a line in the Pokédex.
        const label = raw.task_type === 'local_agent' ? 'Agent' : 'Bash';
        const input = label === 'Agent' ? { description } : { command: description };
        out.push({
          kind: 'log',
          role: 'tool',
          text: formatConductorToolStatus(label, input),
          at,
          itemId: item.id,
        });
      }
      return;
    }
    case 'task_updated': {
      const taskId = asString(raw.task_id);
      const toolId = taskId ? state.taskTools.get(taskId) : undefined;
      const tool = toolId ? state.openTools.get(toolId) : undefined;
      if (tool && asRecord(raw.patch)?.is_backgrounded === true) tool.runInBackground = true;
      return;
    }
    case 'task_notification': {
      const taskId = asString(raw.task_id);
      const toolId =
        asString(raw.tool_use_id) ?? (taskId ? state.taskTools.get(taskId) : undefined);
      if (taskId) state.taskTools.delete(taskId);
      if (toolId) closeTool(state, toolId, out);
      return;
    }
    case 'status': {
      if (raw.status === 'compacting' && !state.compactToolId) {
        state.compactToolId = `compact:${item.id}`;
        openTool(state, state.compactToolId, COMPACT_TOOL, {}, out);
      } else if (raw.status !== 'compacting' && state.compactToolId) {
        closeTool(state, state.compactToolId, out);
        state.compactToolId = undefined;
      }
      return;
    }
    case 'compact_boundary': {
      if (state.compactToolId) {
        closeTool(state, state.compactToolId, out);
        state.compactToolId = undefined;
      }
      const post = asRecord(raw.compact_metadata)?.post_tokens;
      if (typeof post === 'number') reportUsage(state, post, state.lastUsage?.model, out);
      return;
    }
    case 'api_retry':
      out.push({ kind: 'notice', text: 'Retrying after an API error', tone: 'info' });
      return;
    case 'code_change_published': {
      const repo = asString(raw.repo);
      if (raw.action === 'pushed') {
        out.push({
          kind: 'notice',
          text: repo ? `Pushed to ${repo}` : 'Pushed changes',
          tone: 'info',
        });
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Claude-shaped payload handling (Claude and Cursor). Returns false for
 * payload types it does not know, so a dialect can handle its own.
 */
export function handleClaudeShaped(
  item: ConductorItem,
  raw: Raw,
  state: NormState,
  out: ProviderEvent[],
): boolean {
  switch (raw.type) {
    case 'assistant':
      handleAssistant(item, raw, state, out);
      return true;
    case 'user':
      handleToolResults(raw, state, out);
      return true;
    case 'result':
      handleResult(raw, state, out);
      return true;
    case 'system':
      handleSystem(item, raw, state, out);
      return true;
    default:
      return false;
  }
}

export function normalizeClaudeItem(item: ConductorItem, state: NormState): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  noteItem(item, state);
  if (item.type === 'userMessage') {
    handleUserMessage(item, state, out);
    return out;
  }
  const raw = rawPayload(item);
  if (item.type !== 'agent' || !raw) return out;
  handleClaudeShaped(item, raw, state, out);
  return out;
}
