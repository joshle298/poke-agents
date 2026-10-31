/**
 * The demo's fake Conductor: synthetic sessions with queues of scripted
 * actions (tools, replies, messages between sessions, a question, an error),
 * played against script time and pushed into the office through the same
 * AgentEventSink the Conductor poller uses. User actions (send a message,
 * stop, deposit, withdraw, hide, pin, scope) change this state and nothing
 * else: nothing here touches the network or the disk.
 */

import type {
  ConductorScope,
  ConductorSessionSummary,
  SessionQuestion,
} from '../../../../../core/src/messages.js';
import type {
  AgentEvent,
  AgentEventSink,
  StreamSessionDetail,
  StreamSessionInfo,
} from '../../../../../core/src/provider.js';
import { DEFAULT_SCOPE } from '../conductor/constants.js';
import { sanitizeScope, scopeWindowMs } from '../conductor/state.js';
import {
  ASK_USER_QUESTION_TOOL,
  COMPACT_TOOL,
  formatConductorToolStatus,
} from '../conductor/tools.js';
import { canSeedSilently } from '../silentSeed.js';
import {
  DEMO_ACCOUNT,
  DEMO_BEGIN_SEC,
  DEMO_CONTINUED_CONTEXT_TOKENS,
  DEMO_CONTINUED_ID_BASE,
  DEMO_CREATOR_NAME,
  DEMO_DEEP_LINK_BASE,
  DEMO_DETAIL_ENTRIES,
  DEMO_DETAIL_TOOL_ROWS,
  DEMO_DETAILS_THROTTLE_MS,
  DEMO_EVENTS_PER_ADVANCE_MAX,
  DEMO_HISTORY_CURSOR_PATTERN,
  DEMO_HISTORY_PAGE,
  DEMO_RECEIVE_DELAY_SEC,
  DEMO_SAY_SEC,
  DEMO_SAY_TOKENS,
  DEMO_SESSIONS_ACTIVITY_THROTTLE_MS,
  DEMO_TOOL_TOKENS_BASE,
  DEMO_TOOL_TOKENS_PER_SEC,
  DEMO_TRANSCRIPT_MAX,
} from './constants.js';

export type DemoHarness = 'claude' | 'codex' | 'cursor';

/** One synthetic session, as the story defines it. */
export interface DemoSessionSpec {
  id: string;
  label: string;
  workspace: { id: string; name: string; number: number; repo: string };
  model: string;
  harness: DemoHarness;
  /** Context window when the model alone doesn't name one (Cursor models). */
  contextWindow?: number;
  /** The session that spawned this one. */
  leadId?: string;
  /** The first message (the task). */
  prompt: string;
  /** In the office when the demo starts; otherwise a spawn creates it. */
  present: boolean;
  /** Status at start (present sessions). */
  status: 'idle' | 'working';
  /** Feed items before the demo starts (the level). */
  messageCount: number;
  contextTokens: number;
  /** Present sessions: minutes since their last activity at start. */
  idleMinutes?: number;
  pinned?: boolean;
  hidden?: boolean;
  /** The create-session model id (Conductor's `model` alias) where `model`
   *  is the resolved one, e.g. `opus-5-5-1m` for `claude-opus-5-5[1m]`. */
  modelId?: string;
  /** Reasoning effort and fast mode, when the session was started with them. */
  effort?: string;
  fastMode?: boolean;
  /** Switch model: the session this one continues (linked as a handoff). */
  continuedFrom?: string;
}

/** A Switch model request, already validated against the catalog. */
export interface DemoContinuation {
  agent: DemoHarness;
  model: string;
  effort?: string;
  fastMode?: boolean;
  name: string;
  message: string;
}

/** One step in a session's queue. Durations are script seconds. */
export type DemoAction =
  /** Start (or keep) working, with nothing to log. */
  | { kind: 'begin' }
  /** A message the user typed, logged, then work starts. */
  | { kind: 'user'; text: string }
  | {
      kind: 'tool';
      name: string;
      input: Record<string, unknown>;
      secs: number;
      /** Context tokens the call adds (default: from its duration). */
      tokens?: number;
    }
  | { kind: 'say'; text: string; secs?: number }
  /** A message to another session. `reply` is what the receiver does with it
   *  (default: whatever the receiver does with a message, see DemoReplies). */
  | { kind: 'send'; to: string; text: string; reply?: DemoAction[] }
  /** Create a session (thrown out of this one) that starts on `work`. */
  | { kind: 'spawn'; child: string; work: DemoAction[] }
  /** A status check on another session (a `watched` link). */
  | { kind: 'watch'; target: string }
  /** An AskUserQuestion. The queue waits until a message answers it; `then`
   *  is what follows, given the answer. */
  | {
      kind: 'ask';
      question: string;
      header: string;
      options: readonly string[];
      then: (answer: string) => DemoAction[];
    }
  /** The turn ends with an error (the Pokémon faints). `revive` runs on the
   *  next message (Revive sends "continue"). */
  | { kind: 'fail'; error: string; revive?: DemoAction[] }
  /** Context compaction: the context drops to `to` tokens. */
  | { kind: 'compact'; secs: number; to: number }
  | { kind: 'wait'; secs: number }
  | { kind: 'end' }
  /** A script hook (deposit a session, ...). */
  | { kind: 'run'; fn: (world: DemoWorld) => void };

/** What sessions do with messages the story did not script (the user's). */
export interface DemoReplies {
  /** An idle session got a message. */
  reply(spec: DemoSessionSpec, text: string): DemoAction[];
  /** A fainted session got a message with no scripted revive. */
  revive(spec: DemoSessionSpec): DemoAction[];
  /** A busy session got a message: what it says before carrying on. */
  noted(spec: DemoSessionSpec): string;
  /** A session started to continue `from` with another model (Switch model):
   *  what it does first. */
  handoff(spec: DemoSessionSpec, from: DemoSessionSpec): DemoAction[];
}

type Entry = StreamSessionDetail['entries'][number];

interface DemoSession {
  spec: DemoSessionSpec;
  born: boolean;
  status: 'idle' | 'working' | 'error';
  errorMessage?: string;
  messageCount: number;
  contextTokens: number;
  lastActivityAt: number;
  hidden: boolean;
  pinned: boolean;
  archived: boolean;
  archivedAt?: number;
  adopted: boolean;
  /** Level and activity facts last sent (wall ms), and whether newer ones wait. */
  detailsAt: number;
  detailsDirty: boolean;
  queue: DemoAction[];
  /** Script ms before which the session is busy with its current action. */
  busyUntil: number;
  /** Script ms at which its newest queued work arrived (a message, a task). */
  readyAt: number;
  openTool?: { id: string; name: string; input: Record<string, unknown>; tokens: number };
  ask?: {
    toolId: string;
    input: Record<string, unknown>;
    question: SessionQuestion;
    then: (answer: string) => DemoAction[];
  };
  onRevive?: DemoAction[];
  prompt?: string;
  /** Full log, oldest first; `dropped` entries were cut from the front. */
  transcript: Entry[];
  dropped: number;
}

export interface DemoWorldOptions {
  sink: AgentEventSink;
  specs: readonly DemoSessionSpec[];
  replies: DemoReplies;
  /** Wall clock (epoch ms) for timestamps. */
  now: () => number;
  /** Synthetic history per present session (oldest first), before the start. */
  backstory?: (spec: DemoSessionSpec, startAt: number) => Entry[];
}

const MS_PER_SEC = 1_000;
const MS_PER_MIN = 60_000;

export function deepLinkFor(spec: DemoSessionSpec): string {
  return `${DEMO_DEEP_LINK_BASE}?id=${spec.workspace.id}&session=${spec.id}`;
}

function repoShortName(repo: string): string {
  return repo.split('/').pop() ?? repo;
}

export class DemoWorld {
  private readonly sink: AgentEventSink;
  private readonly replies: DemoReplies;
  private readonly now: () => number;
  private readonly sessions = new Map<string, DemoSession>();
  private readonly order: string[] = [];
  private readonly steps: Array<{ at: number; seq: number; run: (world: DemoWorld) => void }> = [];
  private stepSeq = 0;
  private keySeq = 0;
  private continued = 0;
  private scope: ConductorScope = { ...DEFAULT_SCOPE };
  /** How far the script may play (the player's clock). */
  private scriptNow = 0;
  /** Script time of the event being played: actions start exactly when the
   *  previous one ended, however coarse the player's ticks are, so the story
   *  is the same at every speed. */
  private eventAt = 0;

  private listsDirty = true;
  private sessionsCoreSig: string | null = null;
  private sessionsSig: string | null = null;
  private sessionsAt = 0;
  private statusSig: string | null = null;

  constructor(options: DemoWorldOptions) {
    this.sink = options.sink;
    this.replies = options.replies;
    this.now = options.now;
    const startAt = this.now();
    for (const spec of options.specs) {
      const lastActivityAt = startAt - (spec.idleMinutes ?? 0) * MS_PER_MIN;
      const session: DemoSession = {
        spec,
        born: spec.present,
        status: spec.present ? spec.status : 'idle',
        messageCount: spec.present ? spec.messageCount : 0,
        contextTokens: spec.contextTokens,
        lastActivityAt,
        hidden: spec.hidden === true,
        pinned: spec.pinned === true,
        archived: false,
        adopted: false,
        detailsAt: 0,
        detailsDirty: false,
        queue: [],
        busyUntil: 0,
        readyAt: 0,
        transcript: [],
        dropped: 0,
      };
      if (spec.present) {
        session.prompt = spec.prompt;
        session.transcript = options.backstory?.(spec, lastActivityAt) ?? [];
      }
      this.sessions.set(spec.id, session);
      this.order.push(spec.id);
    }
  }

  // ── Script API (the story) ─────────────────────────────────

  /** The office at start: links already known, then every visible session. */
  begin(): void {
    for (const session of this.sessions.values()) {
      const lead = session.spec.leadId;
      if (session.born && lead && this.sessions.get(lead)?.born) {
        this.sink.link({
          fromSessionId: lead,
          toSessionId: session.spec.id,
          kind: 'spawned',
          at: session.lastActivityAt,
          live: false,
        });
      }
    }
    this.refresh();
  }

  /** Append actions to a session's queue. */
  enqueue(sessionId: string, actions: readonly DemoAction[]): void {
    const session = this.sessions.get(sessionId);
    if (!session?.born || session.archived) return;
    this.queueUp(session, actions);
  }

  /** Run `fn` once script time reaches `atMs`. */
  at(atMs: number, run: (world: DemoWorld) => void): void {
    this.steps.push({ at: atMs, seq: this.stepSeq++, run });
    this.steps.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  /** A session's name, if it exists. */
  labelOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.spec.label;
  }

  status(sessionId: string): 'idle' | 'working' | 'error' | 'asking' | 'archived' | 'unborn' {
    const session = this.sessions.get(sessionId);
    if (!session?.born) return 'unborn';
    if (session.archived) return 'archived';
    if (session.ask) return 'asking';
    return session.status;
  }

  /** Play the script up to `scriptMs`: every timed step and session action
   *  due by then, in script-time order. */
  advance(scriptMs: number): void {
    this.scriptNow = Math.max(this.scriptNow, scriptMs);
    for (let played = 0; played < DEMO_EVENTS_PER_ADVANCE_MAX; played++) {
      const next = this.nextEvent();
      if (!next) break;
      this.eventAt = next.at;
      if (next.session) this.step(next.session);
      else this.steps.shift()!.run(this);
    }
    this.eventAt = this.scriptNow;
    for (const session of this.sessions.values()) this.pushDetails(session);
    this.flushLists();
  }

  /** The earliest due event: a timed step first on a tie, then sessions in order. */
  private nextEvent(): { at: number; session?: DemoSession } | null {
    let best: { at: number; session?: DemoSession } | null = null;
    const step = this.steps[0];
    if (step && step.at <= this.scriptNow) best = { at: step.at };
    for (const id of this.order) {
      const session = this.sessions.get(id)!;
      const at = this.nextActionAt(session);
      if (at !== undefined && at <= this.scriptNow && (!best || at < best.at)) {
        best = { at, session };
      }
    }
    return best;
  }

  /** When the session's next event is due (closing a tool, its next action,
   *  or the end of a turn with nothing left), if it has one. */
  private nextActionAt(session: DemoSession): number | undefined {
    if (!session.born || session.archived) return undefined;
    if (session.openTool) return session.busyUntil;
    if (session.ask) return undefined;
    if (session.queue.length === 0 && session.status !== 'working') return undefined;
    return Math.max(session.busyUntil, session.readyAt);
  }

  private queueUp(session: DemoSession, actions: readonly DemoAction[]): void {
    session.queue.push(...actions);
    session.readyAt = Math.max(session.readyAt, this.eventAt);
  }

  // ── User actions ───────────────────────────────────────────

  sendMessage(sessionId: string, text: string): void {
    const session = this.requireLive(sessionId);
    this.eventAt = this.scriptNow;
    this.receive(session, { text, key: this.nextKey('u') });
    this.flushLists();
  }

  stopSession(sessionId: string): void {
    const session = this.requireLive(sessionId);
    this.eventAt = this.scriptNow;
    session.queue = [];
    session.busyUntil = this.eventAt;
    if (session.status === 'working') this.endTurn(session, 'aborted');
    this.flushLists();
  }

  archive(sessionId: string): void {
    const session = this.requireLive(sessionId);
    session.queue = [];
    session.busyUntil = Math.min(session.busyUntil, this.eventAt);
    session.onRevive = undefined;
    if (session.status === 'working') this.endTurn(session, 'aborted');
    session.status = 'idle';
    session.errorMessage = undefined;
    session.archived = true;
    session.archivedAt = this.now();
    this.refresh();
  }

  restore(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.born || !session.archived) throw new Error('Session not found');
    session.archived = false;
    session.archivedAt = undefined;
    // A withdrawal counts as activity, so it lands inside the scope window.
    session.lastActivityAt = this.now();
    this.refresh();
  }

  setHidden(sessionId: string, hidden: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session?.born) return;
    session.hidden = hidden;
    this.refresh();
  }

  setPinned(sessionId: string, pinned: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session?.born) return;
    session.pinned = pinned;
    this.refresh();
  }

  getScope(): ConductorScope {
    return { ...this.scope };
  }

  setScope(scope: ConductorScope): void {
    this.scope = sanitizeScope(scope, this.scope);
    this.statusSig = null;
    this.refresh();
  }

  /**
   * Switch model: a new session in `fromId`'s workspace, started on `message`
   * with the chosen agent and model, linked to the original as a handoff
   * before it walks in (so the original throws it). Returns its id.
   */
  continueSession(fromId: string, request: DemoContinuation): string {
    const from = this.requireLive(fromId);
    this.eventAt = this.scriptNow;
    const id = `5e55de00-0000-4000-8000-${String(DEMO_CONTINUED_ID_BASE + ++this.continued).padStart(12, '0')}`;
    const at = this.now();
    const spec: DemoSessionSpec = {
      id,
      label: request.name,
      workspace: from.spec.workspace,
      model: request.model,
      modelId: request.model,
      harness: request.agent,
      contextWindow: request.model.endsWith('-1m') ? 1_000_000 : undefined,
      prompt: request.message,
      present: false,
      status: 'working',
      messageCount: 0,
      contextTokens: DEMO_CONTINUED_CONTEXT_TOKENS,
      continuedFrom: fromId,
    };
    if (request.effort) spec.effort = request.effort;
    if (request.fastMode) spec.fastMode = true;
    const session: DemoSession = {
      spec,
      born: true,
      status: 'working',
      messageCount: 0,
      contextTokens: spec.contextTokens,
      lastActivityAt: at,
      hidden: false,
      pinned: false,
      archived: false,
      adopted: false,
      detailsAt: 0,
      detailsDirty: false,
      queue: [...this.replies.handoff(spec, from.spec)],
      busyUntil: this.eventAt + DEMO_RECEIVE_DELAY_SEC * MS_PER_SEC,
      readyAt: this.eventAt,
      prompt: request.message,
      transcript: [],
      dropped: 0,
    };
    this.sessions.set(id, session);
    this.order.push(id);
    const key = this.nextKey('m');
    // The link first: the new session is then created as the original's
    // (thrown out of it), without making the original a delegating Lead.
    this.sink.link({
      fromSessionId: fromId,
      toSessionId: id,
      kind: 'spawned',
      at,
      preview: request.message,
      live: true,
      handoff: true,
    });
    this.log(from, {
      role: 'peerOut',
      text: request.message,
      peerSessionId: id,
      key: `peerOut:${key}`,
    });
    this.log(session, { role: 'user', text: request.message, key: this.nextKey('u') });
    this.count(session, 1);
    this.refresh();
    return id;
  }

  // ── Reads (Pokédex, Sessions modal, PC Box) ────────────────

  listSessions(): ConductorSessionSummary[] {
    const now = this.now();
    const out: ConductorSessionSummary[] = [];
    for (const id of this.order) {
      const session = this.sessions.get(id)!;
      if (!session.born) continue;
      if (session.archived || this.inWindow(session, now)) out.push(this.summary(session));
    }
    return out.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  }

  getDetail(sessionId: string): StreamSessionDetail | null {
    const session = this.sessions.get(sessionId);
    if (!session?.born) return null;
    const picked: Entry[] = [];
    let toolRows = 0;
    for (let i = session.transcript.length - 1; i >= 0; i--) {
      if (picked.length >= DEMO_DETAIL_ENTRIES) break;
      const entry = session.transcript[i];
      if (entry.role === 'tool' && ++toolRows > DEMO_DETAIL_TOOL_ROWS) continue;
      picked.push(this.withPeerLabel(entry));
    }
    picked.reverse();
    const detail: StreamSessionDetail = { entries: picked };
    if (session.prompt) detail.prompt = session.prompt;
    if (picked.length < session.transcript.length || session.dropped > 0) detail.truncated = true;
    if (session.ask) detail.question = session.ask.question;
    return detail;
  }

  getHistory(
    sessionId: string,
    before?: string,
  ): { entries: Entry[]; before?: string; hasMore: boolean } {
    const session = this.sessions.get(sessionId);
    if (!session?.born) throw new Error('Session not found');
    const first = session.dropped;
    let end = first + session.transcript.length;
    if (before !== undefined) {
      const match = DEMO_HISTORY_CURSOR_PATTERN.exec(before);
      if (!match) throw new Error('Invalid history cursor');
      end = Math.min(end, Number(match[1]));
    }
    const start = Math.max(first, end - DEMO_HISTORY_PAGE);
    const entries = session.transcript
      .slice(Math.max(0, start - first), Math.max(0, end - first))
      .map((entry) => this.withPeerLabel(entry));
    const hasMore = start > first;
    return hasMore ? { entries, before: `t${start}`, hasMore } : { entries, hasMore };
  }

  // ── The runner ─────────────────────────────────────────────

  /** The session's due event: close its tool, run its next action, or end
   *  its turn when nothing is left. */
  private step(session: DemoSession): void {
    if (session.openTool) {
      this.closeTool(session);
      return;
    }
    const action = session.queue.shift();
    if (action) this.exec(session, action);
    else if (session.status === 'working') this.endTurn(session, 'done');
  }

  private exec(session: DemoSession, action: DemoAction): void {
    switch (action.kind) {
      case 'begin':
        this.startTurn(session);
        return this.busy(session, DEMO_BEGIN_SEC);
      case 'user':
        this.log(session, { role: 'user', text: action.text, key: this.nextKey('u') });
        this.count(session, 1);
        this.startTurn(session);
        return this.busy(session, DEMO_BEGIN_SEC);
      case 'tool':
        this.startTurn(session);
        this.openTool(session, action.name, action.input, action.tokens ?? toolTokens(action.secs));
        return this.busy(session, action.secs);
      case 'say':
        this.startTurn(session);
        this.log(session, { role: 'assistant', text: action.text, key: this.nextKey('a') });
        session.contextTokens += DEMO_SAY_TOKENS;
        this.count(session, 1);
        return this.busy(session, action.secs ?? DEMO_SAY_SEC);
      case 'send':
        this.startTurn(session);
        return this.deliver(session, action.to, action.text, action.reply);
      case 'spawn':
        this.startTurn(session);
        return this.spawn(session, action.child, action.work);
      case 'watch':
        this.startTurn(session);
        if (this.sessions.get(action.target)?.born) {
          this.sink.link({
            fromSessionId: session.spec.id,
            toSessionId: action.target,
            kind: 'watched',
            at: this.now(),
            live: true,
          });
        }
        return;
      case 'ask':
        this.startTurn(session);
        return this.openAsk(session, action);
      case 'fail':
        return this.fail(session, action.error, action.revive);
      case 'compact':
        this.startTurn(session);
        this.openTool(session, COMPACT_TOOL, {}, action.to - session.contextTokens);
        return this.busy(session, action.secs);
      case 'wait':
        return this.busy(session, action.secs);
      case 'end':
        if (session.status === 'working') this.endTurn(session, 'done');
        return;
      case 'run':
        action.fn(this);
        return;
    }
  }

  private busy(session: DemoSession, secs: number): void {
    session.busyUntil = this.eventAt + secs * MS_PER_SEC;
  }

  private startTurn(session: DemoSession): void {
    if (session.status === 'working') return;
    session.status = 'working';
    session.errorMessage = undefined;
    this.emit(session, { kind: 'turnStart' });
    this.touch(session);
    this.refreshIfScoped();
  }

  private endTurn(session: DemoSession, outcome: 'done' | 'aborted'): void {
    if (session.openTool) this.closeTool(session);
    if (session.ask) {
      this.emit(session, { kind: 'toolEnd', toolId: session.ask.toolId });
      session.ask = undefined;
    }
    session.status = 'idle';
    this.emit(session, { kind: 'turnEnd', outcome });
    this.touch(session);
    this.refreshIfScoped();
  }

  private fail(session: DemoSession, error: string, revive: DemoAction[] | undefined): void {
    if (session.openTool) this.closeTool(session);
    session.queue = [];
    session.status = 'error';
    session.errorMessage = error;
    session.onRevive = revive;
    this.log(session, { role: 'assistant', text: `Error: ${error}`, key: this.nextKey('e') });
    this.count(session, 1);
    this.emit(session, { kind: 'turnEnd', outcome: 'error', errorMessage: error });
    this.touch(session);
    this.listsDirty = true;
  }

  private openTool(
    session: DemoSession,
    name: string,
    input: Record<string, unknown>,
    tokens: number,
  ): void {
    const id = this.nextKey('tool');
    session.openTool = { id, name, input, tokens };
    this.emit(session, { kind: 'toolStart', toolId: id, toolName: name, input });
    this.log(session, {
      role: 'tool',
      text: formatConductorToolStatus(name, input),
      toolName: name,
      key: `tool:${id}`,
    });
    this.count(session, 1);
  }

  private closeTool(session: DemoSession): void {
    const tool = session.openTool;
    if (!tool) return;
    session.openTool = undefined;
    this.emit(session, { kind: 'toolEnd', toolId: tool.id });
    session.contextTokens = Math.max(1, session.contextTokens + tool.tokens);
    this.reportContext(session);
    this.count(session, 1);
  }

  private openAsk(session: DemoSession, action: Extract<DemoAction, { kind: 'ask' }>): void {
    const toolId = this.nextKey('tool');
    const input = {
      questions: [
        {
          question: action.question,
          header: action.header,
          multiSelect: false,
          options: action.options.map((label) => ({ label })),
        },
      ],
    };
    session.ask = {
      toolId,
      input,
      question: { kind: 'askUser', text: action.question, options: [...action.options] },
      then: action.then,
    };
    this.emit(session, {
      kind: 'toolStart',
      toolId,
      toolName: ASK_USER_QUESTION_TOOL,
      input,
    });
    this.emit(session, { kind: 'awaitingInput' });
    this.log(session, {
      role: 'tool',
      text: formatConductorToolStatus(ASK_USER_QUESTION_TOOL, input),
      toolName: ASK_USER_QUESTION_TOOL,
      key: `tool:${toolId}`,
    });
    this.count(session, 1);
    this.listsDirty = true;
  }

  /** A message reached `session` (from the user, or from `from`). */
  private receive(
    session: DemoSession,
    message: { text: string; key: string; from?: string },
    reply?: DemoAction[],
  ): void {
    if (message.from) {
      this.log(session, {
        role: 'peerIn',
        text: message.text,
        peerSessionId: message.from,
        key: `peerIn:${message.key}`,
      });
    } else {
      this.log(session, { role: 'user', text: message.text, key: message.key });
    }
    this.count(session, 1);
    if (session.ask) {
      this.answer(session, message.text, reply ?? []);
      return;
    }
    if (session.status === 'error') {
      const revive = session.onRevive ?? reply ?? this.replies.revive(session.spec);
      session.onRevive = undefined;
      this.queueUp(session, [
        { kind: 'wait', secs: DEMO_RECEIVE_DELAY_SEC },
        { kind: 'begin' },
        ...revive,
      ]);
      return;
    }
    if (session.status === 'working') {
      // Conductor queues it; the session acknowledges it and carries on.
      if (reply) this.queueUp(session, [{ kind: 'begin' }, ...reply]);
      else session.queue.unshift({ kind: 'say', text: this.replies.noted(session.spec) });
      return;
    }
    this.queueUp(session, [
      { kind: 'wait', secs: DEMO_RECEIVE_DELAY_SEC },
      { kind: 'begin' },
      ...(reply ?? this.replies.reply(session.spec, message.text)),
    ]);
  }

  /** The open question is answered: the session works again. */
  private answer(session: DemoSession, text: string, extra: DemoAction[]): void {
    const ask = session.ask!;
    session.ask = undefined;
    this.emit(session, { kind: 'toolEnd', toolId: ask.toolId });
    this.count(session, 1);
    this.emit(session, { kind: 'turnStart' });
    session.status = 'working';
    session.queue = [...ask.then(text.trim()), ...extra, ...session.queue];
    session.busyUntil = this.eventAt + DEMO_RECEIVE_DELAY_SEC * MS_PER_SEC;
    this.listsDirty = true;
  }

  private deliver(
    from: DemoSession,
    toId: string,
    text: string,
    reply: DemoAction[] | undefined,
  ): void {
    const to = this.sessions.get(toId);
    if (!to?.born || to.archived) return;
    const key = this.nextKey('m');
    this.sink.link({
      fromSessionId: from.spec.id,
      toSessionId: toId,
      kind: 'messaged',
      at: this.now(),
      preview: text,
      live: true,
    });
    this.log(from, { role: 'peerOut', text, peerSessionId: toId, key: `peerOut:${key}` });
    this.receive(to, { text, key, from: from.spec.id }, reply);
  }

  private spawn(lead: DemoSession, childId: string, work: DemoAction[]): void {
    const child = this.sessions.get(childId);
    if (!child || child.born) return;
    const key = this.nextKey('m');
    const at = this.now();
    child.born = true;
    child.status = 'working';
    child.lastActivityAt = at;
    child.prompt = child.spec.prompt;
    child.messageCount = 0;
    child.queue = [...work];
    child.readyAt = this.eventAt;
    child.busyUntil = this.eventAt + DEMO_RECEIVE_DELAY_SEC * MS_PER_SEC;
    // The link first: the child is then created as the Lead's (thrown out of it).
    this.sink.link({
      fromSessionId: lead.spec.id,
      toSessionId: childId,
      kind: 'spawned',
      at,
      preview: child.spec.prompt,
      live: true,
    });
    this.log(lead, {
      role: 'peerOut',
      text: child.spec.prompt,
      peerSessionId: childId,
      key: `peerOut:${key}`,
    });
    this.log(child, {
      role: 'peerIn',
      text: child.spec.prompt,
      peerSessionId: lead.spec.id,
      key: `peerIn:${key}`,
    });
    this.count(child, 1);
    this.refresh();
  }

  // ── Office membership ──────────────────────────────────────

  private inWindow(session: DemoSession, now: number): boolean {
    return now - session.lastActivityAt <= scopeWindowMs(this.scope);
  }

  /** Re-run membership only when the scope can depend on the status. */
  private refreshIfScoped(): void {
    this.listsDirty = true;
    if (!this.scope.showIdle) this.refresh();
  }

  /** Which sessions are in the office (scope, hide, deposit, cap), and adopt
   *  or remove agents to match. */
  private refresh(): void {
    const now = this.now();
    const eligible = this.order
      .map((id) => this.sessions.get(id)!)
      .filter(
        (s) =>
          s.born &&
          !s.archived &&
          !s.hidden &&
          (s.pinned || this.inWindow(s, now)) &&
          (this.scope.showIdle || s.pinned || s.status !== 'idle'),
      );
    const bucket = (s: DemoSession): number => {
      if (s.pinned) return 0;
      if (s.ask) return 1;
      if (s.status === 'working') return 2;
      if (s.status === 'error') return 3;
      return 4;
    };
    const ranked = [...eligible].sort(
      (a, b) =>
        bucket(a) - bucket(b) ||
        b.lastActivityAt - a.lastActivityAt ||
        this.order.indexOf(a.spec.id) - this.order.indexOf(b.spec.id),
    );
    const visible = new Set(
      ranked.filter((s, i) => s.pinned || i < this.scope.maxSessions).map((s) => s.spec.id),
    );
    for (const id of this.order) {
      const session = this.sessions.get(id)!;
      if (session.adopted && !visible.has(id)) {
        session.adopted = false;
        this.sink.removeSession(id, session.archived ? 'archived' : 'scope');
      }
    }
    // Children before their Lead: a Lead created with a child already in the
    // office is a Lead (a legendary) from its first frame.
    const joining = this.order
      .map((id) => this.sessions.get(id)!)
      .filter((s) => visible.has(s.spec.id) && !s.adopted)
      .sort((a, b) => Number(!a.spec.leadId) - Number(!b.spec.leadId));
    for (const session of joining) this.adopt(session);
    this.listsDirty = true;
    this.flushLists();
  }

  private adopt(session: DemoSession): void {
    session.adopted = true;
    session.detailsDirty = false;
    session.detailsAt = this.now();
    const spec = session.spec;
    const info: StreamSessionInfo = {
      sessionId: spec.id,
      label: spec.label,
      directoryName: repoShortName(spec.workspace.repo),
      details: this.details(session),
    };
    if (spec.leadId && this.sessions.get(spec.leadId)?.born) info.leadSessionId = spec.leadId;
    if (session.status === 'working') info.initialStatus = 'active';
    if (session.status === 'error') {
      info.initialStatus = 'error';
      info.errorMessage = session.errorMessage;
    }
    const seed = (): void => {
      this.sink.upsertSession(info);
      const tool = session.openTool;
      if (tool) {
        this.sink.emit(spec.id, {
          kind: 'toolStart',
          toolId: tool.id,
          toolName: tool.name,
          input: tool.input,
        });
      }
      if (session.ask) {
        this.sink.emit(spec.id, {
          kind: 'toolStart',
          toolId: session.ask.toolId,
          toolName: ASK_USER_QUESTION_TOOL,
          input: session.ask.input,
        });
        this.sink.emit(spec.id, { kind: 'awaitingInput' });
      }
      this.reportContext(session);
    };
    if (canSeedSilently(this.sink)) this.sink.seedSilently(spec.id, seed);
    else seed();
  }

  private details(session: DemoSession): NonNullable<StreamSessionInfo['details']> {
    const spec = session.spec;
    return {
      externalUrl: deepLinkFor(spec),
      model: spec.model,
      ...(spec.modelId ? { modelId: spec.modelId } : {}),
      harness: spec.harness,
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.fastMode !== undefined ? { fastMode: spec.fastMode } : {}),
      workspaceId: spec.workspace.id,
      workspaceName: spec.workspace.name,
      workspaceNumber: spec.workspace.number,
      repo: spec.workspace.repo,
      creatorName: DEMO_CREATOR_NAME,
      messageCount: session.messageCount,
      lastActivityAt: session.lastActivityAt,
    };
  }

  // ── Session list and status ────────────────────────────────

  private summary(session: DemoSession): ConductorSessionSummary {
    const spec = session.spec;
    const summary: ConductorSessionSummary = {
      sessionId: spec.id,
      label: spec.label,
      workspaceId: spec.workspace.id,
      workspaceName: spec.workspace.name,
      workspaceNumber: spec.workspace.number,
      repo: spec.workspace.repo,
      model: spec.model,
      harness: spec.harness,
      status:
        session.status === 'error' ? 'error' : session.status === 'working' ? 'working' : 'idle',
      lastActivityAt: session.lastActivityAt,
      hidden: session.hidden,
      externalUrl: deepLinkFor(spec),
      creatorName: DEMO_CREATOR_NAME,
    };
    if (session.pinned) summary.pinned = true;
    if (session.archived) {
      summary.archived = true;
      if (session.archivedAt) summary.archivedAt = session.archivedAt;
    }
    if (spec.leadId) summary.leadSessionId = spec.leadId;
    else if (spec.continuedFrom) {
      summary.leadSessionId = spec.continuedFrom;
      summary.handoff = true;
    }
    return summary;
  }

  /** Session list and status, when they changed (activity times alone at most
   *  every DEMO_SESSIONS_ACTIVITY_THROTTLE_MS, like the Conductor poller). */
  private flushLists(): void {
    if (!this.listsDirty) return;
    this.listsDirty = false;
    const now = this.now();
    const sessions = this.listSessions();
    const sig = JSON.stringify(sessions);
    const coreSig = JSON.stringify(sessions.map((s) => ({ ...s, lastActivityAt: undefined })));
    if (
      sig !== this.sessionsSig &&
      (coreSig !== this.sessionsCoreSig ||
        now - this.sessionsAt >= DEMO_SESSIONS_ACTIVITY_THROTTLE_MS)
    ) {
      this.sessionsSig = sig;
      this.sessionsCoreSig = coreSig;
      this.sessionsAt = now;
      this.sink.sessionsChanged(sessions);
    } else if (sig !== this.sessionsSig) {
      this.listsDirty = true; // activity only: send it with a later flush
    }
    let visibleCount = 0;
    const workspaces = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.adopted) visibleCount++;
      if (session.born && !session.archived) workspaces.add(session.spec.workspace.id);
    }
    const status = {
      state: 'connected' as const,
      account: DEMO_ACCOUNT,
      workspaceCount: workspaces.size,
      sessionCount: sessions.filter((s) => !s.archived).length,
      visibleCount,
      scope: this.getScope(),
    };
    const statusSig = JSON.stringify(status);
    if (statusSig !== this.statusSig) {
      this.statusSig = statusSig;
      this.sink.setStatus(status);
    }
  }

  // ── Plumbing ───────────────────────────────────────────────

  private requireLive(sessionId: string): DemoSession {
    const session = this.sessions.get(sessionId);
    if (!session?.born || session.archived) throw new Error('Session not found');
    return session;
  }

  private emit(session: DemoSession, event: AgentEvent): void {
    if (session.adopted) this.sink.emit(session.spec.id, event);
  }

  private reportContext(session: DemoSession): void {
    if (!(session.contextTokens > 0)) return;
    const event: AgentEvent = {
      kind: 'contextUsage',
      tokens: session.contextTokens,
      model: session.spec.model,
    };
    if (session.spec.contextWindow) event.window = session.spec.contextWindow;
    this.emit(session, event);
  }

  /** New feed items: the level, and the Pokédex facts. */
  private count(session: DemoSession, items: number): void {
    session.messageCount += items;
    this.touch(session);
    session.detailsDirty = true;
    this.pushDetails(session);
  }

  /** Send the level and activity facts, at most every DEMO_DETAILS_THROTTLE_MS
   *  per session (advance() sends what waited). */
  private pushDetails(session: DemoSession): void {
    if (!session.detailsDirty || !session.adopted) return;
    const now = this.now();
    if (now - session.detailsAt < DEMO_DETAILS_THROTTLE_MS) return;
    session.detailsDirty = false;
    session.detailsAt = now;
    this.sink.upsertSession({
      sessionId: session.spec.id,
      details: {
        messageCount: session.messageCount,
        lastActivityAt: session.lastActivityAt,
      },
    });
  }

  private touch(session: DemoSession): void {
    session.lastActivityAt = this.now();
    this.listsDirty = true;
  }

  private log(session: DemoSession, entry: Omit<Entry, 'at'>): void {
    session.transcript.push({ ...entry, at: this.now() });
    if (session.transcript.length > DEMO_TRANSCRIPT_MAX) {
      session.transcript.shift();
      session.dropped++;
    }
  }

  private withPeerLabel(entry: Entry): Entry {
    if (!entry.peerSessionId) return { ...entry };
    const label = this.sessions.get(entry.peerSessionId)?.spec.label;
    return label ? { ...entry, peerLabel: label } : { ...entry };
  }

  private nextKey(prefix: string): string {
    return `demo-${prefix}-${++this.keySeq}`;
  }
}

/** Context a tool call adds, from how long it ran. */
function toolTokens(secs: number): number {
  return Math.round(DEMO_TOOL_TOKENS_BASE + secs * DEMO_TOOL_TOKENS_PER_SEC);
}
