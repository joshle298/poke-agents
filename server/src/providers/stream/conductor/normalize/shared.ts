/**
 * State and helpers shared by the three dialect normalizers.
 *
 * A normalizer is a pure function `(item, state) => ProviderEvent[]`: it reads
 * one feed item, updates the per-session `NormState`, and returns canonical
 * agent events (for the sink) plus `log` entries (for the Pokédex). Replaying a
 * page through a fresh state reconstructs open tools, the waiting state, usage
 * and the last texts without touching the office.
 */

import type { AgentEvent } from '../../../../../../core/src/provider.js';
import { ERROR_MESSAGE_MAX } from '../constants.js';
import type { Harness } from '../harness.js';
import { ASK_USER_QUESTION_TOOL, isSubagentTool, SUBAGENT_SPAWN_TOOL } from '../tools.js';
import type { ConductorItem } from '../types.js';

export interface LogEvent {
  kind: 'log';
  role: 'user' | 'assistant' | 'tool';
  text: string;
  /** For role tool: the canonical tool name. */
  toolName?: string;
  /** Epoch ms. */
  at: number;
  /** Feed item id, so replays never duplicate an entry. */
  itemId: string;
  /** User messages sent by another session. */
  senderSessionId?: string;
  sessionIndex?: number;
}

export type ProviderEvent = AgentEvent | LogEvent;

export type TurnOutcome = 'done' | 'error' | 'aborted';

export interface OpenTool {
  name: string;
  input?: unknown;
  /** Outlives the turn (background Agent/Task, background Bash/Monitor). */
  runInBackground?: boolean;
}

export interface OpenSubTool {
  parentToolId: string;
  name: string;
  input?: unknown;
}

export interface NormState {
  harness?: Harness;
  /** The session's resolved model (from the session list), preferred for windows. */
  resolvedModel?: string;
  /** Model named by the feed (system/init, assistant records, codex metadata). */
  model?: string;
  /** Window stated by the harness (Claude result.modelUsage). */
  contextWindow?: number;
  openTools: Map<string, OpenTool>;
  openSubTools: Map<string, OpenSubTool>;
  turnOpen: boolean;
  /** Epoch ms of the item that opened the current turn. */
  turnStartedAt?: number;
  lastState?: 'running' | 'idle' | 'requires_action';
  permissionPending: boolean;
  /** An AskUserQuestion is open: Waiting for input. */
  awaiting: boolean;
  /** A question the agent asked without stopping (Codex `delivery: 'async'`),
   *  open until the next user message. */
  asyncQuestion?: { text: string; options?: string[] };
  sawSessionStateChanged: boolean;
  pendingOutcome?: { outcome: TurnOutcome; errorMessage?: string };
  /** Outcome of the last finished turn (seeds an errored agent). */
  lastOutcome?: { outcome: TurnOutcome; errorMessage?: string };
  lastApiError?: string;
  lastError?: string;
  lastUsage?: { tokens: number; model?: string; window?: number };
  compactToolId?: string;
  /** Claude background task id → tool_use_id. */
  taskTools: Map<string, string>;
  /** Codex native sub-agents: spawn call id → label and thread. */
  codexAgents: Map<string, { description: string; threadId?: string }>;
  codexAgentByThread: Map<string, string>;
  // Feed bookkeeping
  lastItemAt?: number;
  lastIndex?: number;
  lastItemType?: string;
  newestUserQueued: boolean;
  hasAgentItems: boolean;
}

export function createNormState(
  init: { harness?: Harness; resolvedModel?: string } = {},
): NormState {
  return {
    harness: init.harness,
    resolvedModel: init.resolvedModel,
    openTools: new Map(),
    openSubTools: new Map(),
    turnOpen: false,
    permissionPending: false,
    awaiting: false,
    sawSessionStateChanged: false,
    taskTools: new Map(),
    codexAgents: new Map(),
    codexAgentByThread: new Map(),
    newestUserQueued: false,
    hasAgentItems: false,
  };
}

// ── Small readers ──

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function itemTime(item: ConductorItem): number {
  return parseTime(item.receivedAt) ?? 0;
}

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function clipError(text: string | undefined): string | undefined {
  return text ? clipText(text, ERROR_MESSAGE_MAX) : undefined;
}

export function rawPayload(item: ConductorItem): Record<string, unknown> | undefined {
  return asRecord(item.content.rawPayload);
}

// ── Bookkeeping and user messages ──

export function noteItem(item: ConductorItem, state: NormState): void {
  const at = itemTime(item);
  if (at && (!state.lastItemAt || at >= state.lastItemAt)) state.lastItemAt = at;
  if (typeof item.sessionIndex === 'number' && item.sessionIndex > (state.lastIndex ?? 0)) {
    state.lastIndex = item.sessionIndex;
  }
  state.lastItemType = item.type;
  if (item.type === 'agent') state.hasAgentItems = true;
}

/**
 * A user message (any harness). It always means work is about to happen: a
 * message to an idle session starts a turn, one sent mid-turn joins it.
 */
export function handleUserMessage(
  item: ConductorItem,
  state: NormState,
  out: ProviderEvent[],
): void {
  const content = item.content;
  const text = asString(content.message) ?? '';
  const sender = asString(content.senderSessionId);
  const at = itemTime(item);
  state.newestUserQueued = content.state === 'queued';
  // A message from the user (or another session) answers an async question.
  state.asyncQuestion = undefined;
  if (text) {
    out.push({
      kind: 'log',
      role: 'user',
      text,
      at,
      itemId: item.id,
      senderSessionId: sender && sender !== item.sessionId ? sender : undefined,
      sessionIndex: item.sessionIndex,
    });
  }
  startTurn(state, at, out);
}

// ── Turn transitions ──

export function startTurn(state: NormState, at: number, out: ProviderEvent[]): void {
  if (state.turnOpen) return;
  state.turnOpen = true;
  state.turnStartedAt = at || state.turnStartedAt;
  state.lastOutcome = undefined;
  out.push({ kind: 'turnStart' });
}

/** Tools that survive a turn end in the runtime (it keeps background agents only). */
export function survivesTurnEnd(tool: OpenTool): boolean {
  return !!tool.runInBackground && isSubagentTool(tool.name);
}

export function endTurn(
  state: NormState,
  outcome: TurnOutcome,
  errorMessage: string | undefined,
  out: ProviderEvent[],
): void {
  if (state.permissionPending) {
    state.permissionPending = false;
    out.push({ kind: 'permissionClear' });
  }
  const event: AgentEvent = { kind: 'turnEnd', outcome };
  if (outcome === 'error' && errorMessage) event.errorMessage = clipError(errorMessage);
  out.push(event);
  state.turnOpen = false;
  state.awaiting = false;
  state.pendingOutcome = undefined;
  state.compactToolId = undefined;
  state.lastOutcome = {
    outcome,
    errorMessage: outcome === 'error' ? clipError(errorMessage) : undefined,
  };
  for (const [toolId, tool] of [...state.openTools]) {
    if (survivesTurnEnd(tool)) continue;
    state.openTools.delete(toolId);
    dropSubTools(state, toolId);
  }
}

// ── Tools ──

export function openTool(
  state: NormState,
  toolId: string,
  name: string,
  input: unknown,
  out: ProviderEvent[],
  runInBackground?: boolean,
): void {
  if (!toolId || state.openTools.has(toolId)) return;
  state.openTools.set(toolId, { name, input, runInBackground: runInBackground || undefined });
  const event: AgentEvent = { kind: 'toolStart', toolId, toolName: name, input };
  if (runInBackground) event.runInBackground = true;
  out.push(event);
  if (name === ASK_USER_QUESTION_TOOL) {
    state.awaiting = true;
    out.push({ kind: 'awaitingInput' });
  }
}

function dropSubTools(state: NormState, parentToolId: string): void {
  for (const [subId, sub] of [...state.openSubTools]) {
    if (sub.parentToolId === parentToolId) state.openSubTools.delete(subId);
  }
}

export function closeTool(state: NormState, toolId: string, out: ProviderEvent[]): void {
  const tool = state.openTools.get(toolId);
  if (!tool) return;
  for (const [subId, sub] of [...state.openSubTools]) {
    if (sub.parentToolId !== toolId) continue;
    state.openSubTools.delete(subId);
    out.push({ kind: 'subagentEnd', parentToolId: toolId, toolId: subId });
  }
  state.openTools.delete(toolId);
  out.push({ kind: 'toolEnd', toolId });
  if (tool.name === ASK_USER_QUESTION_TOOL && state.awaiting) {
    const stillAsking = [...state.openTools.values()].some(
      (t) => t.name === ASK_USER_QUESTION_TOOL,
    );
    if (!stillAsking) {
      state.awaiting = false;
      // Answered: the session is working again.
      if (state.turnOpen) out.push({ kind: 'turnStart' });
    }
  }
}

/**
 * A sub-agent's tool call. Its records prove the spawn is still running, so a
 * spawn we never saw start (it predates the replayed tail) is opened as a
 * background Agent with `spawnDescription`; it ends with its completion event.
 */
export function openSubTool(
  state: NormState,
  parentToolId: string,
  toolId: string,
  name: string,
  input: unknown,
  out: ProviderEvent[],
  spawnDescription = '',
): void {
  if (!toolId || state.openSubTools.has(toolId)) return;
  if (!state.openTools.has(parentToolId)) {
    openTool(
      state,
      parentToolId,
      SUBAGENT_SPAWN_TOOL,
      { description: spawnDescription },
      out,
      true,
    );
  }
  state.openSubTools.set(toolId, { parentToolId, name, input });
  out.push({ kind: 'subagentStart', parentToolId, toolId, toolName: name, input });
}

export function closeSubTool(state: NormState, toolId: string, out: ProviderEvent[]): void {
  const sub = state.openSubTools.get(toolId);
  if (!sub) return;
  state.openSubTools.delete(toolId);
  out.push({ kind: 'subagentEnd', parentToolId: sub.parentToolId, toolId });
}

/** Report a context snapshot unless it says nothing new. */
export function reportUsage(
  state: NormState,
  tokens: number,
  model: string | undefined,
  out: ProviderEvent[],
  windowOverride?: number,
): void {
  if (!(tokens > 0)) return;
  const window = windowOverride ?? state.contextWindow;
  const prev = state.lastUsage;
  if (prev && prev.tokens === tokens && prev.window === window && prev.model === model) return;
  state.lastUsage = { tokens, model, window };
  const event: AgentEvent = { kind: 'contextUsage', tokens };
  if (model) event.model = model;
  if (window) event.window = window;
  out.push(event);
}
