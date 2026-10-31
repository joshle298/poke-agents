/**
 * HTTP client for the Conductor public API with a client-side request budget.
 *
 * - A token bucket meters every request (default 120/min). Waiters are served
 *   by priority, so user actions and focused sessions go first.
 * - A general 429 halves the effective budget, pauses the whole client for
 *   `retry-after` plus 0-1 s of jitter, and the budget then recovers by 10 % of
 *   the configured value per minute.
 * - A per-session `/status` 429 pauses only that session's status checks.
 * - 5xx responses back off per endpoint class, network failures globally:
 *   1, 2, 4, 8 s ... capped at 30 s.
 *
 * Polling uses GETs. The write methods exist only for explicit user actions.
 */

import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  BUCKET_BURST_FRACTION,
  BUDGET_RECOVERY_FRACTION_PER_MINUTE,
  DEFAULT_BUDGET_PER_MINUTE,
  DEFAULT_RETRY_AFTER_MS,
  MIN_BUDGET_PER_MINUTE,
  PRIORITY_BACKGROUND,
  PRIORITY_USER,
  REQUEST_TIMEOUT_MS,
  RETRY_AFTER_JITTER_MS,
  USER_ACTION_DETAIL_MAX,
} from './constants.js';
import type {
  ConductorItem,
  ConductorMe,
  ConductorPage,
  ConductorSession,
  ConductorSessionStatus,
  ConductorWorkspace,
} from './types.js';

export type ConductorErrorKind =
  'unauthorized' | 'notFound' | 'rateLimited' | 'badRequest' | 'server' | 'network' | 'closed';

export class ConductorApiError extends Error {
  readonly kind: ConductorErrorKind;
  readonly status?: number;
  readonly code?: string;
  /** The API's own short explanation (never contains the token). */
  readonly apiMessage?: string;
  readonly retryAfterMs?: number;
  /** For 429s: the whole client or only one session's status checks. */
  readonly scope?: 'global' | 'status';

  constructor(
    kind: ConductorErrorKind,
    message: string,
    extra: {
      status?: number;
      code?: string;
      apiMessage?: string;
      retryAfterMs?: number;
      scope?: 'global' | 'status';
    } = {},
  ) {
    super(message);
    this.name = 'ConductorApiError';
    this.kind = kind;
    this.status = extra.status;
    this.code = extra.code;
    this.apiMessage = extra.apiMessage;
    this.retryAfterMs = extra.retryAfterMs;
    this.scope = extra.scope;
  }
}

/** Short message for the office when a user action fails. */
export function userFacingMessage(err: unknown): string {
  if (!(err instanceof ConductorApiError)) return 'Conductor request failed';
  switch (err.kind) {
    case 'unauthorized':
      return 'Conductor refused: no permission';
    case 'notFound':
      return 'Session not found';
    case 'rateLimited':
      return 'Conductor is rate limiting requests. Try again shortly.';
    case 'network':
      return "Couldn't reach Conductor";
    case 'server':
      return 'Conductor had a server error. Try again.';
    case 'closed':
      return 'Conductor is not connected';
    case 'badRequest': {
      const detail = err.apiMessage?.replace(/\s+/g, ' ').trim();
      return detail
        ? `Conductor refused the request: ${detail.slice(0, USER_ACTION_DETAIL_MAX)}`
        : 'Conductor refused the request';
    }
  }
}

export interface ClientClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}

export const systemClock: ClientClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  random: () => Math.random(),
};

interface Waiter {
  priority: number;
  seq: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  priority: number;
  /** 5xx backoff bucket; network failures always back off globally. */
  backoffKey: string;
  /** Set for /v0/sessions/:id/status so its 429 pauses only that session. */
  statusSessionId?: string;
}

function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export class ConductorClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: ClientClock;
  private readonly configuredBudget: number;
  private budget: number;
  private budgetAtLimit = 0;
  private lastLimitAt = 0;
  private tokens: number;
  private lastRefill: number;
  private readonly waiters: Waiter[] = [];
  private seq = 0;
  private pumping = false;
  private closed = false;
  /** Whole-client pause (general 429 or network backoff). */
  private pausedUntilMs = 0;
  private rateLimitedUntilMs = 0;
  private networkFailures = 0;
  private readonly serverFailures = new Map<string, { count: number; until: number }>();
  private readonly statusPausedUntil = new Map<string, number>();

  constructor(opts: {
    baseUrl: string;
    token: string;
    fetchImpl: typeof fetch;
    budgetPerMinute?: number;
    clock?: ClientClock;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl;
    this.clock = opts.clock ?? systemClock;
    const budget = opts.budgetPerMinute ?? DEFAULT_BUDGET_PER_MINUTE;
    this.configuredBudget = Math.max(MIN_BUDGET_PER_MINUTE, Math.floor(budget));
    this.budget = this.configuredBudget;
    this.tokens = this.capacity();
    this.lastRefill = this.clock.now();
  }

  // ── Budget state ──

  /** Requests per minute currently allowed (halved by 429s, recovering). */
  get effectiveBudget(): number {
    this.recover(this.clock.now());
    return this.budget;
  }

  get configuredBudgetPerMinute(): number {
    return this.configuredBudget;
  }

  /** True while a general 429 pause is in effect. */
  isRateLimited(): boolean {
    return this.clock.now() < this.rateLimitedUntilMs;
  }

  /** Epoch ms until which the whole client is paused (0 when not paused). */
  get pausedUntil(): number {
    return this.pausedUntilMs;
  }

  /** Requests queued behind the bucket. */
  get queuedRequests(): number {
    return this.waiters.length;
  }

  close(): void {
    this.closed = true;
    const pending = this.waiters.splice(0);
    for (const w of pending) w.reject(new ConductorApiError('closed', 'Client closed'));
  }

  // ── Endpoints (GET) ──

  me(): Promise<ConductorMe> {
    return this.request({ method: 'GET', path: '/me', priority: PRIORITY_USER, backoffKey: 'me' });
  }

  listWorkspaces(
    query: { since?: string; creator?: string; limit: number; offset: number },
    priority: number,
  ): Promise<ConductorPage<ConductorWorkspace>> {
    return this.request({
      method: 'GET',
      path: '/v0/workspaces',
      query,
      priority,
      backoffKey: 'discovery',
    });
  }

  getWorkspace(workspaceId: string, priority = PRIORITY_BACKGROUND): Promise<ConductorWorkspace> {
    return this.request({
      method: 'GET',
      path: `/v0/workspaces/${encodeURIComponent(workspaceId)}`,
      priority,
      backoffKey: 'discovery',
    });
  }

  listWorkspaceSessions(
    workspaceId: string,
    page: { includeArchived?: boolean; limit: number; offset: number },
    priority: number,
  ): Promise<ConductorPage<ConductorSession>> {
    return this.request({
      method: 'GET',
      path: `/v0/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
      query: {
        limit: page.limit,
        offset: page.offset,
        includeArchived: page.includeArchived ? true : undefined,
      },
      priority,
      backoffKey: 'discovery',
    });
  }

  getSession(sessionId: string, priority = PRIORITY_BACKGROUND): Promise<ConductorSession> {
    return this.request({
      method: 'GET',
      path: `/v0/sessions/${encodeURIComponent(sessionId)}`,
      priority,
      backoffKey: `session:${sessionId}`,
    });
  }

  getSessionStatus(sessionId: string, priority: number): Promise<ConductorSessionStatus> {
    return this.request({
      method: 'GET',
      path: `/v0/sessions/${encodeURIComponent(sessionId)}/status`,
      priority,
      backoffKey: `session:${sessionId}`,
      statusSessionId: sessionId,
    });
  }

  /** `after` and `offset` are mutually exclusive (the API answers 400). */
  listMessages(
    sessionId: string,
    page: { after: string; limit: number } | { offset: number; limit: number },
    priority: number,
  ): Promise<ConductorPage<ConductorItem>> {
    return this.request({
      method: 'GET',
      path: `/v0/sessions/${encodeURIComponent(sessionId)}/messages`,
      query: page,
      priority,
      backoffKey: `session:${sessionId}`,
    });
  }

  // ── Endpoints (POST, explicit user actions only) ──

  sendMessage(
    sessionId: string,
    message: string,
    messageId: string,
  ): Promise<{ messageId?: string; state?: string }> {
    return this.request({
      method: 'POST',
      path: `/v0/sessions/${encodeURIComponent(sessionId)}/messages`,
      body: { message, messageId },
      priority: PRIORITY_USER,
      backoffKey: 'actions',
    });
  }

  cancelSession(sessionId: string): Promise<unknown> {
    return this.postAction(sessionId, 'cancel');
  }

  archiveSession(sessionId: string): Promise<unknown> {
    return this.postAction(sessionId, 'archive');
  }

  unarchiveSession(sessionId: string): Promise<unknown> {
    return this.postAction(sessionId, 'unarchive');
  }

  private postAction(sessionId: string, action: string): Promise<unknown> {
    return this.request({
      method: 'POST',
      path: `/v0/sessions/${encodeURIComponent(sessionId)}/${action}`,
      priority: PRIORITY_USER,
      backoffKey: 'actions',
    });
  }

  // ── Core ──

  private async request<T>(spec: RequestSpec): Promise<T> {
    if (this.closed) throw new ConductorApiError('closed', 'Client closed');
    this.checkLocalPauses(spec);
    await this.acquire(spec.priority);
    if (this.closed) throw new ConductorApiError('closed', 'Client closed');

    const url = this.buildUrl(spec);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
    };
    let body: string | undefined;
    if (spec.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(spec.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      this.noteNetworkFailure();
      throw new ConductorApiError('network', `Network error on ${spec.method} ${spec.path}`);
    }

    let payload: unknown;
    try {
      const text = await res.text();
      payload = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      payload = undefined;
    } finally {
      clearTimeout(timer);
    }
    this.networkFailures = 0;

    if (res.ok) {
      this.serverFailures.delete(spec.backoffKey);
      return payload as T;
    }
    throw this.handleFailure(spec, res, payload);
  }

  private buildUrl(spec: RequestSpec): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) params.set(key, String(value));
    }
    const qs = params.toString();
    return `${this.baseUrl}${spec.path}${qs ? `?${qs}` : ''}`;
  }

  private checkLocalPauses(spec: RequestSpec): void {
    const now = this.clock.now();
    if (spec.statusSessionId) {
      const until = this.statusPausedUntil.get(spec.statusSessionId) ?? 0;
      if (now < until) {
        throw new ConductorApiError('rateLimited', 'Status polling paused for this session', {
          status: 429,
          retryAfterMs: until - now,
          scope: 'status',
        });
      }
    }
    const backoff = this.serverFailures.get(spec.backoffKey);
    if (backoff && now < backoff.until && spec.priority !== PRIORITY_USER) {
      throw new ConductorApiError('server', 'Backing off after a server error', {
        retryAfterMs: backoff.until - now,
      });
    }
  }

  private handleFailure(spec: RequestSpec, res: Response, payload: unknown): ConductorApiError {
    const now = this.clock.now();
    const body = (payload && typeof payload === 'object' ? payload : {}) as {
      userMessage?: unknown;
      code?: unknown;
    };
    const apiMessage = typeof body.userMessage === 'string' ? body.userMessage : undefined;
    const code = typeof body.code === 'string' ? body.code : undefined;
    const status = res.status;
    const where = `${spec.method} ${spec.path}`;

    if (status === 429) {
      const retryAfter =
        parseRetryAfter(res.headers.get('retry-after'), now) ?? DEFAULT_RETRY_AFTER_MS;
      const pauseMs = retryAfter + Math.floor(this.clock.random() * RETRY_AFTER_JITTER_MS);
      const statusScoped = !!spec.statusSessionId && /status polling/i.test(apiMessage ?? '');
      if (statusScoped && spec.statusSessionId) {
        this.statusPausedUntil.set(spec.statusSessionId, now + pauseMs);
        return new ConductorApiError('rateLimited', `Rate limited: ${where}`, {
          status,
          code,
          apiMessage,
          retryAfterMs: pauseMs,
          scope: 'status',
        });
      }
      this.noteGeneralRateLimit(now, pauseMs);
      return new ConductorApiError('rateLimited', `Rate limited: ${where}`, {
        status,
        code,
        apiMessage,
        retryAfterMs: pauseMs,
        scope: 'global',
      });
    }
    if (status === 401 || status === 403) {
      return new ConductorApiError('unauthorized', `HTTP ${status} on ${where}`, {
        status,
        code,
        apiMessage,
      });
    }
    if (status === 404) {
      return new ConductorApiError('notFound', `HTTP 404 on ${where}`, {
        status,
        code,
        apiMessage,
      });
    }
    if (status >= 500) {
      const prev = this.serverFailures.get(spec.backoffKey);
      const count = (prev?.count ?? 0) + 1;
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (count - 1));
      this.serverFailures.set(spec.backoffKey, { count, until: now + delay });
      return new ConductorApiError('server', `HTTP ${status} on ${where}`, {
        status,
        code,
        apiMessage,
        retryAfterMs: delay,
      });
    }
    return new ConductorApiError('badRequest', `HTTP ${status} on ${where}`, {
      status,
      code,
      apiMessage,
    });
  }

  private noteGeneralRateLimit(now: number, pauseMs: number): void {
    this.recover(now);
    this.budget = Math.max(MIN_BUDGET_PER_MINUTE, Math.floor(this.budget / 2));
    this.budgetAtLimit = this.budget;
    this.lastLimitAt = now;
    this.tokens = Math.min(this.tokens, this.capacity());
    this.pausedUntilMs = Math.max(this.pausedUntilMs, now + pauseMs);
    this.rateLimitedUntilMs = Math.max(this.rateLimitedUntilMs, now + pauseMs);
  }

  private noteNetworkFailure(): void {
    this.networkFailures += 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.networkFailures - 1));
    this.pausedUntilMs = Math.max(this.pausedUntilMs, this.clock.now() + delay);
  }

  /** Linear recovery: +10 % of the configured budget per minute since the last 429. */
  private recover(now: number): void {
    if (this.budget >= this.configuredBudget || this.lastLimitAt === 0) return;
    const minutes = (now - this.lastLimitAt) / 60_000;
    const recovered =
      this.budgetAtLimit + this.configuredBudget * BUDGET_RECOVERY_FRACTION_PER_MINUTE * minutes;
    this.budget = Math.min(this.configuredBudget, Math.floor(recovered));
  }

  private capacity(): number {
    return Math.max(1, Math.round(this.budget * BUCKET_BURST_FRACTION));
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.lastRefill);
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity(), this.tokens + (elapsed * this.budget) / 60_000);
  }

  private acquire(priority: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { priority, seq: this.seq++, resolve, reject };
      let i = this.waiters.length;
      while (
        i > 0 &&
        (this.waiters[i - 1].priority > priority ||
          (this.waiters[i - 1].priority === priority && this.waiters[i - 1].seq > waiter.seq))
      ) {
        i--;
      }
      this.waiters.splice(i, 0, waiter);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.waiters.length > 0 && !this.closed) {
        const now = this.clock.now();
        this.recover(now);
        if (now < this.pausedUntilMs) {
          await this.clock.sleep(this.pausedUntilMs - now);
          continue;
        }
        this.refill(now);
        if (this.tokens >= 1) {
          this.tokens -= 1;
          this.waiters.shift()?.resolve();
          continue;
        }
        const waitMs = Math.ceil(((1 - this.tokens) * 60_000) / this.budget);
        await this.clock.sleep(Math.max(1, waitMs));
      }
    } finally {
      this.pumping = false;
    }
  }
}
