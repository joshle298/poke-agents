/**
 * Session-to-session links (CN §10.2 A-C). No I/O: everything is derived from
 * feed items, and time comes from their `receivedAt`.
 *
 * A. Receiver side: a user message with `senderSessionId` is authoritative.
 *    Item #1 (`sessionIndex === 1`) is a spawn, anything later a message.
 * B. Sender side: Conductor CLI calls in Bash / commandExecution /
 *    RunLocalCommand commands, completed by parsing the CLI's JSON or text
 *    output. Only these reveal `watched` edges (session message/status/get).
 * C. Merge: the CLI's "Message ID" equals the receiver's `content.id`, so the
 *    two sides of one message collapse into one edge. A sender edge without a
 *    message id merges with a receiver edge of the same (from, kind) within
 *    ±120 s. Sender edges whose target never resolved are dropped after 10 min.
 *
 * Each spawned/messaged edge is emitted exactly once, whichever side is seen
 * first; every watch is emitted (the runtime counts them).
 */

import type { AgentLinkEvent } from '../../../../../core/src/provider.js';
import {
  LINK_MEMORY_MAX,
  LINK_MERGE_WINDOW_MS,
  LINK_PREVIEW_MAX,
  PENDING_EDGE_TTL_MS,
} from './constants.js';
import { toolResultText } from './normalize/claude.js';
import { unwrapShellCommand } from './normalize/codex.js';
import { asRecord, asString, clipText, itemTime, rawPayload } from './normalize/shared.js';
import type { ConductorItem } from './types.js';

export type LinkKind = AgentLinkEvent['kind'];

export type CliVerb =
  | 'workspace.create'
  | 'session.create'
  | 'message.create'
  | 'session.message'
  | 'session.status'
  | 'session.get'
  | 'session.cancel'
  | 'workspace.status';

export interface CliCall {
  verb: CliVerb;
  kind: LinkKind;
  targetSessionId?: string;
  targetWorkspaceId?: string;
  /** From `--message-id` (idempotency id = receiver's content.id). */
  messageId?: string;
  /** Inline `--message` text. */
  preview?: string;
}

export interface CliOutputRecord {
  sessionId?: string;
  workspaceId?: string;
  messageId?: string;
  deepLink?: string;
}

export type LinkEvidence = 'senderSessionId' | 'toolCall' | 'toolOutput';

export interface LinkEdge {
  key: string;
  from: string;
  to?: string;
  toWorkspaceId?: string;
  kind: LinkKind;
  verb?: CliVerb;
  at: number;
  lastAt: number;
  count: number;
  preview?: string;
  messageId?: string;
  evidence: LinkEvidence[];
  /** Sender-side edge whose target is not known yet. */
  pending?: boolean;
  receiverSeen: boolean;
  senderSeen: boolean;
  emitted: boolean;
}

export interface LinkObservation {
  /** Link events for the sink, in order, with the edge each one belongs to. */
  emit: Array<{ event: AgentLinkEvent; edge: LinkEdge }>;
  /** Emitted edges that just gained a better (receiver-side) preview. */
  previewUpdates: LinkEdge[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEEP_LINK =
  /conductor(?:-[a-z0-9-]+)?:\/\/workspace\?id=([0-9a-f-]{36})(?:&session=([0-9a-f-]{36}))?/i;
const TEXT_FIELD = /^\s*(Workspace ID|Session ID|ID|Message ID|Deep link)\s+(\S+)\s*$/;

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--session',
  '--workspace',
  '--message',
  '--message-file',
  '--message-id',
  '--session-id',
  '--after',
  '--before',
  '--limit',
  '--offset',
  '--name',
  '--model',
  '--effort',
  '--agent',
  '--attach',
  '--channel',
  '--token',
  '--project-id',
  '--repo-url',
  '--branch',
  '--session-name',
  '--env',
  '--creator',
  '--state',
  '--since',
  '--repo',
]);
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'exec',
  'command',
  'time',
  'nohup',
  'sudo',
]);
const WATCH_VERBS: ReadonlyMap<string, CliVerb> = new Map([
  ['message', 'session.message'],
  ['status', 'session.status'],
  ['get', 'session.get'],
  ['cancel', 'session.cancel'],
]);
const NOUNS: ReadonlyMap<string, 'workspace' | 'session' | 'message'> = new Map([
  ['workspace', 'workspace'],
  ['workspaces', 'workspace'],
  ['session', 'session'],
  ['sessions', 'session'],
  ['message', 'message'],
  ['messages', 'message'],
]);

// ── Shell parsing ──

/**
 * Split a shell command into simple commands (on unquoted `;`, `&&`, `||`,
 * `|`, `&`, newlines, parentheses and `$(`), each a list of unquoted tokens.
 * Not a shell: just enough quoting to read CLI arguments.
 */
export function splitShellCommands(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  const endToken = () => {
    if (inToken) tokens.push(current);
    current = '';
    inToken = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) {
        current += command[++i];
      } else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') {
        current += command[i + 1];
        inToken = true;
      }
      i++;
    } else if (ch === '$' && command[i + 1] === '(') {
      endSegment();
      i++;
    } else if (';|&\n()`'.includes(ch)) {
      endSegment();
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endToken();
    } else {
      current += ch;
      inToken = true;
    }
  }
  endSegment();
  return segments;
}

function basename(token: string): string {
  const slash = token.lastIndexOf('/');
  return slash >= 0 ? token.slice(slash + 1) : token;
}

function conductorIndex(tokens: string[]): number {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (basename(token) === 'conductor') return i;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || COMMAND_WRAPPERS.has(token)) continue;
    return -1;
  }
  return -1;
}

function parseArgs(tokens: string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq > 0 ? token.slice(0, eq) : token;
      let value = eq > 0 ? token.slice(eq + 1) : '';
      if (eq < 0 && VALUE_FLAGS.has(name) && i + 1 < tokens.length) value = tokens[++i];
      if (!flags.has(name)) flags.set(name, value);
    } else if (token.startsWith('-') && token.length > 1) {
      continue;
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function uuidOrUndefined(value: string | undefined): string | undefined {
  return value && UUID.test(value) ? value.toLowerCase() : undefined;
}

function parseCliSegment(tokens: string[]): CliCall | undefined {
  const start = conductorIndex(tokens);
  if (start < 0) return undefined;
  let i = start + 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const name = tokens[i].split('=')[0];
    i += VALUE_FLAGS.has(name) && !tokens[i].includes('=') ? 2 : 1;
  }
  const noun = NOUNS.get(tokens[i] ?? '');
  const verb = tokens[i + 1];
  if (!noun || !verb) return undefined;
  const { flags, positional } = parseArgs(tokens.slice(i + 2));
  const inline = flags.get('--message');
  const preview = inline ? clipText(inline, LINK_PREVIEW_MAX) : undefined;
  const firstUuid = uuidOrUndefined(positional[0]);
  if (noun === 'workspace' && verb === 'create') {
    return { verb: 'workspace.create', kind: 'spawned', preview };
  }
  if (noun === 'workspace' && verb === 'status' && firstUuid) {
    return { verb: 'workspace.status', kind: 'watched', targetWorkspaceId: firstUuid };
  }
  if (noun === 'session' && verb === 'create') {
    return {
      verb: 'session.create',
      kind: 'spawned',
      targetSessionId: uuidOrUndefined(flags.get('--session-id')),
      targetWorkspaceId: uuidOrUndefined(flags.get('--workspace')),
      messageId: uuidOrUndefined(flags.get('--message-id')),
      preview,
    };
  }
  const watchVerb = WATCH_VERBS.get(verb);
  if (noun === 'session' && firstUuid && watchVerb) {
    return { verb: watchVerb, kind: 'watched', targetSessionId: firstUuid };
  }
  if (noun === 'message' && verb === 'create') {
    const target = uuidOrUndefined(flags.get('--session'));
    if (!target) return undefined;
    return {
      verb: 'message.create',
      kind: 'messaged',
      targetSessionId: target,
      messageId: uuidOrUndefined(flags.get('--message-id')),
      preview,
    };
  }
  return undefined;
}

/** Every Conductor CLI call in a shell command (nested `bash -lc '…'` included). */
export function parseConductorCommands(command: string, depth = 0): CliCall[] {
  const calls: CliCall[] = [];
  for (const tokens of splitShellCommands(command)) {
    const shell = basename(tokens[0] ?? '');
    if (
      depth < 2 &&
      (shell === 'bash' || shell === 'sh' || shell === 'zsh') &&
      /^-l?c$/.test(tokens[1] ?? '') &&
      tokens[2]
    ) {
      calls.push(...parseConductorCommands(tokens[2], depth + 1));
      continue;
    }
    const call = parseCliSegment(tokens);
    if (call) calls.push(call);
  }
  return calls;
}

// ── CLI output parsing ──

export function parseDeepLink(text: string | undefined): {
  workspaceId?: string;
  sessionId?: string;
} {
  const match = text ? DEEP_LINK.exec(text) : null;
  if (!match) return {};
  return { workspaceId: match[1]?.toLowerCase(), sessionId: match[2]?.toLowerCase() };
}

/** Balanced top-level `{…}` objects in free text, parsed in order. */
function extractJsonObjects(
  text: string,
): Array<{ index: number; value: Record<string, unknown> }> {
  const found: Array<{ index: number; value: Record<string, unknown> }> = [];
  let i = text.indexOf('{');
  while (i >= 0 && i < text.length) {
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (ch === '\\') j++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) break;
    try {
      const value = asRecord(JSON.parse(text.slice(i, end + 1)));
      if (value) found.push({ index: i, value });
      i = text.indexOf('{', end + 1);
    } catch {
      i = text.indexOf('{', i + 1);
    }
  }
  return found;
}

function recordFromJson(obj: Record<string, unknown>): CliOutputRecord | undefined {
  const deepLink = asString(obj.deepLink);
  const link = parseDeepLink(deepLink);
  const initial = asRecord(obj.initialMessage);
  const record: CliOutputRecord = {
    sessionId:
      uuidOrUndefined(asString(obj.sessionId)) ??
      link.sessionId ??
      (deepLink ? uuidOrUndefined(asString(obj.id)) : undefined),
    workspaceId: uuidOrUndefined(asString(obj.workspaceId)) ?? link.workspaceId,
    messageId:
      uuidOrUndefined(asString(initial?.messageId)) ?? uuidOrUndefined(asString(obj.messageId)),
    deepLink,
  };
  return record.sessionId || record.messageId ? record : undefined;
}

/** Records (one per CLI result) in output order, from JSON or the CLI's text tables. */
export function parseCliOutput(output: string): CliOutputRecord[] {
  const positioned: Array<{ index: number; record: CliOutputRecord }> = [];
  for (const { index, value } of extractJsonObjects(output)) {
    const record = recordFromJson(value);
    if (record) positioned.push({ index, record });
  }
  let current: CliOutputRecord | undefined;
  let currentIndex = 0;
  let offset = 0;
  const flush = () => {
    if (current && (current.sessionId || current.messageId)) {
      positioned.push({ index: currentIndex, record: current });
    }
    current = undefined;
  };
  for (const line of output.split('\n')) {
    const match = TEXT_FIELD.exec(line);
    if (match) {
      const key = match[1];
      const value = match[2];
      const field: keyof CliOutputRecord =
        key === 'Workspace ID'
          ? 'workspaceId'
          : key === 'Message ID'
            ? 'messageId'
            : key === 'Deep link'
              ? 'deepLink'
              : 'sessionId';
      if (current && current[field] !== undefined) flush();
      if (!current) {
        current = {};
        currentIndex = offset;
      }
      if (field === 'deepLink') {
        current.deepLink = value;
        const link = parseDeepLink(value);
        current.sessionId = current.sessionId ?? link.sessionId;
        current.workspaceId = current.workspaceId ?? link.workspaceId;
      } else {
        const id = uuidOrUndefined(value);
        if (id) current[field] = id;
      }
    }
    offset += line.length + 1;
  }
  flush();
  positioned.sort((a, b) => a.index - b.index);
  return positioned.map((p) => p.record);
}

function outputLooksFailed(output: string): boolean {
  return /^error:/im.test(output);
}

// ── Tool-call extraction from feed items ──

interface PendingToolCall {
  calls: CliCall[];
}

/** Shell command text of a tool call, if it is one that can run the CLI. */
function claudeToolCommand(name: string, input: Record<string, unknown>): string | undefined {
  if (name === 'Bash' || name === 'bash' || name === 'mcp__conductor__RunLocalCommand') {
    return asString(input.command);
  }
  return undefined;
}

function codexItemCommand(item: Record<string, unknown>): string | undefined {
  if (item.type === 'commandExecution') {
    const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
    const fromActions = actions
      .map((a) => asString(asRecord(a)?.command))
      .filter((c): c is string => !!c);
    if (fromActions.length > 0) return fromActions.join('\n');
    const command = asString(item.command);
    return command ? unwrapShellCommand(command) : undefined;
  }
  if (
    item.type === 'mcpToolCall' &&
    item.server === 'conductor' &&
    item.tool === 'RunLocalCommand'
  ) {
    return asString(asRecord(item.arguments)?.command);
  }
  return undefined;
}

function codexItemOutput(item: Record<string, unknown>): string {
  const aggregated = asString(item.aggregatedOutput);
  if (aggregated) return aggregated;
  const content = asRecord(item.result)?.content;
  if (Array.isArray(content)) {
    return content
      .map((c) => asString(asRecord(c)?.text))
      .filter((t): t is string => !!t)
      .join('\n');
  }
  return '';
}

function codexItemFailed(item: Record<string, unknown>): boolean {
  if (item.status === 'failed') return true;
  return typeof item.exitCode === 'number' && item.exitCode !== 0;
}

// ── Tracker ──

export class LinkTracker {
  private readonly edges = new Map<string, LinkEdge>();
  private readonly byMessageId = new Map<string, string>();
  private readonly pendingCalls = new Map<string, PendingToolCall>();
  /** Observations already applied (replays and overlapping pages are no-ops). */
  private readonly seen = new Map<string, true>();
  private nextPendingId = 0;

  /** Feed one item of `sessionId`'s feed. */
  observe(sessionId: string, item: ConductorItem, opts: { live: boolean }): LinkObservation {
    const result: LinkObservation = { emit: [], previewUpdates: [] };
    const at = itemTime(item);
    if (item.type === 'userMessage') {
      this.observeReceiver(sessionId, item, at, opts.live, result);
      return result;
    }
    if (item.type !== 'agent') return result;
    const raw = rawPayload(item);
    if (!raw) return result;
    const event = asRecord(raw.event);
    if (event) {
      this.observeCodex(sessionId, event, at, opts.live, result);
      return result;
    }
    const blocks = asRecord(raw.message)?.content;
    if (!Array.isArray(blocks)) return result;
    for (const b of blocks) {
      const block = asRecord(b);
      if (!block) continue;
      if (raw.type === 'assistant' && block.type === 'tool_use') {
        const toolId = asString(block.id);
        const command = claudeToolCommand(asString(block.name) ?? '', asRecord(block.input) ?? {});
        if (toolId && command) this.startCall(sessionId, toolId, command);
      } else if (raw.type === 'user' && block.type === 'tool_result') {
        const toolId = asString(block.tool_use_id);
        if (!toolId) continue;
        const output = toolResultText(block, raw);
        this.completeCall(
          sessionId,
          toolId,
          undefined,
          output,
          block.is_error === true,
          at,
          opts.live,
          result,
        );
      }
    }
    return result;
  }

  /** Drop sender edges whose target never resolved (the CLI may have failed). */
  prune(now: number): void {
    for (const [key, edge] of this.edges) {
      if (edge.pending && now - edge.at > PENDING_EDGE_TTL_MS) this.edges.delete(key);
    }
    if (this.edges.size > LINK_MEMORY_MAX) {
      const oldest = [...this.edges.values()].sort((a, b) => a.lastAt - b.lastAt);
      for (const edge of oldest.slice(0, this.edges.size - LINK_MEMORY_MAX)) {
        this.edges.delete(edge.key);
        if (edge.messageId) this.byMessageId.delete(edge.messageId);
      }
    }
  }

  /** Resolved edges (both ends known). */
  allEdges(): LinkEdge[] {
    return [...this.edges.values()].filter((e) => !e.pending && e.to);
  }

  /** Sessions directly linked to `sessionId` in either direction. */
  neighbors(sessionId: string): Set<string> {
    const out = new Set<string>();
    for (const edge of this.edges.values()) {
      if (edge.pending || !edge.to) continue;
      if (edge.from === sessionId) out.add(edge.to);
      else if (edge.to === sessionId) out.add(edge.from);
    }
    return out;
  }

  // ── internals ──

  private markSeen(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.set(key, true);
    if (this.seen.size > LINK_MEMORY_MAX * 2) {
      const first = this.seen.keys().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
    return true;
  }

  private observeReceiver(
    receiver: string,
    item: ConductorItem,
    at: number,
    live: boolean,
    result: LinkObservation,
  ): void {
    const sender = asString(item.content.senderSessionId)?.toLowerCase();
    if (!sender || sender === receiver.toLowerCase()) return;
    const messageId = (asString(item.content.id) ?? item.id).toLowerCase();
    if (!this.markSeen(`rx:${receiver}:${messageId}`)) return;
    const kind: LinkKind = item.sessionIndex === 1 ? 'spawned' : 'messaged';
    const text = asString(item.content.message);
    const preview = text ? clipText(text, LINK_PREVIEW_MAX) : undefined;

    let edge = this.edgeForMessage(messageId);
    if (!edge) edge = this.findSenderCandidate(sender, receiver, kind, at);
    if (edge) {
      const hadPreview = edge.preview;
      edge.to = receiver;
      edge.messageId = messageId;
      edge.pending = false;
      edge.receiverSeen = true;
      if (preview) edge.preview = preview;
      this.addEvidence(edge, 'senderSessionId');
      this.byMessageId.set(messageId, edge.key);
      if (!edge.emitted) this.emitEdge(edge, live, result);
      else if (preview && preview !== hadPreview) result.previewUpdates.push(edge);
      return;
    }
    edge = {
      key: `${kind}:${messageId}`,
      from: sender,
      to: receiver,
      kind,
      at,
      lastAt: at,
      count: 1,
      preview,
      messageId,
      evidence: ['senderSessionId'],
      receiverSeen: true,
      senderSeen: false,
      emitted: false,
    };
    this.edges.set(edge.key, edge);
    this.byMessageId.set(messageId, edge.key);
    this.emitEdge(edge, live, result);
  }

  private observeCodex(
    sessionId: string,
    event: Record<string, unknown>,
    at: number,
    live: boolean,
    result: LinkObservation,
  ): void {
    const item = asRecord(event.item);
    const toolId = asString(item?.id);
    if (!item || !toolId) return;
    if (event.type === 'item.started') {
      const command = codexItemCommand(item);
      if (command) this.startCall(sessionId, toolId, command);
    } else if (event.type === 'item.completed') {
      const command = codexItemCommand(item);
      if (!command) return;
      this.completeCall(
        sessionId,
        toolId,
        command,
        codexItemOutput(item),
        codexItemFailed(item),
        at,
        live,
        result,
      );
    }
  }

  private startCall(sessionId: string, toolId: string, command: string): void {
    const calls = parseConductorCommands(command);
    if (calls.length > 0) this.pendingCalls.set(`${sessionId}\n${toolId}`, { calls });
  }

  private completeCall(
    from: string,
    toolId: string,
    command: string | undefined,
    output: string,
    failed: boolean,
    at: number,
    live: boolean,
    result: LinkObservation,
  ): void {
    const key = `${from}\n${toolId}`;
    const pending = this.pendingCalls.get(key);
    this.pendingCalls.delete(key);
    const calls = pending?.calls ?? (command ? parseConductorCommands(command) : []);
    if (calls.length === 0) return;
    if (!this.markSeen(`tc:${from}:${toolId}`)) return;
    if (failed || outputLooksFailed(output)) return;

    const records = parseCliOutput(output);
    const take = (want: (r: CliOutputRecord) => boolean): CliOutputRecord | undefined => {
      const index = records.findIndex(want);
      return index >= 0 ? records.splice(index, 1)[0] : undefined;
    };
    const watchedTargets = new Set<string>();

    calls.forEach((call, index) => {
      if (call.kind === 'watched') {
        const target = call.targetSessionId;
        if (!target || target === from || watchedTargets.has(target)) return;
        watchedTargets.add(target);
        this.recordWatch(from, target, call, at, live, result);
        return;
      }
      if (call.kind === 'messaged') {
        const record = take((r) => !!r.messageId);
        this.mergeSender(
          {
            from,
            to: call.targetSessionId,
            kind: 'messaged',
            verb: call.verb,
            messageId: call.messageId ?? record?.messageId,
            preview: call.preview,
            at,
          },
          `${toolId}:${index}`,
          live,
          result,
        );
        return;
      }
      const record = take((r) => !!r.sessionId && (!!r.deepLink || !!r.messageId));
      this.mergeSender(
        {
          from,
          to: call.targetSessionId ?? record?.sessionId,
          toWorkspaceId: call.targetWorkspaceId ?? record?.workspaceId,
          kind: 'spawned',
          verb: call.verb,
          messageId: call.messageId ?? record?.messageId,
          preview: call.preview,
          at,
        },
        `${toolId}:${index}`,
        live,
        result,
      );
    });
  }

  private recordWatch(
    from: string,
    to: string,
    call: CliCall,
    at: number,
    live: boolean,
    result: LinkObservation,
  ): void {
    const key = `watched:${from}>${to}`;
    let edge = this.edges.get(key);
    if (edge) {
      edge.count += 1;
      edge.lastAt = Math.max(edge.lastAt, at);
      edge.verb = call.verb;
    } else {
      edge = {
        key,
        from,
        to,
        kind: 'watched',
        verb: call.verb,
        at,
        lastAt: at,
        count: 1,
        evidence: ['toolCall'],
        receiverSeen: false,
        senderSeen: true,
        emitted: false,
      };
      this.edges.set(key, edge);
    }
    edge.emitted = true;
    result.emit.push({
      event: { fromSessionId: from, toSessionId: to, kind: 'watched', at, live },
      edge,
    });
  }

  private mergeSender(
    obs: {
      from: string;
      to?: string;
      toWorkspaceId?: string;
      kind: LinkKind;
      verb: CliVerb;
      messageId?: string;
      preview?: string;
      at: number;
    },
    callKey: string,
    live: boolean,
    result: LinkObservation,
  ): void {
    if (obs.to === obs.from) return;
    let edge = obs.messageId ? this.edgeForMessage(obs.messageId) : undefined;
    if (!edge && !obs.messageId)
      edge = this.findReceiverCandidate(obs.from, obs.to, obs.kind, obs.at);
    if (edge) {
      edge.senderSeen = true;
      edge.verb = obs.verb;
      edge.to = edge.to ?? obs.to;
      edge.toWorkspaceId = edge.toWorkspaceId ?? obs.toWorkspaceId;
      edge.preview = edge.preview ?? obs.preview;
      this.addEvidence(edge, 'toolCall');
      this.addEvidence(edge, 'toolOutput');
      if (edge.to) edge.pending = false;
      if (!edge.emitted && edge.to) this.emitEdge(edge, live, result);
      return;
    }
    edge = {
      key: obs.messageId
        ? `${obs.kind}:${obs.messageId}`
        : `${obs.kind}:${obs.from}>${obs.to ?? '?'}#${callKey}#${this.nextPendingId++}`,
      from: obs.from,
      to: obs.to,
      toWorkspaceId: obs.toWorkspaceId,
      kind: obs.kind,
      verb: obs.verb,
      at: obs.at,
      lastAt: obs.at,
      count: 1,
      preview: obs.preview,
      messageId: obs.messageId,
      evidence: obs.to || obs.messageId ? ['toolCall', 'toolOutput'] : ['toolCall'],
      pending: !obs.to,
      receiverSeen: false,
      senderSeen: true,
      emitted: false,
    };
    this.edges.set(edge.key, edge);
    if (obs.messageId) this.byMessageId.set(obs.messageId, edge.key);
    if (edge.to) this.emitEdge(edge, live, result);
  }

  private edgeForMessage(messageId: string): LinkEdge | undefined {
    const key = this.byMessageId.get(messageId);
    return key ? this.edges.get(key) : undefined;
  }

  private findSenderCandidate(
    from: string,
    to: string,
    kind: LinkKind,
    at: number,
  ): LinkEdge | undefined {
    for (const edge of this.edges.values()) {
      if (!edge.senderSeen || edge.receiverSeen || edge.messageId) continue;
      if (edge.from !== from || edge.kind !== kind) continue;
      if (edge.to && edge.to !== to) continue;
      if (Math.abs(edge.at - at) <= LINK_MERGE_WINDOW_MS) return edge;
    }
    return undefined;
  }

  private findReceiverCandidate(
    from: string,
    to: string | undefined,
    kind: LinkKind,
    at: number,
  ): LinkEdge | undefined {
    for (const edge of this.edges.values()) {
      if (!edge.receiverSeen || edge.senderSeen) continue;
      if (edge.from !== from || edge.kind !== kind) continue;
      if (to && edge.to !== to) continue;
      if (Math.abs(edge.at - at) <= LINK_MERGE_WINDOW_MS) return edge;
    }
    return undefined;
  }

  private addEvidence(edge: LinkEdge, evidence: LinkEvidence): void {
    if (!edge.evidence.includes(evidence)) edge.evidence.push(evidence);
  }

  private emitEdge(edge: LinkEdge, live: boolean, result: LinkObservation): void {
    if (!edge.to) return;
    edge.emitted = true;
    const event: AgentLinkEvent = {
      fromSessionId: edge.from,
      toSessionId: edge.to,
      kind: edge.kind,
      at: edge.at,
      live,
    };
    if (edge.preview) event.preview = edge.preview;
    result.emit.push({ event, edge });
  }
}
