/**
 * Switch model against the Conductor provider: the model catalog with the
 * user's favorites, and continueWithModel's create-session request, retries,
 * error mapping and the handoff link. Everything runs against the in-memory
 * fake API; nothing reaches Conductor.
 */

import { describe, expect, it } from 'vitest';

import type { ModelChoice } from '../../core/src/provider.js';
import {
  CONTINUE_REUSE_MS,
  FAVORITES_RETRY_MS,
  FAVORITES_TTL_MS,
} from '../src/providers/stream/conductor/constants.js';
import type { FakeCall, FakeConductorApi } from './fixtures/conductor/fakeConductorApi.js';
import {
  boot,
  idleFeed,
  NOW,
  settle,
  tmpStateDir,
  uuid,
} from './fixtures/conductor/pollerHarness.js';

const WS = uuid(0x301);
const ORIG = uuid(0x302);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CHOICE: ModelChoice = {
  agent: 'codex',
  model: 'gpt-5.5',
  effort: 'medium',
  fastMode: true,
  message: 'Continue the work from the session "Fix flaky tests" in this workspace.',
};

function office(api: FakeConductorApi): void {
  api.addWorkspace({
    id: WS,
    name: 'flaky',
    number: 7,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
  });
  api.addSession({
    id: ORIG,
    workspaceId: WS,
    name: 'Fix flaky tests',
    items: idleFeed(ORIG, NOW - 60_000),
  });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const isCreate = (c: { method: string; path: string }) =>
  c.method === 'POST' && c.path === '/v0/sessions';
const isStatusOf = (id: string) => (c: { method: string; path: string }) =>
  c.method === 'GET' && c.path === `/v0/sessions/${id}/status`;
const createBodies = (api: FakeConductorApi) =>
  api.calls.filter(isCreate).map((c) => c.body as Record<string, unknown>);
/** Sessions in the workspace besides the original. */
const created = (api: FakeConductorApi) =>
  [...api.sessions.values()].filter((s) => s.workspaceId === WS && s.id !== ORIG);
/** Like a server whose answer is lost: the create commits, the reply is a 500. */
const commitThen500 = (api: FakeConductorApi) => (call: FakeCall) => {
  api.answer(call);
  return json(500, { userMessage: 'Internal error' });
};
/** Every status check of `id` fails, so nobody can say whether it exists. */
const statusDown = (api: FakeConductorApi, times = 10) =>
  api.override(
    (c) => c.method === 'GET' && /^\/v0\/sessions\/[^/]+\/status$/.test(c.path),
    () => json(503, { userMessage: 'Unavailable' }),
    times,
  );

describe('Conductor Switch model: the model catalog', () => {
  it('serves the table with the favorites Conductor lists that it accepts, read once per TTL', async () => {
    const { api, provider } = await boot({
      prepare: (a) => {
        office(a);
        a.favoriteModels = [
          { agent: 'claude', model: 'opus-5-5-1m', effort: 'ultracode', fastMode: false },
          { agent: 'acp', model: 'custom', acpAgentId: 'x' },
          { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', fastMode: true },
        ];
      },
    });
    const catalog = await provider.getModelCatalog();
    expect(catalog.agents.map((a) => a.agent)).toEqual(['claude', 'codex', 'cursor']);
    expect(catalog.favorites).toEqual([
      { agent: 'claude', model: 'opus-5-5-1m', effort: 'ultracode' },
      { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', fastMode: true },
    ]);
    expect(catalog.defaultAgent).toBe('claude');
    await provider.getModelCatalog();
    expect(api.callsTo('/v0/favorite-models')).toHaveLength(1);
    await provider.stop();
  });

  it('still serves the catalog when the favorites can’t be read', async () => {
    const { api, provider, logs } = await boot({ prepare: office });
    api.override(
      (c) => c.path === '/v0/favorite-models',
      () => json(404, { userMessage: 'Only in cloud organizations' }),
    );
    const catalog = await provider.getModelCatalog();
    expect(catalog.favorites).toEqual([]);
    expect(catalog.agents).toHaveLength(3);
    expect(logs.some((l) => l.startsWith('favorite models unavailable'))).toBe(true);
    await provider.stop();
  });

  it('asks a local organization (404) for favorites once per TTL, not on every open', async () => {
    const { api, clock, provider } = await boot({ prepare: office });
    api.override(
      (c) => c.path === '/v0/favorite-models',
      () => json(404, { userMessage: 'Only in cloud organizations' }),
      5,
    );
    await provider.getModelCatalog();
    await provider.getModelCatalog();
    clock.t += FAVORITES_TTL_MS - 1;
    await provider.getModelCatalog();
    expect(api.callsTo('/v0/favorite-models')).toHaveLength(1);
    clock.t += 1;
    await provider.getModelCatalog();
    expect(api.callsTo('/v0/favorite-models')).toHaveLength(2);
    await provider.stop();
  });

  it('tries a failed read again after a short pause, keeping the favorites it had', async () => {
    const { api, clock, provider } = await boot({
      prepare: (a) => {
        office(a);
        a.favoriteModels = [{ agent: 'cursor', model: 'auto' }];
      },
    });
    expect((await provider.getModelCatalog()).favorites).toEqual([
      { agent: 'cursor', model: 'auto' },
    ]);
    clock.t += FAVORITES_TTL_MS;
    api.override(
      (c) => c.path === '/v0/favorite-models',
      () => json(502, { userMessage: 'Bad gateway' }),
    );
    expect((await provider.getModelCatalog()).favorites).toEqual([
      { agent: 'cursor', model: 'auto' },
    ]);
    await provider.getModelCatalog();
    expect(api.callsTo('/v0/favorite-models')).toHaveLength(2);
    clock.t += FAVORITES_RETRY_MS;
    await provider.getModelCatalog();
    expect(api.callsTo('/v0/favorite-models')).toHaveLength(3);
    await provider.stop();
  });

  it('shares one read between pickers opening at the same time', async () => {
    const { api, provider } = await boot({ prepare: office });
    let release: (r: Response) => void = () => {};
    api.override(
      (c) => c.path === '/v0/favorite-models',
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    const first = provider.getModelCatalog();
    const second = provider.getModelCatalog();
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(json(200, { favoriteModels: [{ agent: 'codex', model: 'gpt-5.5' }] }));
    const [a, b] = await Promise.all([first, second]);
    expect(a.favorites).toEqual([{ agent: 'codex', model: 'gpt-5.5' }]);
    expect(b.favorites).toEqual(a.favorites);
    expect(api.callsTo('/v0/favorite-models')).toHaveLength(1);
    await provider.stop();
  });
});

describe('Conductor Switch model: continueWithModel', () => {
  it('creates one session in the same workspace with exactly the documented fields', async () => {
    const { api, provider } = await boot({ prepare: office });
    const { sessionId } = await provider.continueWithModel(ORIG, CHOICE);
    const creates = api.calls.filter(isCreate);
    expect(creates).toHaveLength(1);
    const body = creates[0].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        'agent',
        'effort',
        'fastMode',
        'message',
        'messageId',
        'model',
        'name',
        'sessionId',
        'workspaceId',
      ].sort(),
    );
    expect(body).toMatchObject({
      workspaceId: WS,
      agent: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
      fastMode: true,
      name: 'Fix flaky tests · GPT-5.5',
      message: CHOICE.message,
    });
    expect(body.sessionId).toMatch(UUID);
    expect(body.messageId).toMatch(UUID);
    expect(sessionId).toBe(body.sessionId);
    // No other write: the original session is never touched.
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    await provider.stop();
  });

  it('knows the new session’s agent even when its model id doesn’t name it', async () => {
    const { provider, sink } = await boot({ prepare: office });
    const { sessionId } = await provider.continueWithModel(ORIG, {
      agent: 'claude',
      model: 'opus-5-5-1m',
      message: 'Go on.',
    });
    await settle(provider);
    expect(sink.lastUpsert(sessionId)?.details).toMatchObject({
      harness: 'claude',
      model: 'opus-5-5-1m',
      modelId: 'opus-5-5-1m',
    });
    await provider.stop();
  });

  it('states the create-session model id beside the resolved one', async () => {
    const { sink, provider } = await boot({ prepare: office });
    // The fake's sessions report model opus-5-5-1m, resolved claude-opus-5-5[1m].
    expect(sink.lastUpsert(ORIG)?.details).toMatchObject({
      model: 'claude-opus-5-5[1m]',
      modelId: 'opus-5-5-1m',
    });
    await provider.stop();
  });

  it('leaves out effort and fast mode when none were chosen', async () => {
    const { api, provider } = await boot({ prepare: office });
    await provider.continueWithModel(ORIG, { agent: 'cursor', model: 'auto', message: 'Go on.' });
    const body = api.calls.find(isCreate)?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('effort');
    expect(body).not.toHaveProperty('fastMode');
    expect(body.name).toBe('Fix flaky tests · Auto');
    await provider.stop();
  });

  it('retries a 5xx and a network failure with the same session and message ids', async () => {
    const { api, provider } = await boot({ prepare: office });
    api.override(isCreate, () => json(502, { userMessage: 'Bad gateway' }));
    api.override(isCreate, () => Promise.reject(new TypeError('fetch failed')));
    const { sessionId } = await provider.continueWithModel(ORIG, CHOICE);
    const creates = api.calls.filter(isCreate).map((c) => c.body as Record<string, unknown>);
    expect(creates).toHaveLength(3);
    expect(new Set(creates.map((b) => b.sessionId)).size).toBe(1);
    expect(new Set(creates.map((b) => b.messageId)).size).toBe(1);
    expect(sessionId).toBe(creates[0].sessionId);
    await provider.stop();
  });

  it('believes a 409 only when Conductor has the session', async () => {
    const { api, provider, sink } = await boot({ prepare: office });
    // The first attempt commits but its answer is lost; the retry gets a 409.
    api.override(isCreate, commitThen500(api));
    api.override(isCreate, () => json(409, { userMessage: 'Session already exists' }));
    const { sessionId } = await provider.continueWithModel(ORIG, CHOICE);
    expect(createBodies(api)).toHaveLength(2);
    expect(sessionId).toBe(createBodies(api)[0].sessionId);
    expect(api.calls.filter(isStatusOf(sessionId))).toHaveLength(1);
    expect(created(api)).toHaveLength(1);
    expect(sink.links.some((l) => l.toSessionId === sessionId && l.handoff)).toBe(true);
    await provider.stop();
  });

  it('checks before refusing when an earlier attempt may have gone through', async () => {
    const { api, provider } = await boot({ prepare: office });
    // The first attempt commits but answers 502; the retry is refused (400).
    api.override(isCreate, (call) => {
      api.answer(call);
      return json(502, { userMessage: 'Bad gateway' });
    });
    api.override(isCreate, () => json(400, { userMessage: 'Session id already used' }));
    const { sessionId } = await provider.continueWithModel(ORIG, CHOICE);
    expect(createBodies(api)).toHaveLength(2);
    expect(created(api).map((s) => s.id)).toEqual([sessionId]);
    // Without the commit, the refusal stands.
    api.override(isCreate, () => json(502, { userMessage: 'Bad gateway' }));
    api.override(isCreate, () => json(400, { userMessage: 'Session id already used' }));
    await expect(
      provider.continueWithModel(ORIG, { ...CHOICE, message: 'Another try.' }),
    ).rejects.toThrow('Conductor refused the request: Session id already used');
    expect(created(api)).toHaveLength(1);
    await provider.stop();
  });

  it('refuses a 409 for a session Conductor doesn’t have, and links nothing', async () => {
    const { api, provider, sink } = await boot({ prepare: office });
    api.override(isCreate, () => json(409, { userMessage: 'Name already taken' }));
    await expect(provider.continueWithModel(ORIG, CHOICE)).rejects.toThrow(
      'Conductor refused the request: Name already taken',
    );
    const [body] = createBodies(api);
    expect(api.calls.filter(isStatusOf(body.sessionId as string))).toHaveLength(1);
    expect(sink.links.filter((l) => l.fromSessionId === ORIG)).toEqual([]);
    expect(created(api)).toEqual([]);
    await provider.stop();
  });

  it('finds the session when every answer was lost, and starts it once', async () => {
    const { api, provider, sink } = await boot({ prepare: office });
    api.override(isCreate, commitThen500(api), 3);
    const { sessionId } = await provider.continueWithModel(ORIG, CHOICE);
    expect(createBodies(api)).toHaveLength(3);
    expect(new Set(createBodies(api).map((b) => b.sessionId))).toEqual(new Set([sessionId]));
    expect(created(api).map((s) => s.id)).toEqual([sessionId]);
    expect(sink.links.filter((l) => l.toSessionId === sessionId)).toHaveLength(1);
    await provider.stop();
  });

  it('a second click after an unconfirmed start reuses its ids: still one session', async () => {
    const { api, provider, sink } = await boot({ prepare: office });
    // Conductor commits, every answer is lost, and it can't be asked either.
    api.override(isCreate, commitThen500(api), 3);
    statusDown(api);
    await expect(provider.continueWithModel(ORIG, CHOICE)).rejects.toThrow(
      "Conductor didn't confirm the new session. Start again with the same choice: it won't make a second one.",
    );
    expect(created(api)).toHaveLength(1);
    expect(sink.links.filter((l) => l.fromSessionId === ORIG)).toEqual([]);

    // The user clicks Start again with the same choice.
    const { sessionId } = await provider.continueWithModel(ORIG, CHOICE);
    const bodies = createBodies(api);
    expect(bodies).toHaveLength(4);
    expect(new Set(bodies.map((b) => b.sessionId))).toEqual(new Set([sessionId]));
    expect(new Set(bodies.map((b) => b.messageId)).size).toBe(1);
    expect(created(api).map((s) => s.id)).toEqual([sessionId]);
    expect(sink.links.filter((l) => l.toSessionId === sessionId && l.live)).toHaveLength(1);
    await provider.stop();
  });

  it('the same request again after its answer was lost returns the same session, no second create', async () => {
    const { api, provider } = await boot({ prepare: office });
    const first = await provider.continueWithModel(ORIG, CHOICE);
    const again = await provider.continueWithModel(ORIG, CHOICE);
    expect(again).toEqual(first);
    expect(createBodies(api)).toHaveLength(1);
    // Another message is another request.
    const other = await provider.continueWithModel(ORIG, { ...CHOICE, message: 'Something else.' });
    expect(other.sessionId).not.toBe(first.sessionId);
    expect(created(api)).toHaveLength(2);
    await provider.stop();
  });

  it('another choice after an unconfirmed start checks first: refuses once if it exists, links it', async () => {
    const { api, provider, sink } = await boot({ prepare: office });
    api.override(isCreate, commitThen500(api), 3);
    statusDown(api, 1);
    await expect(provider.continueWithModel(ORIG, CHOICE)).rejects.toThrow(
      "Conductor didn't confirm",
    );
    const [firstBody] = createBodies(api);
    const other: ModelChoice = { agent: 'cursor', model: 'auto', message: 'Go on.' };
    await expect(provider.continueWithModel(ORIG, other)).rejects.toThrow(
      'The last try did start “Fix flaky tests · GPT-5.5”.',
    );
    expect(createBodies(api)).toHaveLength(3);
    expect(
      sink.links.some((l) => l.toSessionId === firstBody.sessionId && l.fromSessionId === ORIG),
    ).toBe(true);
    // Asked again, it starts the other one with fresh ids.
    const { sessionId } = await provider.continueWithModel(ORIG, other);
    expect(sessionId).not.toBe(firstBody.sessionId);
    expect(createBodies(api).at(-1)).toMatchObject({ agent: 'cursor', model: 'auto' });
    expect(created(api)).toHaveLength(2);
    await provider.stop();
  });

  it('another choice after an unconfirmed start that never landed starts fresh', async () => {
    const { api, provider } = await boot({ prepare: office });
    api.override(isCreate, () => json(500, { userMessage: 'Internal error' }), 3);
    statusDown(api, 1);
    await expect(provider.continueWithModel(ORIG, CHOICE)).rejects.toThrow(
      "Conductor didn't confirm",
    );
    const [firstBody] = createBodies(api);
    const { sessionId } = await provider.continueWithModel(ORIG, {
      agent: 'cursor',
      model: 'auto',
      message: 'Go on.',
    });
    expect(sessionId).not.toBe(firstBody.sessionId);
    expect(created(api).map((s) => s.id)).toEqual([sessionId]);
    await provider.stop();
  });

  it('forgets an unconfirmed start after CONTINUE_REUSE_MS', async () => {
    const { api, clock, provider } = await boot({ prepare: office });
    api.override(isCreate, () => json(500, { userMessage: 'Internal error' }), 3);
    statusDown(api, 1);
    await expect(provider.continueWithModel(ORIG, CHOICE)).rejects.toThrow(
      "Conductor didn't confirm",
    );
    clock.t += CONTINUE_REUSE_MS;
    await provider.continueWithModel(ORIG, CHOICE);
    const bodies = createBodies(api);
    expect(bodies.at(-1)?.sessionId).not.toBe(bodies[0].sessionId);
    await provider.stop();
  });

  it.each([
    [403, 'Conductor refused: no permission', 1],
    [404, "Conductor couldn't find this session's workspace.", 1],
    [429, 'Conductor is rate limiting requests. Try again shortly.', 1],
    [400, 'Conductor refused the request: Model does not support ultracode', 1],
    [500, 'Conductor had a server error. Try again.', 3],
  ])('maps HTTP %i to "%s" (%i attempt(s))', async (status, message, attempts) => {
    // A 500 that never committed: Conductor says the session isn't there.
    const { api, provider, sink } = await boot({ prepare: office });
    api.override(
      isCreate,
      () =>
        json(
          status,
          { userMessage: 'Model does not support ultracode' },
          status === 429 ? { 'retry-after': '1' } : {},
        ),
      3,
    );
    await expect(provider.continueWithModel(ORIG, CHOICE)).rejects.toThrow(message);
    expect(api.calls.filter(isCreate)).toHaveLength(attempts);
    expect(sink.links.filter((l) => l.fromSessionId === ORIG && l.kind === 'spawned')).toEqual([]);
    await provider.stop();
  });

  it('refuses a model outside the catalog and an unknown session without calling Conductor', async () => {
    const { api, provider } = await boot({ prepare: office });
    await expect(
      provider.continueWithModel(ORIG, { agent: 'claude', model: 'gpt-5.5', message: 'x' }),
    ).rejects.toThrow("Claude doesn't offer that model.");
    await expect(provider.continueWithModel(uuid(0x999), CHOICE)).rejects.toThrow(
      'Session not found',
    );
    expect(api.calls.filter(isCreate)).toEqual([]);
    await provider.stop();
  });

  it('runs one create at a time per session', async () => {
    const { api, provider } = await boot({ prepare: office });
    let release: (r: Response) => void = () => {};
    api.override(isCreate, () => new Promise<Response>((resolve) => (release = resolve)));
    const first = provider.continueWithModel(ORIG, CHOICE);
    await expect(provider.continueWithModel(ORIG, CHOICE)).rejects.toThrow(
      'A new session is already starting.',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = api.calls.find(isCreate)?.body as Record<string, unknown>;
    release(json(201, { id: body.sessionId, deepLink: 'conductor://workspace', name: body.name }));
    await expect(first).resolves.toEqual({ sessionId: body.sessionId });
    expect(api.calls.filter(isCreate)).toHaveLength(1);
    await provider.stop();
  });

  it('links the new session to the original live, before it walks in, and shows it', async () => {
    const { provider, sink } = await boot({ prepare: office });
    const { sessionId } = await provider.continueWithModel(ORIG, CHOICE);
    const linkIndex = sink.links.findIndex((l) => l.toSessionId === sessionId);
    expect(sink.links[linkIndex]).toMatchObject({
      fromSessionId: ORIG,
      toSessionId: sessionId,
      kind: 'spawned',
      live: true,
      handoff: true,
      preview: CHOICE.message,
    });
    expect(sink.adopted.has(sessionId)).toBe(false);
    await settle(provider);
    expect(sink.adopted.has(sessionId)).toBe(true);
    const order = sink.order.filter((e) => e.includes(sessionId));
    expect(order[0]).toBe(`link:spawned:${ORIG}>${sessionId}`);
    const first = sink.firstUpsert(sessionId);
    expect(first).toMatchObject({
      label: 'Fix flaky tests · GPT-5.5',
      initialStatus: 'active',
      details: {
        model: 'gpt-5.5',
        harness: 'codex',
        effort: 'medium',
        fastMode: true,
        workspaceId: WS,
      },
    });
    // The original's Pokédex notes the handoff.
    const detail = await provider.getSessionDetail(ORIG);
    expect(detail?.entries.at(-1)).toMatchObject({
      role: 'peerOut',
      peerSessionId: sessionId,
      text: CHOICE.message,
    });
    // The Sessions list groups it under the original, marked as a handoff so
    // the original gets no LEAD badge.
    expect(provider.listSessions().find((s) => s.sessionId === sessionId)).toMatchObject({
      leadSessionId: ORIG,
      handoff: true,
    });
    await provider.stop();
  });

  it('keeps the new session across a restart, with the handoff restated (not live) before it walks in', async () => {
    const stateDir = tmpStateDir();
    const first = await boot({ stateDir, prepare: office });
    const { sessionId } = await first.provider.continueWithModel(ORIG, CHOICE);
    await settle(first.provider);
    await first.provider.stop();

    const second = await boot({ stateDir, api: first.api, clock: first.clock, prepare: () => {} });
    const link = second.sink.links.find((l) => l.toSessionId === sessionId && l.kind === 'spawned');
    expect(link).toMatchObject({ fromSessionId: ORIG, live: false, handoff: true });
    expect(second.provider.listSessions().find((s) => s.sessionId === sessionId)).toMatchObject({
      leadSessionId: ORIG,
      handoff: true,
    });
    expect(second.sink.adopted.has(sessionId)).toBe(true);
    const order = second.sink.order.filter((e) => e.includes(sessionId));
    expect(order[0]).toBe(`link:spawned:${ORIG}>${sessionId}`);
    expect(order).toContain(`upsert:${sessionId}`);
    await second.provider.stop();
  });
});
