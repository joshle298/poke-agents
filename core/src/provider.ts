/**
 * Provider abstraction for AI agent tools.
 *
 * Two provider kinds ship: HookProvider (Claude Code: hooks plus a transcript
 * fallback) and StreamProvider (Conductor: an in-process poller that pushes
 * canonical events into the runtime through an AgentEventSink).
 */

import type {
  ConductorScope,
  ConductorSessionSummary,
  ConductorStatus,
  FavoriteModel,
  ModelCatalogAgent,
  SessionDetailEntry,
  SessionQuestion,
} from './messages.js';
import type { TeamProvider } from './teamProvider.js';

// ── Normalized Events (all provider types produce these) ──────

export type AgentEvent =
  | {
      kind: 'toolStart';
      toolId: string;
      toolName: string;
      input?: unknown;
      /** True when the tool was spawned to run in the background (e.g. Claude's
       *  `run_in_background` on Agent/Task). Handlers use this to suppress ghost
       *  sub-agent characters for teammate spawns. */
      runInBackground?: boolean;
    }
  | { kind: 'toolEnd'; toolId: string }
  | {
      kind: 'turnEnd';
      /** True when the turn ended because the agent went idle waiting on the
       *  user (Claude's Notification(idle_prompt)) rather than simply finishing
       *  its response (Stop). Drives the "Waiting for input" vs "Done" label.
       *  Absent/false = the agent finished its turn (Done). */
      awaitingInput?: boolean;
      /** Stream providers only. 'error' shows the agent as errored with
       *  `errorMessage`; 'aborted' (user interrupt or rejection) reads as Done.
       *  Absent = 'done'. */
      outcome?: 'done' | 'error' | 'aborted';
      errorMessage?: string;
    }
  /** The agent started working (a new prompt, or a wake-up without one). */
  | { kind: 'turnStart' }
  /** The agent is blocked on the user's answer while its tools stay open
   *  (e.g. an open AskUserQuestion). Unlike turnEnd it clears nothing. */
  | { kind: 'awaitingInput' }
  /** A pending permission request was resolved (approved or rejected). */
  | { kind: 'permissionClear' }
  /** Snapshot of the agent's context occupancy after its newest turn. */
  | { kind: 'contextUsage'; tokens: number; model?: string; window?: number }
  /** A short transient note for the office (a question asked in passing, a
   *  retry, a non-fatal error). */
  | { kind: 'notice'; text: string; tone?: 'info' | 'error' }
  | {
      kind: 'subagentStart';
      parentToolId: string;
      toolId: string;
      toolName: string;
      input?: unknown;
      runInBackground?: boolean;
    }
  | { kind: 'subagentEnd'; parentToolId: string; toolId: string }
  | {
      kind: 'subagentTurnEnd';
      parentToolId: string;
      /** 'idle' = subagent is idle and ready for more work; 'completed' = subagent
       *  reported its task done. Some providers emit only one; both route to the
       *  same handler but with different downstream cleanup. */
      reason: 'idle' | 'completed';
    }
  | { kind: 'progress'; toolId: string; data: unknown }
  | { kind: 'permissionRequest' }
  | {
      kind: 'sessionStart';
      source?: string;
      /** For external-session adoption: path to the session's transcript file
       *  (if the provider uses one). Undefined for providers without transcripts. */
      transcriptPath?: string;
      /** Working directory the session was started in. Used to match pending
       *  external sessions against known Directories. */
      cwd?: string;
    }
  | { kind: 'sessionEnd'; reason?: string };

// ── Hook-based Provider (CLIs with hooks APIs) ────────────────

export interface HookProvider {
  readonly kind: 'hook';
  readonly id: string;
  readonly displayName: string;
  /** Protocol version. Server refuses to dispatch events from a provider whose
   *  version it doesn't understand. Bump on every breaking change to AgentEvent
   *  / TeamProvider / HookProvider. Start at 1. */
  readonly protocolVersion: number;

  /** Normalize a raw hook event payload into an AgentEvent.
   *  Each CLI sends different JSON (Claude: snake_case, Copilot: camelCase, etc.)
   *  The provider translates to the common AgentEvent format.
   *  Return null for events we should ignore. */
  normalizeHookEvent(raw: Record<string, unknown>): {
    sessionId: string;
    event: AgentEvent;
  } | null;

  /** Install hook scripts that POST to our server. */
  installHooks(serverUrl: string, authToken: string): Promise<void>;
  /** Remove installed hook scripts. */
  uninstallHooks(): Promise<void>;
  /** Check if hooks are currently installed. */
  areHooksInstalled(): Promise<boolean>;
  /** First-run consent copy for THIS provider's hook install: the headline titles the ask, the disclosure is its body
   *  (what is written, what data moves, how to undo; paragraphs split on blank lines). Required, not optional — a
   *  provider that installs anything must state its terms, and the gate ships these verbatim so no client copy can
   *  drift. */
  consentDisclosure(): { headline: string; disclosure: string };

  /** Format tool status for display (e.g., "Read" -> "Reading foo.ts") */
  formatToolStatus(toolName: string, input?: unknown): string;
  /** Tools that don't trigger permission timers */
  readonly permissionExemptTools: ReadonlySet<string>;
  /** Tools that spawn sub-agent characters */
  readonly subagentToolNames: ReadonlySet<string>;
  /** Tools that should show the "reading" character animation instead of "typing".
   *  The provider classifies tools as read-like or write-like; the webview renders
   *  the animation. Allows new providers to override without webview edits. */
  readonly readingTools: ReadonlySet<string>;
  /** Terminal name prefix used when launching this CLI. Used by the extension to
   *  match VS Code terminals to agents for heuristic adoption. */
  readonly terminalNamePrefix?: string;

  /** Context window, in tokens, for a model id this CLI reports in its
   *  transcripts. Transcripts state token usage but never the limit it counts
   *  against, so only the provider can say — and getting it wrong is visible:
   *  the office renders usage/window as a context gauge over every character.
   *  Return undefined for an unrecognized model; the runtime then keeps its
   *  previous estimate and widens it if a context ever exceeds it. */
  contextWindowForModel?(model: string | undefined): number | undefined;

  // ── Optional file fallback (heuristic mode) ──

  /** Session directories to scan. Undefined = no file fallback. */
  getSessionDirs?(workspacePath: string): string[];
  /** Root directories containing every session this provider may have started
   *  (across all workspaces). Used by global session discovery / "Watch All
   *  Sessions". Each returned dir contains subdirs whose entries are session
   *  transcript files. Undefined = this provider doesn't support global scan. */
  getAllSessionRoots?(): string[];
  /** Glob pattern for session files (e.g., '*.jsonl'). */
  readonly sessionFilePattern?: string;
  /** Parse one line of a transcript file into an AgentEvent. */
  parseTranscriptLine?(line: string): AgentEvent | null;
  /** Build CLI launch command for +Agent button. */
  buildLaunchCommand?(
    sessionId: string,
    cwd: string,
    opts?: { bypassPermissions?: boolean },
  ): {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };

  // ── Optional team/subagent extension (Agent Teams on Claude; empty for single-agent CLIs) ──

  /** Optional reference to a TeamProvider. When set, the hook handler registers team-aware
   *  branches (subagent routing, teammate discovery, permission forwarding, etc.). */
  readonly team?: TeamProvider;
}

// ── Stream Provider (external services polled or pushed in-process) ──

/** Display-only facts about a stream session. Forwarded as `agentDetails`. */
export interface StreamSessionDetails {
  /** Deep link that opens the session in its own app (conductor://...). */
  externalUrl?: string;
  model?: string;
  /** The model id the provider's create-session takes (Conductor's `model`
   *  alias, e.g. `opus-5-5-1m`, where `model` may be the resolved
   *  `claude-opus-5-5[1m]`): what Switch model's catalog names. */
  modelId?: string;
  /** Harness running the session: claude | codex | cursor | ... */
  harness?: string;
  /** Reasoning effort the session runs with, when the provider reports one. */
  effort?: string;
  fastMode?: boolean;
  workspaceId?: string;
  workspaceName?: string;
  workspaceNumber?: number;
  /** Repository slug (owner/name). */
  repo?: string;
  creatorName?: string;
  /** Messages in the session so far (newest sessionIndex). Drives the level. */
  messageCount?: number;
  /** Epoch ms of the newest observed activity. */
  lastActivityAt?: number;
}

/** What a stream provider knows about one session. Optional fields may change
 *  over time; `upsertSession` diffs them. */
export interface StreamSessionInfo {
  /** Provider-unique id, without any namespace prefix (Conductor session UUID). */
  sessionId: string;
  /** Session name, shown as the character's nickname. */
  label?: string;
  /** Area-mapping key (repo short name). */
  directoryName?: string;
  /** The session that spawned this one, when known and in the office. */
  leadSessionId?: string;
  details?: StreamSessionDetails;
  /** Seed state for a newly adopted session (no history is replayed). */
  initialStatus?: 'active' | 'waiting' | 'error';
  errorMessage?: string;
}

/** One message or check between two sessions. */
export interface AgentLinkEvent {
  fromSessionId: string;
  toSessionId: string;
  kind: 'spawned' | 'messaged' | 'watched';
  /** Epoch ms. */
  at: number;
  /** First characters of the message, whitespace collapsed. */
  preview?: string;
  /** False while backfilling history: update the link, but play no animation. */
  live: boolean;
  /** A `spawned` link the user made by continuing `fromSessionId` in a new
   *  session (Switch model): the new session is linked to it and thrown out of
   *  it like any spawned session, but the continuation does not make the
   *  original a delegating Lead, so its Pokémon stays. */
  handoff?: boolean;
}

export type StreamProviderStatus = Omit<ConductorStatus, 'type'>;

/** What a stream provider pushes into the runtime. Implemented by the
 *  server's StreamAgentDriver; providers never touch the store directly. */
export interface AgentEventSink {
  /** Adopt (create) or update the agent for a session. Idempotent. */
  upsertSession(info: StreamSessionInfo): void;
  /** Canonical events for an adopted session, in order. Unknown sessions are ignored. */
  emit(sessionId: string, event: AgentEvent): void;
  /** Record a link between two sessions. Links whose ends are not both in the
   *  office are kept and resolve once both ends are adopted. */
  link(event: AgentLinkEvent): void;
  /** Despawn the session's agent (hidden, archived, out of scope). */
  removeSession(sessionId: string, reason?: string): void;
  /** Connection state and scope, broadcast as `conductorStatus`. */
  setStatus(status: StreamProviderStatus): void;
  /** The session list changed (for the Sessions modal), broadcast as `conductorSessions`. */
  sessionsChanged(sessions: ConductorSessionSummary[]): void;
}

/** The agents and models a session can continue with (Switch model), and
 *  the user's favorites among them. Sent to clients as `modelCatalog`. */
export interface StreamModelCatalog {
  agents: ModelCatalogAgent[];
  favorites: FavoriteModel[];
  defaultAgent?: string;
}

/** A validated continueWithModel request (see server/src/providers/stream/modelCatalog.ts). */
export interface ModelChoice {
  agent: string;
  model: string;
  effort?: string;
  fastMode?: boolean;
  /** The new session's first message. */
  message: string;
}

/** Recent conversation context for one session (the Pokédex panel). */
export interface StreamSessionDetail {
  prompt?: string;
  question?: SessionQuestion;
  /** Entries reference peers by session id; the server maps them to agent ids. */
  entries: Array<Omit<SessionDetailEntry, 'peerId'> & { peerSessionId?: string }>;
  truncated?: boolean;
}

export interface StreamProvider {
  readonly kind: 'stream';
  readonly id: string;
  readonly displayName: string;
  /** Same contract as HookProvider.protocolVersion. Start at 1. */
  readonly protocolVersion: number;

  formatToolStatus(toolName: string, input?: unknown): string;
  readonly permissionExemptTools: ReadonlySet<string>;
  readonly subagentToolNames: ReadonlySet<string>;
  readonly readingTools: ReadonlySet<string>;
  contextWindowForModel?(model: string | undefined): number | undefined;

  /** Begin polling. Resolves after the first full sync (or a definitive
   *  auth/network failure reported through `sink.setStatus`). Never rejects. */
  start(sink: AgentEventSink): Promise<void>;
  stop(): Promise<void>;

  // ── User controls (all optional; the UI hides what a provider lacks) ──

  /** The user dismissed the session's character: hide it until unhidden. */
  onDismiss?(sessionId: string): void;
  setSessionHidden?(sessionId: string, hidden: boolean): void;
  setSessionPinned?(sessionId: string, pinned: boolean): void;
  getScope?(): ConductorScope;
  setScope?(scope: ConductorScope): void;
  /** Every session in scope, hidden ones included. */
  listSessions?(): ConductorSessionSummary[];
  getSessionDetail?(sessionId: string): Promise<StreamSessionDetail | null>;
  /** One page of older conversation for the chat view. `before` is the cursor
   *  from a previous page; absent means the newest page. */
  getSessionHistory?(
    sessionId: string,
    before?: string,
  ): Promise<{
    entries: StreamSessionDetail['entries'];
    before?: string;
    hasMore: boolean;
  }>;
  /** Send a user message to the session. Rejects with a user-facing message. */
  sendMessage?(sessionId: string, text: string): Promise<void>;
  /** Cancel the session's running turn. Rejects with a user-facing message. */
  stopSession?(sessionId: string): Promise<void>;
  /** Archive (deposit) or unarchive (withdraw) the session. Rejects with a user-facing message. */
  archiveSession?(sessionId: string): Promise<void>;
  restoreSession?(sessionId: string): Promise<void>;
  /** Mark the session as focused (selected in the office) so it polls faster. */
  setFocus?(sessionIds: string[]): void;
  /** The agents and models `continueWithModel` accepts, with the user's
   *  favorites. Never rejects: favorites that can't be read are left out. */
  getModelCatalog?(): Promise<StreamModelCatalog>;
  /** Start a new session in the same workspace as `sessionId` with another
   *  agent or model (the provider's API can't change a running session's
   *  model), and link it to `sessionId`. Resolves with the new session's id;
   *  rejects with a user-facing message. */
  continueWithModel?(sessionId: string, choice: ModelChoice): Promise<{ sessionId: string }>;
}
