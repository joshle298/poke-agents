import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConductorSessionSummary } from '../../core/src/messages.js';
import { agentCreatedMessage } from '../src/agentMessages.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import type { ClientMessageContext } from '../src/clientMessageHandler.js';
import { POKEMON_CATALOG } from '../src/pokemon/speciesCatalog.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { DEMO_CAST, DEMO_IDS, DEMO_WORKERS } from '../src/providers/stream/demo/cast.js';
import { DEMO_CYCLE_SEC } from '../src/providers/stream/demo/constants.js';
import {
  createDemoProvider,
  type DemoProvider,
  resolveDemoSpeed,
} from '../src/providers/stream/demo/demo.js';
import { handleStreamSessionMessage } from '../src/streamSessionMessages.js';

type Message = Record<string, unknown>;
type Role = keyof typeof DEMO_IDS;

const LEGENDARY_DEX = new Set(POKEMON_CATALOG.legendaries.map((l) => l.dex));

describe('demo provider (synthetic sessions through the real stream driver)', () => {
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let provider: DemoProvider;
  let sent: Message[];
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  async function start(options: Parameters<typeof createDemoProvider>[0] = {}): Promise<void> {
    provider = createDemoProvider({ log: () => undefined, ...options });
    await provider.start(runtime.attachStreamProvider(provider));
  }

  /** Let `seconds` of demo time pass (timers, the driver's included). */
  async function play(seconds: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(seconds * 1_000);
  }

  function agentOf(role: Role): number | undefined {
    return runtime.streamDriver('conductor')?.agentIdFor(DEMO_IDS[role]);
  }

  function requireAgent(role: Role): number {
    const id = agentOf(role);
    if (id === undefined) throw new Error(`${role} is not in the office`);
    return id;
  }

  function ofType(type: string): Message[] {
    return sent.filter((m) => m.type === type);
  }

  function statuses(role: Role): Message[] {
    const id = agentOf(role);
    return ofType('agentStatus').filter((m) => m.id === id);
  }

  function ctx(): ClientMessageContext {
    return { store, runtime, cache: null, privileged: true };
  }

  /** A client message as the office sends it; resolves with its replies. */
  async function client(msg: Message): Promise<Message[]> {
    const replies: Message[] = [];
    handleStreamSessionMessage(msg, (m) => replies.push(m), ctx());
    await vi.advanceTimersByTimeAsync(0);
    return replies;
  }

  function summaries(): ConductorSessionSummary[] {
    return provider.listSessions();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    store = new AgentStateStore();
    sent = [];
    store.on('agentAdded', (id, agent) => sent.push({ ...agentCreatedMessage(id, agent) }));
    store.on('agentRemoved', (id) => sent.push({ type: 'agentClosed', id }));
    store.on('broadcast', (m) => sent.push(m));
    runtime = new AgentRuntime(store, claudeProvider);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('the demo must not touch the network');
    });
  });

  afterEach(async () => {
    await provider?.stop();
    runtime.dispose();
    store.dispose();
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it('opens on a busy office: the Lead is a legendary with a child, a hidden session waits in the list', async () => {
    await start();

    for (const role of ['lead', 'prototype', 'alerts', 'deps'] as const) {
      expect(agentOf(role), role).toBeDefined();
    }
    expect(agentOf('copy')).toBeUndefined(); // hidden
    const lead = store.get(requireAgent('lead'))!;
    expect(lead.isTeamLead).toBe(true);
    expect(LEGENDARY_DEX.has(lead.species!)).toBe(true);
    expect(store.get(requireAgent('prototype'))!.leadAgentId).toBe(lead.id);
    // The Lead was created as a Lead: its first agentCreated already shows the legendary.
    expect(ofType('agentCreated').find((m) => m.id === lead.id)?.species).toBe(lead.species);

    const status = ofType('conductorStatus').at(-1)!;
    expect(status).toMatchObject({ state: 'connected', visibleCount: 4, sessionCount: 5 });
    expect(String(status.account)).toMatch(/demo/);
    const copy = summaries().find((s) => s.sessionId === DEMO_IDS.copy);
    expect(copy).toMatchObject({ hidden: true, harness: 'cursor' });
    expect(summaries().find((s) => s.sessionId === DEMO_IDS.deps)?.pinned).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('spawns five workers in the first 20 s, each thrown out of the Lead, on a mix of harnesses', async () => {
    await start();
    await play(20);

    const lead = requireAgent('lead');
    const harnesses = new Set<string>();
    for (const worker of DEMO_WORKERS) {
      const id = requireAgent(worker);
      expect(store.get(id)!.leadAgentId, worker).toBe(lead);
      const created = ofType('agentCreated').find((m) => m.id === id)!;
      expect(created).toMatchObject({ isTeammate: true, parentAgentId: lead });
      harnesses.add(String(store.get(id)!.details?.harness));
    }
    expect([...harnesses].sort()).toEqual(['claude', 'codex', 'cursor']);

    await play(1); // the debounced link snapshot
    const links = ofType('agentLinks').at(-1)!.links as Array<Record<string, unknown>>;
    for (const worker of DEMO_WORKERS) {
      expect(links).toContainEqual(
        expect.objectContaining({ fromId: lead, toId: requireAgent(worker), kind: 'spawned' }),
      );
    }
    // Tools ran and were labelled the way the Conductor provider labels them.
    expect(ofType('agentToolStart').map((m) => m.status)).toContain('Reading migrate-to-v2.md');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends live messages between the Lead and its workers, with previews', async () => {
    await start();
    await play(60);

    const lead = requireAgent('lead');
    const messages = ofType('agentMessage');
    expect(messages).toContainEqual(
      expect.objectContaining({
        fromId: requireAgent('docs'),
        toId: lead,
        kind: 'messaged',
        preview: expect.stringContaining('Docs are ready'),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ fromId: lead, toId: requireAgent('migration') }),
    );
    // The Pokédex shows both ends of the exchange.
    const [detail] = await client({ type: 'requestSessionDetail', id: lead });
    expect(detail.entries).toContainEqual(
      expect.objectContaining({
        role: 'peerIn',
        peerId: requireAgent('docs'),
        peerLabel: 'Update docs',
      }),
    );
  });

  it('faints "Fix flaky tests" on an error, and the Lead revives it', async () => {
    await start();
    await play(40);

    const flaky = requireAgent('flaky');
    expect(store.get(flaky)!.isErrored).toBe(true);
    expect(statuses('flaky').at(-1)).toMatchObject({
      status: 'error',
      errorMessage: expect.stringContaining('out of memory'),
    });
    expect(summaries().find((s) => s.sessionId === DEMO_IDS.flaky)?.status).toBe('error');

    await play(45); // the Lead checks on it at 75 s and sends "continue"
    expect(store.get(flaky)!.isErrored).toBeFalsy();
    expect(statuses('flaky').at(-1)).toMatchObject({ status: 'active' });

    await play(20);
    expect(ofType('agentMessage')).toContainEqual(
      expect.objectContaining({
        fromId: flaky,
        preview: expect.stringContaining('Flaky test fixed'),
      }),
    );
  });

  it('a Revive click ("continue") wakes the fainted worker before the Lead does', async () => {
    await start();
    await play(40);
    const flaky = requireAgent('flaky');

    const replies = await client({ type: 'sendSessionMessage', id: flaky, text: 'continue' });
    expect(replies).toContainEqual(
      expect.objectContaining({ type: 'conductorActionResult', ok: true, id: flaky }),
    );
    await play(3);
    expect(store.get(flaky)!.isErrored).toBeFalsy();
    await play(40); // past the Lead's check: it has nothing to revive
    expect(
      ofType('agentMessage').filter(
        (m) => m.toId === flaky && String(m.preview).startsWith('continue'),
      ),
    ).toEqual([]);
  });

  it('"Review PR #42" waits on a question with options, and a reply with an option answers it', async () => {
    await start();
    await play(35);

    const review = requireAgent('review');
    expect(statuses('review').at(-1)).toMatchObject({ status: 'waiting', awaitingInput: true });
    const [detail] = await client({ type: 'requestSessionDetail', id: review });
    expect(detail.question).toMatchObject({
      kind: 'askUser',
      text: expect.stringContaining('PR #42'),
    });
    const options = (detail.question as { options: string[] }).options;
    expect(options).toHaveLength(3);

    const replies = await client({ type: 'sendSessionMessage', id: review, text: options[0] });
    expect(replies).toContainEqual(expect.objectContaining({ ok: true }));
    await play(2);
    expect(statuses('review').at(-1)).toMatchObject({ status: 'active' });
    const [after] = await client({ type: 'requestSessionDetail', id: review });
    expect(after.question).toBeUndefined();
    expect(after.entries).toContainEqual(
      expect.objectContaining({ role: 'user', text: options[0] }),
    );

    await play(15);
    expect(ofType('agentMessage')).toContainEqual(
      expect.objectContaining({ fromId: review, preview: 'Approved PR #42.' }),
    );
  });

  it('levels workers up and evolves "Triage nightly alerts" within two minutes', async () => {
    await start();
    const alerts = requireAgent('alerts');
    const before = store.get(alerts)!;
    const [species, level] = [before.species, before.level];
    expect(level).toBe(15);

    await play(120);
    const after = store.get(alerts)!;
    expect(after.level).toBe(16);
    expect(after.species).not.toBe(species); // it evolved
    expect(
      ofType('agentDetails')
        .filter((m) => m.id === alerts)
        .at(-1),
    ).toMatchObject({
      species: after.species,
      level: 16,
    });
    // New workers climbed several levels from Lv 1.
    expect(store.get(requireAgent('migration'))!.level).toBeGreaterThanOrEqual(4);
  });

  it('climbs context usage and compacts it when the window is nearly full', async () => {
    await start();
    await play(73);
    const perf = requireAgent('perf');
    const usage = ofType('agentContextUsage').filter((m) => m.id === perf);
    const peak = Math.max(...usage.map((m) => Number(m.contextTokens)));
    expect(peak / Number(usage[0].maxContextTokens)).toBeGreaterThan(0.85);

    await play(5);
    expect(
      Number(
        ofType('agentContextUsage')
          .filter((m) => m.id === perf)
          .at(-1)!.contextTokens,
      ),
    ).toBeLessThan(peak / 2);
  });

  it('deposits the finished prototype in the PC with its Pokémon, and withdraws it on request', async () => {
    await start();
    const prototype = requireAgent('prototype');
    const species = store.get(prototype)!.species;
    await play(25);

    expect(agentOf('prototype')).toBeUndefined();
    expect(sent).toContainEqual({ type: 'agentClosed', id: prototype });
    const [list] = await client({ type: 'requestConductorSessions' });
    const boxed = (list.sessions as ConductorSessionSummary[]).find(
      (s) => s.sessionId === DEMO_IDS.prototype,
    );
    expect(boxed).toMatchObject({ archived: true, species });

    const replies = await client({ type: 'restoreSession', sessionId: DEMO_IDS.prototype });
    expect(replies).toContainEqual(expect.objectContaining({ ok: true, action: 'restoreSession' }));
    expect(agentOf('prototype')).toBeDefined();
    expect(store.get(requireAgent('prototype'))!.species).toBe(species);
  });

  it('stops, deposits, hides and pins sessions against the fake state', async () => {
    await start();
    await play(10);
    const migration = requireAgent('migration');

    await client({ type: 'stopSession', id: migration });
    await play(3);
    expect(statuses('migration').at(-1)).toMatchObject({ status: 'waiting' });

    await client({ type: 'setSessionHidden', sessionId: DEMO_IDS.migration, hidden: true });
    expect(agentOf('migration')).toBeUndefined();
    expect(summaries().find((s) => s.sessionId === DEMO_IDS.migration)?.hidden).toBe(true);
    await client({ type: 'setSessionHidden', sessionId: DEMO_IDS.copy, hidden: false });
    expect(agentOf('copy')).toBeDefined();

    await client({ type: 'setSessionPinned', sessionId: DEMO_IDS.alerts, pinned: true });
    expect(summaries().find((s) => s.sessionId === DEMO_IDS.alerts)?.pinned).toBe(true);

    const deposit = await client({ type: 'archiveSession', sessionId: DEMO_IDS.docs });
    expect(deposit).toContainEqual(expect.objectContaining({ ok: true, action: 'archiveSession' }));
    expect(agentOf('docs')).toBeUndefined();
    // A deposited session is skipped by the story: the Lead's later messages go elsewhere.
    await play(60);
    expect(agentOf('docs')).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers a message to an idle session with a short turn and a reply', async () => {
    await start();
    const deps = requireAgent('deps');
    await client({ type: 'sendSessionMessage', id: deps, text: 'Anything risky in the bumps?' });
    await play(1);
    expect(statuses('deps').at(-1)).toMatchObject({ status: 'active' });
    await play(15);
    expect(statuses('deps').at(-1)).toMatchObject({ status: 'waiting' });
    const [detail] = await client({ type: 'requestSessionDetail', id: deps });
    const entries = detail.entries as Array<{ role: string; text: string }>;
    const asked = entries.findIndex((e) => e.text === 'Anything risky in the bumps?');
    expect(asked).toBeGreaterThanOrEqual(0);
    expect(entries.slice(asked + 1).some((e) => e.role === 'assistant')).toBe(true);
  });

  it('continues a session with another model: a new session thrown out of the original, which stays as it was', async () => {
    await start();
    await play(1);
    const origId = requireAgent('deps');
    const origSpecies = store.get(origId)!.species;
    const catalog = (await client({ type: 'requestModelCatalog' }))[0] as {
      favorites: Array<{ agent: string }>;
    };
    expect(catalog.favorites[0]).toEqual({ agent: 'claude', model: 'opus-5-5-1m', effort: 'high' });

    const refused = await client({
      type: 'continueWithModel',
      id: origId,
      agent: 'codex',
      model: 'opus-5-5-1m',
      message: 'Go on.',
    });
    expect(refused[0]).toMatchObject({ ok: false, message: "Codex doesn't offer that model." });

    sent = [];
    const replies = await client({
      type: 'continueWithModel',
      id: origId,
      agent: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
      fastMode: true,
      message: 'Continue the work from the session "Dependency bumps" in this workspace.',
    });
    expect(replies[0]).toMatchObject({ action: 'continueWithModel', id: origId, ok: true });
    const newSession = String(replies[0].sessionId);
    const newId = runtime.streamDriver('conductor')!.agentIdFor(newSession)!;
    expect(newId).toBeDefined();
    // Thrown out of the original, which neither becomes a legendary nor changes.
    expect(ofType('agentCreated').find((m) => m.id === newId)).toMatchObject({
      isTeammate: true,
      parentAgentId: origId,
    });
    expect(store.get(origId)!.species).toBe(origSpecies);
    expect(LEGENDARY_DEX.has(store.get(origId)!.species!)).toBe(false);
    expect(store.get(origId)!.isTeamLead).toBeUndefined();
    const created = store.get(newId)!;
    expect(created.label).toBe('Dependency bumps · GPT-5.5');
    expect(created.details).toMatchObject({
      model: 'gpt-5.5',
      modelId: 'gpt-5.5',
      harness: 'codex',
      effort: 'medium',
      fastMode: true,
      workspaceId: DEMO_CAST.deps.spec.workspace.id,
    });
    expect(summaries().find((s) => s.sessionId === newSession)).toMatchObject({
      leadSessionId: DEMO_IDS.deps,
      handoff: true,
    });
    // It works through its handoff turn, then is done.
    expect(ofType('agentStatus').find((m) => m.id === newId)).toMatchObject({ status: 'active' });
    await play(30);
    expect(
      ofType('agentStatus')
        .filter((m) => m.id === newId)
        .at(-1),
    ).toMatchObject({
      status: 'waiting',
    });
    await play(1);
    expect(ofType('agentLinks').at(-1)?.links).toContainEqual(
      expect.objectContaining({ fromId: origId, toId: newId, kind: 'spawned' }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pages back through a synthetic transcript for the Chat tab', async () => {
    await start();
    const lead = requireAgent('lead');
    const [first] = await client({ type: 'requestSessionHistory', id: lead });
    expect(first).toMatchObject({ type: 'sessionHistory', hasMore: true });
    expect((first.entries as unknown[]).length).toBe(30);
    const [second] = await client({
      type: 'requestSessionHistory',
      id: lead,
      before: first.before,
    });
    const keys = [...(second.entries as Message[]), ...(first.entries as Message[])].map(
      (e) => e.key,
    );
    expect(new Set(keys).size).toBe(keys.length);
    const all = [...(second.entries as Message[]), ...(first.entries as Message[])];
    expect(all.map((e) => Number(e.at))).toEqual(
      [...all.map((e) => Number(e.at))].sort((a, b) => a - b),
    );
    const [bad] = await client({ type: 'requestSessionHistory', id: lead, before: 'o12' });
    expect(bad.error).toBeTruthy();
  });

  it('keeps going in later rounds: every worker gets a new task', async () => {
    await start({ speed: 10 });
    await play(DEMO_CYCLE_SEC / 10 + 4);
    const lead = requireAgent('lead');
    const fromLead = ofType('agentMessage').filter(
      (m) => m.fromId === lead && Number(m.at) >= Date.now() - 5_000,
    );
    expect(fromLead.length).toBeGreaterThanOrEqual(3);
  });

  it('plays the same story every run', async () => {
    const trace = async (): Promise<string[]> => {
      sent = [];
      await start();
      await play(90);
      await provider.stop();
      runtime.dispose();
      const out = sent
        .filter((m) =>
          ['agentCreated', 'agentStatus', 'agentToolStart', 'agentMessage'].includes(
            String(m.type),
          ),
        )
        .map(
          (m) =>
            `${m.type}:${m.id ?? `${m.fromId}>${m.toId}`}:${m.status ?? m.preview ?? m.species ?? ''}`,
        );
      store.dispose();
      store = new AgentStateStore();
      store.on('agentAdded', (id, agent) => sent.push({ ...agentCreatedMessage(id, agent) }));
      store.on('broadcast', (m) => sent.push(m));
      runtime = new AgentRuntime(store, claudeProvider);
      return out;
    };
    const first = await trace();
    const second = await trace();
    expect(first.length).toBeGreaterThan(100);
    expect(second).toEqual(first);
  });

  it('plays the same story at any speed: the same Pokémon, in the same order, at the same levels', async () => {
    const run = async (speed: number): Promise<string[]> => {
      sent = [];
      await start({ speed });
      await play(150 / speed);
      const out = [
        ...ofType('agentCreated').map((m) => `created:${m.id}:${m.label}:${m.species}`),
        ...[...store.values()].map((a) => `now:${a.label}:${a.species}:${a.level}`),
      ];
      await provider.stop();
      runtime.dispose();
      store.dispose();
      store = new AgentStateStore();
      store.on('agentAdded', (id, agent) => sent.push({ ...agentCreatedMessage(id, agent) }));
      store.on('broadcast', (m) => sent.push(m));
      runtime = new AgentRuntime(store, claudeProvider);
      return out;
    };
    const normal = await run(1);
    expect(await run(10)).toEqual(normal);
  });

  it('reads the speed factor from the option, then POKE_AGENTS_DEMO_SPEED, within bounds', () => {
    expect(resolveDemoSpeed(undefined, {})).toBe(1);
    expect(resolveDemoSpeed(4, { POKE_AGENTS_DEMO_SPEED: '2' })).toBe(4);
    expect(resolveDemoSpeed(undefined, { POKE_AGENTS_DEMO_SPEED: '2' })).toBe(2);
    expect(resolveDemoSpeed(1_000, {})).toBe(20);
    expect(resolveDemoSpeed(undefined, { POKE_AGENTS_DEMO_SPEED: 'fast' })).toBe(1);
    expect(DEMO_CAST.lead.spec.label).toBe('Release v2 orchestration');
  });
});
