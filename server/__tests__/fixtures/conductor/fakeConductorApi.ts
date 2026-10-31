/**
 * In-memory stand-in for the Conductor public API (the GET endpoints the
 * provider polls, plus the write endpoints behind user actions). Tests inject
 * `api.fetch`; nothing reaches the network.
 */

import type {
  ConductorItem,
  ConductorMe,
  ConductorSessionStatus,
  ConductorWorkspace,
} from '../../../src/providers/stream/conductor/types.js';

export interface FakeSession {
  id: string;
  workspaceId: string;
  name?: string | null;
  model?: string | null;
  resolvedModel?: string | null;
  effort?: string | null;
  fastMode?: boolean | null;
  archivedAt?: string | null;
  items: ConductorItem[];
  status: ConductorSessionStatus;
}

export interface FakeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
  at: number;
}

type Override = (call: FakeCall) => Response | Promise<Response> | undefined;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const ME: ConductorMe = {
  userId: '0000feed-0000-4000-8000-000000000001',
  name: 'Example User',
  email: 'user@example.com',
};

export class FakeConductorApi {
  me: ConductorMe = ME;
  workspaces: ConductorWorkspace[] = [];
  readonly sessions = new Map<string, FakeSession>();
  readonly calls: FakeCall[] = [];
  /** Server-side cap on session list pages (tests lower it to force paging). */
  sessionsPageLimit = 100;
  /** GET /v0/favorite-models entries (synthetic). */
  favoriteModels: unknown[] = [];
  private readonly overrides: Override[] = [];

  constructor(private readonly now: () => number) {}

  addWorkspace(ws: Partial<ConductorWorkspace> & { id: string }): ConductorWorkspace {
    const full: ConductorWorkspace = {
      name: `Workspace ${this.workspaces.length + 1}`,
      number: 100 + this.workspaces.length + 1,
      state: 'ready',
      repoUrl: 'https://github.com/example-org/example-repo',
      deepLink: `conductor://workspace?id=${ws.id}`,
      creatorId: ME.userId,
      creatorName: 'Example User',
      lastActivityAt: new Date(this.now()).toISOString(),
      ...ws,
    };
    this.workspaces.push(full);
    return full;
  }

  addSession(session: Partial<FakeSession> & { id: string; workspaceId: string }): FakeSession {
    // Like the real API: an idle session's status last changed when its feed
    // went quiet (its newest item), not now.
    const lastItemAt = session.items?.at(-1)?.receivedAt;
    const full: FakeSession = {
      name: 'Session',
      model: 'opus-5-5-1m',
      resolvedModel: 'claude-opus-5-5[1m]',
      items: [],
      status: { status: 'idle', updatedAt: lastItemAt ?? new Date(this.now()).toISOString() },
      ...session,
    };
    this.sessions.set(full.id, full);
    return full;
  }

  /** Answer the next matching request with `response` (once unless `times`). */
  override(
    match: (call: FakeCall) => boolean,
    response: () => Response | Promise<Response>,
    times = 1,
  ): void {
    let left = times;
    this.overrides.push((call) => {
      if (left <= 0 || !match(call)) return undefined;
      left--;
      return response();
    });
  }

  callsTo(pathPart: string): FakeCall[] {
    return this.calls.filter((c) => c.path.includes(pathPart));
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: FakeCall = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      at: this.now(),
    };
    this.calls.push(call);
    for (const override of this.overrides) {
      const res = override(call);
      if (res) return res;
    }
    return this.route(call);
  }) as typeof fetch;

  private route(call: FakeCall): Response {
    const parts = call.path.split('/').filter(Boolean);
    if (call.method === 'GET' && call.path === '/me') return json(200, this.me);
    if (parts[0] !== 'v0') return json(404, { userMessage: 'Not found', code: 'NOT_FOUND' });
    if (call.method === 'GET' && call.path === '/v0/favorite-models') {
      return json(200, { favoriteModels: this.favoriteModels });
    }
    if (call.method === 'POST' && call.path === '/v0/sessions') return this.createSession(call);

    if (parts[1] === 'workspaces' && parts.length === 2) {
      const since = call.query.since ? Date.parse(call.query.since) : 0;
      const matching = this.workspaces.filter(
        (ws) =>
          (!call.query.creator || ws.creatorId === call.query.creator) &&
          Date.parse(ws.lastActivityAt ?? '1970-01-01T00:00:00Z') >= since,
      );
      const offset = Number(call.query.offset ?? 0);
      const limit = Math.min(100, Number(call.query.limit ?? 100));
      const data = matching.slice(offset, offset + limit);
      return json(200, { data, offset, hasMore: offset + limit < matching.length });
    }
    if (parts[1] === 'workspaces' && parts.length === 3) {
      const ws = this.workspaces.find((w) => w.id === parts[2]);
      return ws ? json(200, ws) : json(404, { userMessage: 'Workspace not found' });
    }
    if (parts[1] === 'workspaces' && parts[3] === 'sessions') {
      const includeArchived = call.query.includeArchived === 'true';
      const all = [...this.sessions.values()]
        .filter((s) => s.workspaceId === parts[2] && (includeArchived || !s.archivedAt))
        .map((s) => this.sessionJson(s));
      // Like the real API: a small default page, honoring limit/offset.
      const offset = Number(call.query.offset ?? 0);
      const limit = Math.min(this.sessionsPageLimit, Number(call.query.limit ?? 20));
      const data = all.slice(offset, offset + limit);
      return json(200, { data, offset, hasMore: offset + limit < all.length });
    }
    if (parts[1] === 'sessions' && parts[2]) {
      const session = this.sessions.get(parts[2]);
      if (!session) return json(404, { userMessage: 'Session not found', code: 'NOT_FOUND' });
      if (call.method === 'POST') return this.write(session, parts[3], call);
      if (parts.length === 3) return json(200, this.sessionJson(session));
      if (parts[3] === 'status') {
        return json(200, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          ...session.status,
        });
      }
      if (parts[3] === 'messages') return this.messages(session, call);
    }
    return json(404, { userMessage: 'Not found', code: 'NOT_FOUND' });
  }

  private sessionJson(s: FakeSession) {
    return {
      id: s.id,
      deepLink: `conductor://workspace?id=${s.workspaceId}&session=${s.id}`,
      name: s.name,
      model: s.model,
      resolvedModel: s.resolvedModel,
      effort: s.effort ?? undefined,
      fastMode: s.fastMode ?? undefined,
      archivedAt: s.archivedAt ?? undefined,
    };
  }

  /** POST /v0/sessions: a session in an existing workspace with its first
   *  message. A repeat with the same sessionId returns the same session
   *  (Conductor deduplicates a retried create). */
  private createSession(call: FakeCall): Response {
    const body = (call.body ?? {}) as Record<string, unknown>;
    const ws = this.workspaces.find((w) => w.id === body.workspaceId);
    if (!ws) return json(404, { userMessage: 'Workspace not found', code: 'NOT_FOUND' });
    const id =
      typeof body.sessionId === 'string'
        ? body.sessionId
        : `5e55c0de-0000-4000-8000-${String(this.sessions.size).padStart(12, '0')}`;
    let session = this.sessions.get(id);
    if (!session) {
      const at = new Date(this.now()).toISOString();
      session = this.addSession({
        id,
        workspaceId: ws.id,
        name: typeof body.name === 'string' ? body.name : null,
        model: typeof body.model === 'string' ? body.model : null,
        resolvedModel: typeof body.model === 'string' ? body.model : null,
        effort: typeof body.effort === 'string' ? body.effort : null,
        fastMode: typeof body.fastMode === 'boolean' ? body.fastMode : null,
        items: [
          {
            id: `${id.slice(0, 8)}-item-1`,
            sessionId: id,
            sessionIndex: 1,
            type: 'userMessage',
            content: {
              type: 'userMessage',
              id: body.messageId,
              message: body.message,
              state: 'sent',
              config: { harness: body.agent },
            },
            receivedAt: at,
          },
        ],
        status: { status: 'working', updatedAt: at },
      });
      ws.lastActivityAt = at;
    }
    return json(201, {
      ...this.sessionJson(session),
      initialMessage: {
        messageId: body.messageId,
        state: 'sent',
        deepLink: `conductor://workspace?id=${ws.id}&session=${id}`,
      },
    });
  }

  private messages(session: FakeSession, call: FakeCall): Response {
    const limit = Math.min(100, Number(call.query.limit ?? 100));
    if (call.query.after !== undefined && call.query.offset !== undefined) {
      return json(400, { userMessage: 'after and offset are exclusive', code: 'INVALID_REQUEST' });
    }
    let start = Number(call.query.offset ?? 0);
    if (call.query.after !== undefined) {
      const index = session.items.findIndex((i) => i.id === call.query.after);
      if (index < 0) {
        return json(404, {
          userMessage: 'Cursor message not found in this session',
          code: 'NOT_FOUND',
        });
      }
      start = index + 1;
    }
    const data = session.items.slice(start, start + limit);
    return json(200, { data, offset: start, hasMore: start + limit < session.items.length });
  }

  private write(session: FakeSession, action: string | undefined, call: FakeCall): Response {
    switch (action) {
      case 'messages':
        return json(201, {
          messageId: (call.body as { messageId?: string })?.messageId,
          state: 'queued',
        });
      case 'cancel':
        return json(200, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          status: 'idle',
          canceledQueuedMessages: 0,
        });
      case 'archive':
        session.archivedAt = new Date(this.now()).toISOString();
        return json(200, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          status: 'archived',
          canceledQueuedMessages: 0,
        });
      case 'unarchive':
        session.archivedAt = null;
        return json(200, {
          workspaceId: session.workspaceId,
          sessionId: session.id,
          status: 'idle',
        });
      default:
        return json(404, { userMessage: 'Not found' });
    }
  }
}
