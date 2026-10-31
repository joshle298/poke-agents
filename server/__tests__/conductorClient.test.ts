import { describe, expect, it } from 'vitest';

import {
  type ClientClock,
  ConductorApiError,
  ConductorClient,
  userFacingMessage,
} from '../src/providers/stream/conductor/client.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  at: number;
}

function manualClock(start = 1_000_000): ClientClock & { t: number; sleeps: number[] } {
  const clock = {
    t: start,
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
    random: () => 0.5,
  };
  return clock;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeFetch(
  clock: { now(): number },
  respond: (call: Call) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
      at: clock.now(),
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const BASE = 'https://api.example.test';

describe('ConductorClient', () => {
  it('sends the bearer token in a header, never in the URL', async () => {
    const clock = manualClock();
    const api = fakeFetch(clock, () => json(200, { data: [], hasMore: false }));
    const client = new ConductorClient({
      baseUrl: `${BASE}/`,
      token: 'secret-token',
      fetchImpl: api.fetch,
      clock,
    });
    await client.listWorkspaces(
      { since: '2026-01-01T00:00:00.000Z', creator: 'u1', limit: 100, offset: 0 },
      3,
    );
    expect(api.calls[0].url).toBe(
      `${BASE}/v0/workspaces?since=2026-01-01T00%3A00%3A00.000Z&creator=u1&limit=100&offset=0`,
    );
    expect(api.calls[0].headers.authorization).toBe('Bearer secret-token');
    expect(api.calls[0].url).not.toContain('secret-token');
  });

  it('meters requests with a token bucket at the configured budget', async () => {
    const clock = manualClock();
    const api = fakeFetch(clock, () => json(200, {}));
    // 12/min: a burst of 3, then one request every 5 s.
    const client = new ConductorClient({
      baseUrl: BASE,
      token: 't',
      fetchImpl: api.fetch,
      budgetPerMinute: 12,
      clock,
    });
    for (let i = 0; i < 5; i++) await client.getSession(`s${i}`);
    const times = api.calls.map((c) => c.at - 1_000_000);
    expect(times).toEqual([0, 0, 0, 5_000, 10_000]);
  });

  it('serves waiting requests by priority', async () => {
    const clock = manualClock();
    const api = fakeFetch(clock, () => json(200, {}));
    const client = new ConductorClient({
      baseUrl: BASE,
      token: 't',
      fetchImpl: api.fetch,
      budgetPerMinute: 12,
      clock,
    });
    await Promise.all([client.getSession('a'), client.getSession('b'), client.getSession('c')]);
    const done = Promise.all([
      client.getSessionStatus('low', 5),
      client.getSessionStatus('high', 0),
      client.getSessionStatus('mid', 2),
    ]);
    await done;
    expect(api.calls.slice(3).map((c) => c.url.split('/')[5])).toEqual(['high', 'mid', 'low']);
  });

  it('on a general 429: honours retry-after plus jitter, halves the budget, recovers 10 %/min', async () => {
    const clock = manualClock();
    let limited = true;
    const api = fakeFetch(clock, () =>
      limited
        ? json(
            429,
            {
              userMessage: 'Rate limit exceeded for API requests. Retry after 9 seconds.',
              code: 'RATE_LIMITED',
            },
            { 'retry-after': '9' },
          )
        : json(200, { data: [] }),
    );
    const client = new ConductorClient({
      baseUrl: BASE,
      token: 't',
      fetchImpl: api.fetch,
      budgetPerMinute: 120,
      clock,
    });
    const err = await client.listWorkspaces({ limit: 100, offset: 0 }, 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConductorApiError);
    expect(err).toMatchObject({ kind: 'rateLimited', scope: 'global', retryAfterMs: 9_500 });
    expect(client.effectiveBudget).toBe(60);
    expect(client.isRateLimited()).toBe(true);
    expect(client.pausedUntil).toBe(1_000_000 + 9_500);

    limited = false;
    await client.listWorkspaces({ limit: 100, offset: 0 }, 3);
    expect(api.calls[1].at).toBeGreaterThanOrEqual(1_000_000 + 9_500);
    expect(client.isRateLimited()).toBe(false);

    clock.t = 1_000_000 + 60_000;
    expect(client.effectiveBudget).toBe(72);
    clock.t = 1_000_000 + 10 * 60_000;
    expect(client.effectiveBudget).toBe(120);
  });

  it('halves once when the requests in flight all come back 429 together', async () => {
    const clock = manualClock();
    let limited = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = fakeFetch(clock, async () => {
      await gate;
      return limited
        ? json(
            429,
            { userMessage: 'Rate limit exceeded for API requests.' },
            { 'retry-after': '9' },
          )
        : json(200, {});
    });
    const client = new ConductorClient({
      baseUrl: BASE,
      token: 't',
      fetchImpl: api.fetch,
      budgetPerMinute: 120,
      clock,
    });
    // Eight units have their requests out when the shared limit trips.
    const inFlight = Array.from({ length: 8 }, (_, i) =>
      client.getSession(`s${i}`).catch((e: unknown) => e),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.calls).toHaveLength(8);
    release();
    const errors = await Promise.all(inFlight);
    expect(errors.every((e) => e instanceof ConductorApiError && e.kind === 'rateLimited')).toBe(
      true,
    );
    expect(client.effectiveBudget).toBe(60);

    // A 429 after the pause is a new episode and halves again (from 62: ten
    // seconds of recovery at 12/min).
    limited = true;
    clock.t += 10_000;
    await client.getSession('again').catch(() => undefined);
    expect(client.effectiveBudget).toBe(31);
    limited = false;
  });

  it('pauses only that session on a per-session status 429', async () => {
    const clock = manualClock();
    const api = fakeFetch(clock, (call) =>
      call.url.endsWith('/v0/sessions/hot/status')
        ? json(
            429,
            { userMessage: 'Rate limit exceeded for status polling. Retry after 59 seconds.' },
            { 'retry-after': '59' },
          )
        : json(200, { status: 'idle', data: [] }),
    );
    const client = new ConductorClient({ baseUrl: BASE, token: 't', fetchImpl: api.fetch, clock });
    await expect(client.getSessionStatus('hot', 2)).rejects.toMatchObject({
      kind: 'rateLimited',
      scope: 'status',
    });
    await expect(client.getSessionStatus('hot', 2)).rejects.toMatchObject({ scope: 'status' });
    expect(api.calls).toHaveLength(1);
    await client.getSessionStatus('cold', 2);
    await client.listMessages('hot', { after: 'x', limit: 100 }, 2);
    expect(api.calls).toHaveLength(3);
    expect(client.effectiveBudget).toBe(120);
    expect(client.isRateLimited()).toBe(false);
  });

  it('backs off 1, 2 s ... after server errors and globally after network failures', async () => {
    const clock = manualClock();
    let mode: 'error' | 'ok' | 'down' = 'error';
    const api = fakeFetch(clock, () => {
      if (mode === 'down') throw new TypeError('fetch failed');
      return mode === 'error'
        ? json(503, { userMessage: 'unavailable' })
        : json(200, { status: 'idle' });
    });
    const client = new ConductorClient({ baseUrl: BASE, token: 't', fetchImpl: api.fetch, clock });
    await expect(client.getSessionStatus('s', 2)).rejects.toMatchObject({
      kind: 'server',
      retryAfterMs: 1_000,
    });
    await expect(client.getSessionStatus('s', 2)).rejects.toMatchObject({ kind: 'server' });
    expect(api.calls).toHaveLength(1);
    clock.t += 1_000;
    await expect(client.getSessionStatus('s', 2)).rejects.toMatchObject({ retryAfterMs: 2_000 });
    clock.t += 2_000;
    mode = 'ok';
    await client.getSessionStatus('s', 2);

    mode = 'down';
    await expect(client.getSession('x')).rejects.toMatchObject({ kind: 'network' });
    expect(client.pausedUntil).toBe(clock.t + 1_000);
  });

  it('classifies auth and not-found errors and maps them to short user messages', async () => {
    const clock = manualClock();
    const api = fakeFetch(clock, (call) =>
      call.url.includes('/missing')
        ? json(404, { userMessage: 'Cursor message not found in this session', code: 'NOT_FOUND' })
        : json(401, { userMessage: 'Invalid API key' }),
    );
    const client = new ConductorClient({ baseUrl: BASE, token: 't', fetchImpl: api.fetch, clock });
    const notFound = await client.getSession('missing').catch((e: unknown) => e);
    expect(notFound).toMatchObject({
      kind: 'notFound',
      apiMessage: 'Cursor message not found in this session',
    });
    const denied = await client.me().catch((e: unknown) => e);
    expect(denied).toMatchObject({ kind: 'unauthorized', status: 401 });
    expect(userFacingMessage(denied)).toBe('Conductor refused: no permission');
    expect(userFacingMessage(notFound)).toBe('Session not found');
    expect(userFacingMessage(new ConductorApiError('network', 'x'))).toBe(
      "Couldn't reach Conductor",
    );
    expect(
      userFacingMessage(
        new ConductorApiError('badRequest', 'x', { apiMessage: 'message too long' }),
      ),
    ).toBe('Conductor refused the request: message too long');
  });

  it('sends user actions as POSTs with the expected bodies', async () => {
    const clock = manualClock();
    const api = fakeFetch(clock, () => json(200, { messageId: 'm', state: 'queued' }));
    const client = new ConductorClient({ baseUrl: BASE, token: 't', fetchImpl: api.fetch, clock });
    await client.sendMessage('s1', 'continue', 'b1c3e2a0-1111-4222-8333-444455556666');
    await client.cancelSession('s1');
    await client.archiveSession('s1');
    await client.unarchiveSession('s1');
    expect(api.calls.map((c) => `${c.method} ${c.url.replace(BASE, '')}`)).toEqual([
      'POST /v0/sessions/s1/messages',
      'POST /v0/sessions/s1/cancel',
      'POST /v0/sessions/s1/archive',
      'POST /v0/sessions/s1/unarchive',
    ]);
    expect(JSON.parse(api.calls[0].body ?? '{}')).toEqual({
      message: 'continue',
      messageId: 'b1c3e2a0-1111-4222-8333-444455556666',
    });
    expect(api.calls[0].headers['content-type']).toBe('application/json');
    expect(api.calls[1].body).toBeUndefined();
    expect(api.calls[1].headers['content-type']).toBeUndefined();
  });
});
