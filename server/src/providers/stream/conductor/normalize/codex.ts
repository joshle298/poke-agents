/**
 * Codex harness normalizer: `rawPayload = {event, thread_id}` (CN §5.3).
 *
 * - Turns: `turn.started` (repeats when a message arrives mid-turn), then
 *   `turn.completed` (usage, done) or `turn.failed` (error).
 * - Tools: `item.started` / `item.completed` pair on `item.id`. Items carrying
 *   `event.parentToolUseId` belong to a native sub-agent.
 * - `commandExecution` reads, searches and listings become Read/Grep/Glob,
 *   everything else Bash with the `/bin/bash -lc '…'` wrapper removed.
 * - `agentMessage` with `delivery:'async'` questions is a notice, not a wait.
 * - `error` with `willRetry` is a transient notice; otherwise it explains the
 *   next `turn.failed`.
 */

import * as path from 'path';

import { LOG_ASSISTANT_MAX, NOTICE_TEXT_MAX } from '../constants.js';
import { AGENT_WAIT_TOOL, COMPACT_TOOL, conductorToolName, SUBAGENT_SPAWN_TOOL } from '../tools.js';
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
} from './shared.js';

type Rec = Record<string, unknown>;

/** `/bin/bash -lc 'cmd'` → `cmd` (undoing the shell's `'\''` escaping). */
export function unwrapShellCommand(command: string): string {
  const match = /^\s*(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(
    command,
  );
  if (!match) return command;
  return match[1] === "'"
    ? match[2].replace(/'\\''/g, "'")
    : match[2].replace(/\\(["\\$`])/g, '$1');
}

interface ToolSpec {
  name: string;
  input: Rec;
}

function commandTool(item: Rec): ToolSpec {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  const first = asRecord(actions[0]);
  const actionCommand = asString(first?.command);
  const command = actionCommand ?? unwrapShellCommand(asString(item.command) ?? '');
  const target = asString(first?.path) ?? asString(first?.name);
  switch (first?.type) {
    case 'read':
      return { name: 'Read', input: { file_path: target ?? command, command } };
    case 'search':
      return {
        name: 'Grep',
        input: { pattern: asString(first.query) ?? '', path: target, command },
      };
    case 'listFiles':
      return { name: 'Glob', input: { path: target, command } };
    default:
      return { name: 'Bash', input: { command } };
  }
}

function fileChangeTool(item: Rec): ToolSpec {
  const changes = Array.isArray(item.changes) ? item.changes.map(asRecord) : [];
  const allAdds = changes.length > 0 && changes.every((c) => asRecord(c?.kind)?.type === 'add');
  return {
    name: allAdds ? 'Write' : 'Edit',
    input: { file_path: asString(changes[0]?.path) ?? '' },
  };
}

function webSearchTool(item: Rec): ToolSpec {
  const action = asRecord(item.action);
  const kind = asString(action?.type);
  if (kind === 'openPage' || kind === 'findInPage') {
    return { name: 'WebFetch', input: { url: asString(action?.url) ?? '' } };
  }
  return { name: 'WebSearch', input: { query: asString(item.query) ?? '' } };
}

/** Tool-like items; undefined for items that are not tools (reasoning, text). */
function toolForItem(item: Rec): ToolSpec | undefined {
  switch (item.type) {
    case 'commandExecution':
      return commandTool(item);
    case 'fileChange':
      return fileChangeTool(item);
    case 'mcpToolCall': {
      const server = asString(item.server) ?? 'mcp';
      const tool = asString(item.tool) ?? 'tool';
      return {
        name: conductorToolName(`mcp__${server}__${tool}`),
        input: asRecord(item.arguments) ?? {},
      };
    }
    case 'webSearch':
      return webSearchTool(item);
    case 'imageView':
      return { name: 'Read', input: { file_path: asString(item.path) ?? '' } };
    case 'plan':
      return { name: 'EnterPlanMode', input: {} };
    case 'sleep':
      return { name: 'Sleep', input: { durationMs: item.durationMs } };
    case 'contextCompaction':
      return { name: COMPACT_TOOL, input: {} };
    case 'collabAgentToolCall':
      return { name: AGENT_WAIT_TOOL, input: {} };
    default:
      return undefined;
  }
}

function agentLabel(item: Rec): string {
  const threads = Array.isArray(item.receiverThreads) ? item.receiverThreads : [];
  const nickname = asString(asRecord(threads[0])?.agentNickname);
  const agentPath = asString(item.agentPath);
  const base = agentPath ? path.basename(agentPath) : '';
  if (nickname && base) return `${nickname} (${base})`;
  return nickname || base || 'sub-agent';
}

function endCodexAgent(state: NormState, callId: string, out: ProviderEvent[]): void {
  closeTool(state, callId, out);
}

function handleSubAgentActivity(
  event: Rec,
  item: Rec,
  state: NormState,
  out: ProviderEvent[],
): void {
  const callId = asString(item.id);
  const threadId = asString(item.agentThreadId);
  if (item.kind === 'started' && event.type === 'item.started' && callId) {
    const description = agentLabel(item);
    state.codexAgents.set(callId, { description, threadId });
    if (threadId) state.codexAgentByThread.set(threadId, callId);
    openTool(state, callId, SUBAGENT_SPAWN_TOOL, { description }, out, true);
  } else if (item.kind === 'completed' && event.type === 'item.started' && threadId) {
    const spawn = state.codexAgentByThread.get(threadId);
    if (spawn) endCodexAgent(state, spawn, out);
  }
}

function codexUsageTokens(event: Rec, threadId: string | undefined): number {
  const usage = asRecord(event.usage);
  if (usage) {
    const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
    if (input + output > 0) return input + output;
  }
  const meta = asRecord(event.conductor_sdk_metadata);
  const reports = asRecord(meta?.codexUsage)?.reports;
  if (!Array.isArray(reports)) return 0;
  const own = reports
    .map(asRecord)
    .filter((r): r is Rec => !!r && (!threadId || r.threadId === threadId));
  const last = asRecord(own[own.length - 1]?.usage);
  if (!last) return 0;
  const input = typeof last.inputTokens === 'number' ? last.inputTokens : 0;
  const output = typeof last.outputTokens === 'number' ? last.outputTokens : 0;
  return input + output;
}

function handleItem(ci: ConductorItem, event: Rec, state: NormState, out: ProviderEvent[]): void {
  const item = asRecord(event.item);
  if (!item) return;
  const at = itemTime(ci);
  const itemId = asString(item.id);
  const parentToolId = asString(event.parentToolUseId);
  const started = event.type === 'item.started';

  if (item.type === 'userMessage') return; // mirror of the top-level user message
  if (item.type === 'subAgentActivity') {
    if (!parentToolId) handleSubAgentActivity(event, item, state, out);
    return;
  }

  if (parentToolId) {
    const tool = toolForItem(item);
    if (!tool || !itemId) return;
    if (started) {
      const spawn = state.codexAgents.get(parentToolId)?.description ?? '';
      openSubTool(state, parentToolId, itemId, tool.name, tool.input, out, spawn);
    } else closeSubTool(state, itemId, out);
    return;
  }

  if (started) startTurn(state, at, out);

  if (item.type === 'agentMessage') {
    if (started) return;
    const text = asString(item.text)?.trim();
    if (text) {
      out.push({
        kind: 'log',
        role: 'assistant',
        text: clipText(text, LOG_ASSISTANT_MAX),
        at,
        itemId: ci.id,
      });
    }
    const questions = Array.isArray(item.questions) ? item.questions : [];
    if (item.delivery === 'async' && questions.length > 0) {
      const title = asString(asRecord(questions[0])?.title) ?? text ?? 'Question';
      out.push({ kind: 'notice', text: clipText(title, NOTICE_TEXT_MAX), tone: 'info' });
    }
    return;
  }
  if (item.type === 'plan' && !started) {
    const text = asString(item.text)?.trim();
    if (text) {
      out.push({
        kind: 'log',
        role: 'assistant',
        text: clipText(text, LOG_ASSISTANT_MAX),
        at,
        itemId: ci.id,
      });
    }
  }

  const tool = toolForItem(item);
  if (!tool || !itemId) return;
  if (started) openTool(state, itemId, tool.name, tool.input, out);
  else closeTool(state, itemId, out);
}

export function normalizeCodexItem(item: ConductorItem, state: NormState): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  noteItem(item, state);
  if (item.type === 'userMessage') {
    handleUserMessage(item, state, out);
    return out;
  }
  const raw = rawPayload(item);
  const event = asRecord(raw?.event);
  if (item.type !== 'agent' || !raw || !event) return out;
  const threadId = asString(raw.thread_id);
  const at = itemTime(item);

  switch (event.type) {
    case 'turn.started':
      startTurn(state, at, out);
      return out;
    case 'turn.completed': {
      const meta = asRecord(event.conductor_sdk_metadata);
      const model = asString(meta?.model) ?? state.resolvedModel ?? state.model;
      if (model) state.model = model;
      reportUsage(state, codexUsageTokens(event, threadId), state.resolvedModel ?? model, out);
      endTurn(state, 'done', undefined, out);
      return out;
    }
    case 'turn.failed': {
      const message =
        asString(asRecord(event.error)?.message) ?? state.lastError ?? 'The turn failed';
      state.lastError = undefined;
      endTurn(state, 'error', message, out);
      return out;
    }
    case 'error': {
      const message = asString(event.message);
      if (event.willRetry === true) {
        out.push({
          kind: 'notice',
          text: clipText(message ?? 'Reconnecting', NOTICE_TEXT_MAX),
          tone: 'info',
        });
      } else if (message) {
        state.lastError = clipError(message);
      }
      return out;
    }
    case 'codex.subAgentStatus': {
      const callId = asString(event.parentToolUseId);
      if (!callId) return out;
      if (event.working === true && !state.openTools.has(callId)) {
        // Also a spawn that predates the replayed tail: it is working now.
        const description = state.codexAgents.get(callId)?.description ?? '';
        openTool(state, callId, SUBAGENT_SPAWN_TOOL, { description }, out, true);
      } else if (event.working === false) {
        endCodexAgent(state, callId, out);
      }
      return out;
    }
    case 'item.started':
    case 'item.completed':
      handleItem(item, event, state, out);
      return out;
    default:
      return out;
  }
}
