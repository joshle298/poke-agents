/**
 * Shapes returned by the Conductor public API (only the fields the provider
 * reads). Everything is optional beyond ids because the API omits fields
 * freely (never-started sessions have no name or model, workspaces still
 * initializing have no lastActivityAt).
 */

export interface ConductorMe {
  userId: string;
  name?: string;
  email?: string;
  organizationId?: string;
  organizationName?: string;
  /** Present when the token belongs to a cloud workspace (running inside Conductor). */
  workspaceId?: string | null;
}

export interface ConductorWorkspace {
  id: string;
  projectId?: string;
  name?: string;
  number?: number;
  state?: string;
  lifecycleStep?: string;
  repoUrl?: string;
  createdAt?: string;
  deepLink?: string;
  creatorId?: string;
  creatorName?: string;
  lastActivityAt?: string;
}

export interface ConductorSession {
  id: string;
  deepLink?: string;
  name?: string | null;
  model?: string | null;
  resolvedModel?: string | null;
  effort?: string | null;
  fastMode?: boolean | null;
  archivedAt?: string | null;
}

/** POST /v0/sessions body (only the fields the office sends). */
export interface ConductorCreateSessionBody {
  workspaceId: string;
  /** Chosen by the caller, so a retry after a lost response names the same
   *  session (Conductor deduplicates the message within it). */
  sessionId: string;
  agent: string;
  model: string;
  effort?: string;
  fastMode?: boolean;
  name: string;
  message: string;
  messageId: string;
}

/** POST /v0/sessions 201. */
export interface ConductorCreatedSession extends ConductorSession {
  initialMessage?: { messageId?: string; state?: string; deepLink?: string };
}

export type ConductorRunStatus = 'idle' | 'working' | 'error';

export interface ConductorSessionStatus {
  workspaceId?: string;
  sessionId?: string;
  status: ConductorRunStatus;
  updatedAt?: string;
  errorMessage?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
}

export interface ConductorPage<T> {
  data: T[];
  offset?: number;
  hasMore?: boolean;
}

/** One feed item from GET /v0/sessions/:id/messages. */
export interface ConductorItem {
  /** The `after=` cursor (= content.eventId). */
  id: string;
  sessionId: string;
  /** Ascending, with permanent gaps; never use it for counting. */
  sessionIndex: number;
  type: string;
  content: Record<string, unknown>;
  receivedAt: string;
}
