import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConductorSessionSummary } from '../../core/src/messages.js';
import type { AgentEventSink, StreamProvider, StreamSessionInfo } from '../../core/src/provider.js';
import { agentCreatedMessage } from '../src/agentMessages.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  AGENT_ERROR_MESSAGE_MAX_LENGTH,
  AGENT_MESSAGE_MAX_PER_SECOND,
  AGENT_MESSAGE_PAIR_INTERVAL_MS,
  EXTERNAL_STALE_CHECK_INTERVAL_MS,
  STREAM_SNAPSHOT_DEBOUNCE_MS,
  TOOL_DONE_DELAY_MS,
} from '../src/constants.js';
import * as species from '../src/pokemon/speciesAssigner.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { StreamAgentMemory, StreamAgentRecord } from '../src/streamAgentDriver.js';
import { startPermissionTimer, startWaitingTimer } from '../src/timerManager.js';

// The Pokémon assigner is another stream's module; stand in for it with a
// deterministic fake so these tests pin what the DRIVER does with it.
vi.mock('../src/pokemon/speciesAssigner.js', () => ({
  assignSpeciesIfNeeded: vi.fn((agent: { pokemonLine?: string; species?: number }) => {
    if (agent.pokemonLine !== undefined) return;
    agent.pokemonLine = 'pichu';
    agent.species = 172;
  }),
  // Lv = 1 + toolCalls (+ messageCount / 10); evolves into Pikachu at Lv 3.
  updateLevel: vi.fn(
    (
      agent: { level?: number; species?: number; pokemonLine?: string },
      activity: { messageCount?: number; toolCalls?: number },
    ) => {
      const level = 1 + (activity.toolCalls ?? 0) + Math.floor((activity.messageCount ?? 0) / 10);
      const next =
        agent.pokemonLine === 'pichu' ? (level >= 3 ? 25 : 172) : (agent.species ?? undefined);
      const levelChanged = level !== agent.level;
      const speciesChanged = next !== agent.species;
      agent.level = level;
      agent.species = next;
      return { levelChanged, speciesChanged };
    },
  ),
  promoteToOrchestrator: vi.fn((agent: { species?: number; pokemonLine?: string }) => {
    if (agent.pokemonLine === 'mewtwo') return false;
    agent.pokemonLine = 'mewtwo';
    agent.species = 150;
    return true;
  }),
}));

type Message = Record<string, unknown>;

function fakeProvider(overrides: Partial<StreamProvider> = {}): StreamProvider {
  return {
    kind: 'stream',
    id: 'conductor',
    displayName: 'Conductor',
    protocolVersion: 1,
    formatToolStatus: (toolName: string, input?: unknown) => {
      const file = (input as { file_path?: string } | undefined)?.file_path;
      return file ? `${toolName} ${file}` : `Using ${toolName}`;
    },
    permissionExemptTools: new Set<string>(),
    subagentToolNames: new Set(['Task', 'Agent']),
    readingTools: new Set(['Read', 'Monitor']),
    contextWindowForModel: (model) => (model?.startsWith('gpt-') ? 272_000 : undefined),
    start: async () => {},
    stop: async () => {},
    onDismiss: vi.fn(),
    ...overrides,
  };
}

class MemoryStub implements StreamAgentMemory {
  readonly records = new Map<string, StreamAgentRecord>();
  loadStreamAgents(): Map<string, StreamAgentRecord> {
    return new Map(this.records);
  }
  saveStreamAgent(key: string, record: StreamAgentRecord): void {
    this.records.set(key, record);
  }
}

describe('StreamAgentDriver', () => {
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let provider: StreamProvider;
  let memory: MemoryStub;
  let sink: AgentEventSink;
  let sent: Message[];

  function attach(): void {
    sink = runtime.attachStreamProvider(provider, { memory });
  }

  /** Messages of one type, in order. */
  function ofType(type: string): Message[] {
    return sent.filter((m) => m.type === type);
  }

  function session(sessionId: string, extra: Partial<StreamSessionInfo> = {}): StreamSessionInfo {
    return {
      sessionId,
      label: `Session ${sessionId}`,
      directoryName: 'fern',
      details: {
        externalUrl: `conductor://workspace?id=w-${sessionId}&session=${sessionId}`,
        model: 'claude-opus-5-5',
        harness: 'claude',
        workspaceId: `w-${sessionId}`,
        workspaceName: 'Workspace',
        workspaceNumber: 12,
        repo: 'hue-run/fern',
      },
      initialStatus: 'waiting',
      ...extra,
    };
  }

  function agentIdOf(sessionId: string): number {
    const id = runtime.streamDriver('conductor')?.agentIdFor(sessionId);
    if (id === undefined) throw new Error(`session ${sessionId} not in the office`);
    return id;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    store = new AgentStateStore();
    sent = [];
    store.on('agentAdded', (id, agent) => sent.push({ ...agentCreatedMessage(id, agent) }));
    store.on('agentRemoved', (id) => sent.push({ type: 'agentClosed', id }));
    store.on('broadcast', (m) => sent.push(m));
    runtime = new AgentRuntime(store, claudeProvider);
    provider = fakeProvider();
    memory = new MemoryStub();
    attach();
  });

  afterEach(() => {
    runtime.dispose();
    store.dispose();
    vi.useRealTimers();
  });

  // ── Adoption ──────────────────────────────────────────────────

  describe('upsertSession: adoption', () => {
    it('creates a hooks-only external agent and announces it in order', () => {
      sink.upsertSession(session('s1'));

      expect(sent.map((m) => m.type)).toEqual(['agentCreated', 'agentDetails', 'agentStatus']);
      const id = agentIdOf('s1');
      expect(sent[0]).toMatchObject({
        type: 'agentCreated',
        id,
        providerId: 'conductor',
        label: 'Session s1',
        directoryName: 'fern',
        isExternal: true,
        hooksOnly: true,
        species: 172,
        level: 1,
      });
      expect(sent[0].isTeammate).toBeUndefined();
      expect(sent[1]).toMatchObject({
        type: 'agentDetails',
        id,
        providerId: 'conductor',
        label: 'Session s1',
        conductorSessionId: 's1',
        conductorWorkspaceId: 'w-s1',
        conductorWorkspaceName: 'Workspace',
        conductorWorkspaceNumber: 12,
        externalUrl: 'conductor://workspace?id=w-s1&session=s1',
        repo: 'hue-run/fern',
        species: 172,
        level: 1,
      });
      expect(sent[2]).toEqual({ type: 'agentStatus', id, status: 'waiting', silent: true });

      const agent = store.get(id)!;
      expect(agent).toMatchObject({
        sessionId: 'conductor:s1',
        isExternal: true,
        hooksOnly: true,
        hookDelivered: true,
        jsonlFile: '',
        projectDir: '',
        providerId: 'conductor',
        isWaiting: true,
      });
      expect(agent.teamName).toBeUndefined();
      expect(species.assignSpeciesIfNeeded).toHaveBeenCalledWith(agent, store, {
        stableKey: 's1',
      });
    });

    it('registers the namespaced session key, so no Claude session id resolves to it', () => {
      const register = vi.spyOn(runtime, 'registerAgent');
      sink.upsertSession(session('s1'));
      expect(register).toHaveBeenCalledWith('conductor:s1', agentIdOf('s1'));
    });

    it('seeds active and error states silently', () => {
      sink.upsertSession(session('busy', { initialStatus: 'active' }));
      sink.upsertSession(
        session('broken', { initialStatus: 'error', errorMessage: 'x'.repeat(500) }),
      );

      expect(ofType('agentStatus')).toEqual([
        { type: 'agentStatus', id: agentIdOf('busy'), status: 'active', silent: true },
        {
          type: 'agentStatus',
          id: agentIdOf('broken'),
          status: 'error',
          errorMessage: expect.any(String),
          silent: true,
        },
      ]);
      const broken = store.get(agentIdOf('broken'))!;
      expect(broken.isErrored).toBe(true);
      expect(broken.errorMessage!.length).toBe(AGENT_ERROR_MESSAGE_MAX_LENGTH);
      expect(store.get(agentIdOf('busy'))!.isWaiting).toBe(false);
    });

    it('reuses the remembered agent id and Pokémon, and keeps reserved ids from new agents', () => {
      runtime.dispose();
      store = new AgentStateStore();
      sent = [];
      store.on('agentAdded', (id, agent) => sent.push({ ...agentCreatedMessage(id, agent) }));
      runtime = new AgentRuntime(store, claudeProvider);
      memory.records.set('conductor:old', {
        agentId: 7,
        pokemonLine: 'charmander',
        species: 4,
        shiny: true,
      });
      attach();

      // Attaching reserved 7: the next new agent of any kind starts at 8.
      expect(store.nextAgentId.current).toBe(8);
      sink.upsertSession(session('old'));
      sink.upsertSession(session('new'));

      expect(agentIdOf('old')).toBe(7);
      expect(agentIdOf('new')).toBe(8);
      expect(sent[0]).toMatchObject({ id: 7, shiny: true });
      expect(store.get(7)!.pokemonLine).toBe('charmander');
      expect(memory.records.get('conductor:new')).toEqual({
        agentId: 8,
        pokemonLine: 'pichu',
        species: 172,
        shiny: undefined,
      });
    });

    it('takes a fresh id when the remembered one is occupied', () => {
      runtime.dispose();
      store.set(
        3,
        createAgentState({
          id: 3,
          sessionId: 'claude',
          isExternal: false,
          projectDir: '',
          jsonlFile: '',
        }),
      );
      memory.records.set('conductor:s1', { agentId: 3 });
      runtime = new AgentRuntime(store, claudeProvider);
      attach();

      sink.upsertSession(session('s1'));
      expect(agentIdOf('s1')).not.toBe(3);
      expect(memory.records.get('conductor:s1')!.agentId).toBe(agentIdOf('s1'));
    });
  });

  describe('upsertSession: updates', () => {
    it('re-broadcasts agentDetails only when something changed', () => {
      sink.upsertSession(session('s1'));
      const id = agentIdOf('s1');
      sent = [];

      sink.upsertSession(session('s1'));
      expect(sent).toEqual([]);

      sink.upsertSession({ sessionId: 's1', label: 'Renamed' });
      expect(sent).toEqual([
        expect.objectContaining({ type: 'agentDetails', id, label: 'Renamed' }),
      ]);
      // Absent fields are unknown, not cleared.
      expect(sent[0]).toMatchObject({ repo: 'hue-run/fern', conductorWorkspaceNumber: 12 });
    });

    it('recomputes the level when the message count changes', () => {
      sink.upsertSession(session('s1'));
      sent = [];

      sink.upsertSession({ sessionId: 's1', details: { messageCount: 40 } });
      expect(species.updateLevel).toHaveBeenLastCalledWith(expect.anything(), {
        messageCount: 40,
        toolCalls: 0,
      });
      // 1 + 40/10 = Lv 5: past the evolution level.
      expect(sent).toEqual([
        expect.objectContaining({ type: 'agentDetails', messageCount: 40, level: 5, species: 25 }),
      ]);
      expect(memory.records.get('conductor:s1')!.species).toBe(25);
    });
  });

  // ── Events ────────────────────────────────────────────────────

  describe('emit', () => {
    let id: number;

    /** What the event did, minus the level-up details (pinned separately). */
    function activity(): Message[] {
      return sent.filter((m) => m.type !== 'agentDetails');
    }

    beforeEach(() => {
      sink.upsertSession(session('s1'));
      id = agentIdOf('s1');
      sent = [];
    });

    it('turnStart clears activity and goes active once', () => {
      sink.emit('s1', { kind: 'turnStart' });
      expect(sent).toEqual([
        { type: 'agentToolsClear', id },
        { type: 'agentStatus', id, status: 'active' },
      ]);
      sent = [];
      sink.emit('s1', { kind: 'turnStart' });
      expect(sent).toEqual([]);
    });

    it('a tool start makes a waiting agent active, then shows the tool', () => {
      sink.emit('s1', {
        kind: 'toolStart',
        toolId: 't1',
        toolName: 'Read',
        input: { file_path: 'a.ts' },
      });
      expect(activity()).toEqual([
        { type: 'agentStatus', id, status: 'active' },
        {
          type: 'agentToolStart',
          id,
          toolId: 't1',
          status: 'Read a.ts',
          toolName: 'Read',
          runInBackground: undefined,
        },
      ]);
      expect(store.get(id)!.toolCallCount).toBe(1);
    });

    it('ignores a repeated tool start and an unknown tool end', () => {
      sink.emit('s1', { kind: 'toolStart', toolId: 't1', toolName: 'Bash' });
      sent = [];
      sink.emit('s1', { kind: 'toolStart', toolId: 't1', toolName: 'Bash' });
      sink.emit('s1', { kind: 'toolEnd', toolId: 'nope' });
      vi.advanceTimersByTime(TOOL_DONE_DELAY_MS);
      expect(sent).toEqual([]);
      expect(store.get(id)!.toolCallCount).toBe(1);
    });

    it('delays agentToolDone by TOOL_DONE_DELAY_MS', () => {
      sink.emit('s1', { kind: 'toolStart', toolId: 't1', toolName: 'Bash' });
      sent = [];
      sink.emit('s1', { kind: 'toolEnd', toolId: 't1' });
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(TOOL_DONE_DELAY_MS);
      expect(sent).toEqual([{ type: 'agentToolDone', id, toolId: 't1' }]);
      expect(store.get(id)!.activeToolIds.size).toBe(0);
    });

    it('drives sub-agents: background spawn, sub-tools, and the clear on spawn end', () => {
      sink.emit('s1', {
        kind: 'toolStart',
        toolId: 'spawn',
        toolName: 'Agent',
        runInBackground: true,
      });
      sink.emit('s1', {
        kind: 'subagentStart',
        parentToolId: 'spawn',
        toolId: 'sub1',
        toolName: 'Bash',
      });
      sink.emit('s1', { kind: 'subagentEnd', parentToolId: 'spawn', toolId: 'sub1' });
      vi.advanceTimersByTime(TOOL_DONE_DELAY_MS);
      sink.emit('s1', { kind: 'toolEnd', toolId: 'spawn' });

      sent = activity();
      expect(sent.map((m) => m.type)).toEqual([
        'agentStatus',
        'agentToolStart',
        'subagentToolStart',
        'subagentToolDone',
        'subagentClear',
      ]);
      expect(sent[1]).toMatchObject({ toolId: 'spawn', runInBackground: true });
      expect(sent[2]).toEqual({
        type: 'subagentToolStart',
        id,
        parentToolId: 'spawn',
        toolId: 'sub1',
        status: 'Using Bash',
      });
      expect(sent[4]).toEqual({ type: 'subagentClear', id, parentToolId: 'spawn' });
      expect(store.get(id)!.backgroundAgentToolIds.size).toBe(0);
      expect(store.get(id)!.toolCallCount).toBe(2);
    });

    it('permission request and clear are deduped', () => {
      sink.emit('s1', { kind: 'subagentStart', parentToolId: 'p', toolId: 'x', toolName: 'Bash' });
      sent = [];
      sink.emit('s1', { kind: 'permissionRequest' });
      sink.emit('s1', { kind: 'permissionRequest' });
      sink.emit('s1', { kind: 'permissionClear' });
      sink.emit('s1', { kind: 'permissionClear' });
      expect(sent).toEqual([
        { type: 'agentToolPermission', id },
        { type: 'subagentToolPermission', id, parentToolId: 'p' },
        { type: 'agentToolPermissionClear', id },
      ]);
    });

    it('awaitingInput waits for the user without clearing open tools', () => {
      sink.emit('s1', { kind: 'toolStart', toolId: 'ask', toolName: 'AskUserQuestion' });
      sent = [];
      sink.emit('s1', { kind: 'awaitingInput' });
      sink.emit('s1', { kind: 'awaitingInput' });
      expect(sent).toEqual([{ type: 'agentStatus', id, status: 'waiting', awaitingInput: true }]);
      expect(store.get(id)!.activeToolIds.has('ask')).toBe(true);
    });

    it('turnEnd marks the agent waiting once, keeping background tools', () => {
      sink.emit('s1', { kind: 'turnStart' });
      sink.emit('s1', { kind: 'toolStart', toolId: 'fg', toolName: 'Bash' });
      sink.emit('s1', {
        kind: 'toolStart',
        toolId: 'bg',
        toolName: 'Agent',
        runInBackground: true,
      });
      sent = [];

      sink.emit('s1', { kind: 'turnEnd' });
      expect(sent).toEqual([
        { type: 'agentToolsClear', id },
        {
          type: 'agentToolStart',
          id,
          toolId: 'bg',
          status: 'Using Agent',
          toolName: 'Agent',
          runInBackground: true,
          isTeammateSpawn: undefined,
        },
        { type: 'agentStatus', id, status: 'waiting', awaitingInput: false },
      ]);
      expect([...store.get(id)!.activeToolIds]).toEqual(['bg']);

      sent = [];
      sink.emit('s1', { kind: 'turnEnd', outcome: 'aborted' });
      expect(sent).toEqual([]);
    });

    it('an errored turn faints the agent until the next turn starts', () => {
      sink.emit('s1', { kind: 'turnStart' });
      sent = [];
      sink.emit('s1', { kind: 'turnEnd', outcome: 'error', errorMessage: 'e'.repeat(300) });
      const errorMessage = `${'e'.repeat(AGENT_ERROR_MESSAGE_MAX_LENGTH - 1)}…`;
      expect(sent).toEqual([
        { type: 'agentToolsClear', id },
        { type: 'agentStatus', id, status: 'error', errorMessage },
      ]);
      expect(store.get(id)).toMatchObject({ isErrored: true, errorMessage, isWaiting: true });

      sent = [];
      sink.emit('s1', { kind: 'turnEnd', outcome: 'error', errorMessage: 'e'.repeat(300) });
      expect(sent).toEqual([]);

      sink.emit('s1', { kind: 'turnStart' });
      expect(sent).toContainEqual({ type: 'agentStatus', id, status: 'active' });
      expect(store.get(id)!.isErrored).toBeUndefined();
    });

    it('contextUsage uses the provider window for the model, and skips repeats', () => {
      sink.emit('s1', { kind: 'contextUsage', tokens: 50_000, model: 'gpt-5.5' });
      sink.emit('s1', { kind: 'contextUsage', tokens: 50_000, model: 'gpt-5.5' });
      sink.emit('s1', { kind: 'contextUsage', tokens: 0 });
      sink.emit('s1', { kind: 'contextUsage', tokens: 60_000, window: 1_000_000 });
      expect(sent).toEqual([
        { type: 'agentContextUsage', id, contextTokens: 50_000, maxContextTokens: 272_000 },
        { type: 'agentContextUsage', id, contextTokens: 60_000, maxContextTokens: 1_000_000 },
      ]);
    });

    it('notice becomes agentNotice', () => {
      sink.emit('s1', { kind: 'notice', text: '  Retrying\n after a 529 ', tone: 'error' });
      expect(sent).toEqual([
        { type: 'agentNotice', id, text: 'Retrying after a 529', at: Date.now(), tone: 'error' },
      ]);
    });

    it('ignores events for sessions that are not in the office', () => {
      sink.emit('ghost', { kind: 'turnStart' });
      expect(sent).toEqual([]);
    });

    it('levels up from tool calls and re-broadcasts the details', () => {
      sink.emit('s1', { kind: 'toolStart', toolId: 'a', toolName: 'Bash' });
      sink.emit('s1', { kind: 'toolStart', toolId: 'b', toolName: 'Bash' });
      expect(ofType('agentDetails').map((m) => [m.level, m.species])).toEqual([
        [2, 172],
        [3, 25],
      ]);
    });

    it('sessionEnd removes the agent', () => {
      sink.emit('s1', { kind: 'sessionEnd' });
      expect(sent).toContainEqual({ type: 'agentClosed', id });
      expect(store.has(id)).toBe(false);
      expect(runtime.streamDriver('conductor')!.agentIdFor('s1')).toBeUndefined();
    });
  });

  // ── Links ─────────────────────────────────────────────────────

  describe('links', () => {
    beforeEach(() => {
      sink.upsertSession(session('a'));
      sink.upsertSession(session('b'));
      vi.advanceTimersByTime(STREAM_SNAPSHOT_DEBOUNCE_MS);
      sent = [];
    });

    it('broadcasts one debounced snapshot of links between agents in the office', () => {
      const at = Date.now();
      sink.link({ fromSessionId: 'a', toSessionId: 'b', kind: 'messaged', at, live: false });
      sink.link({
        fromSessionId: 'a',
        toSessionId: 'b',
        kind: 'messaged',
        at: at + 1,
        preview: 'Run   the\ntests',
        live: false,
      });
      sink.link({
        fromSessionId: 'a',
        toSessionId: 'elsewhere',
        kind: 'messaged',
        at,
        live: false,
      });
      expect(ofType('agentLinks')).toEqual([]);

      vi.advanceTimersByTime(STREAM_SNAPSHOT_DEBOUNCE_MS);
      expect(ofType('agentLinks')).toEqual([
        {
          type: 'agentLinks',
          links: [
            {
              fromId: agentIdOf('a'),
              toId: agentIdOf('b'),
              kind: 'messaged',
              count: 2,
              lastAt: at + 1,
              preview: 'Run the tests',
            },
          ],
        },
      ]);
      expect(ofType('agentMessage')).toEqual([]);

      // The far end arrives: the kept link resolves.
      sent = [];
      sink.upsertSession(session('elsewhere'));
      vi.advanceTimersByTime(STREAM_SNAPSHOT_DEBOUNCE_MS);
      expect((ofType('agentLinks')[0].links as unknown[]).length).toBe(2);
    });

    it('animates live messages at most once per pair per interval', () => {
      const live = (preview: string) =>
        sink.link({
          fromSessionId: 'a',
          toSessionId: 'b',
          kind: 'messaged',
          at: Date.now(),
          preview,
          live: true,
        });
      live('first');
      live('second');
      expect(ofType('agentMessage')).toEqual([
        {
          type: 'agentMessage',
          fromId: agentIdOf('a'),
          toId: agentIdOf('b'),
          kind: 'messaged',
          preview: 'first',
          at: Date.now(),
        },
      ]);
      vi.advanceTimersByTime(AGENT_MESSAGE_PAIR_INTERVAL_MS);
      live('third');
      expect(ofType('agentMessage').map((m) => m.preview)).toEqual(['first', 'third']);
    });

    it('caps live message animations per second across the office', () => {
      const ids = Array.from({ length: AGENT_MESSAGE_MAX_PER_SECOND + 2 }, (_, i) => `peer${i}`);
      for (const peer of ids) sink.upsertSession(session(peer));
      sent = [];
      for (const peer of ids) {
        sink.link({ fromSessionId: 'a', toSessionId: peer, kind: 'messaged', at: 1, live: true });
      }
      expect(ofType('agentMessage')).toHaveLength(AGENT_MESSAGE_MAX_PER_SECOND);
    });
  });

  // ── Teams ─────────────────────────────────────────────────────

  describe('teams from spawned links', () => {
    it('makes the spawner a Lead (legendary) and the spawned session its child', () => {
      sink.upsertSession(session('lead'));
      sink.upsertSession(session('child'));
      const leadId = agentIdOf('lead');
      const childId = agentIdOf('child');
      sent = [];

      sink.link({
        fromSessionId: 'lead',
        toSessionId: 'child',
        kind: 'spawned',
        at: 1,
        live: false,
      });

      expect(ofType('agentTeamInfo')).toEqual([
        {
          type: 'agentTeamInfo',
          id: leadId,
          agentName: undefined,
          isTeamLead: true,
          leadAgentId: undefined,
          teamUsesTmux: undefined,
        },
        {
          type: 'agentTeamInfo',
          id: childId,
          agentName: 'Session child',
          isTeamLead: undefined,
          leadAgentId: leadId,
          teamUsesTmux: true,
        },
      ]);
      expect(species.promoteToOrchestrator).toHaveBeenCalledWith(store.get(leadId), store);
      expect(ofType('agentDetails')).toEqual([
        expect.objectContaining({ id: leadId, species: 150 }),
      ]);
      expect(store.get(childId)!.teamName).toBeUndefined();
      expect(store.get(leadId)!.teamName).toBeUndefined();
    });

    it('announces a child adopted after its Lead as a teammate from the start', () => {
      sink.upsertSession(session('lead'));
      sent = [];
      sink.upsertSession(session('child', { leadSessionId: 'lead' }));

      expect(ofType('agentCreated')[0]).toMatchObject({
        isTeammate: true,
        parentAgentId: agentIdOf('lead'),
        teammateName: 'Session child',
      });
    });

    it('adopts a Lead whose children are already here as a legendary', () => {
      sink.upsertSession(session('child', { leadSessionId: 'lead' }));
      sent = [];
      sink.upsertSession(session('lead'));
      expect(ofType('agentCreated')[0]).toMatchObject({ id: agentIdOf('lead'), species: 150 });
      expect(ofType('agentTeamInfo')).toContainEqual(
        expect.objectContaining({ id: agentIdOf('child'), leadAgentId: agentIdOf('lead') }),
      );
    });

    it('releases children when the Lead leaves and re-links them when it returns', () => {
      sink.upsertSession(session('lead'));
      sink.upsertSession(session('child', { leadSessionId: 'lead' }));
      const childId = agentIdOf('child');
      sent = [];

      sink.removeSession('lead', 'out of scope');
      expect(store.get(childId)!.leadAgentId).toBeUndefined();
      expect(ofType('agentTeamInfo')).toEqual([
        {
          type: 'agentTeamInfo',
          id: childId,
          agentName: undefined,
          isTeamLead: undefined,
          leadAgentId: undefined,
          teamUsesTmux: undefined,
        },
      ]);

      sent = [];
      sink.upsertSession(session('lead'));
      expect(store.get(childId)!.leadAgentId).toBe(agentIdOf('lead'));
      expect(ofType('agentTeamInfo')).toContainEqual(
        expect.objectContaining({
          id: childId,
          leadAgentId: agentIdOf('lead'),
          teamUsesTmux: true,
        }),
      );
    });

    it('dismissing a Lead hides only the Lead: its children stay', () => {
      sink.upsertSession(session('lead'));
      sink.upsertSession(session('child', { leadSessionId: 'lead' }));
      const leadId = agentIdOf('lead');
      const childId = agentIdOf('child');

      runtime.closeAgent(leadId);

      expect(provider.onDismiss).toHaveBeenCalledWith('lead');
      expect(store.has(leadId)).toBe(false);
      expect(store.has(childId)).toBe(true);
      expect(store.get(childId)!.leadAgentId).toBeUndefined();
    });
  });

  // ── Provider status and the session list ──────────────────────

  describe('status, sessions and replay', () => {
    const scope = { creator: 'me' as const, activeWithinHours: 6, showIdle: true, maxSessions: 24 };

    it('broadcasts conductorStatus on change only', () => {
      sink.setStatus({ state: 'connecting', scope });
      sink.setStatus({ state: 'connecting', scope });
      sink.setStatus({ state: 'connected', scope, sessionCount: 3 });
      expect(ofType('conductorStatus')).toEqual([
        { type: 'conductorStatus', state: 'connecting', scope },
        { type: 'conductorStatus', state: 'connected', scope, sessionCount: 3 },
      ]);
    });

    it('fills agent ids into the session list from who is in the office', () => {
      const summary = (sessionId: string): ConductorSessionSummary => ({
        sessionId,
        label: sessionId,
        workspaceId: 'w',
        workspaceName: 'W',
        status: 'idle',
        hidden: false,
        agentId: 999, // the provider's guess is never trusted
      });
      sink.upsertSession(session('in'));
      sink.sessionsChanged([summary('in'), summary('out')]);

      expect(ofType('conductorSessions')).toEqual([
        {
          type: 'conductorSessions',
          sessions: [
            { ...summary('in'), agentId: agentIdOf('in') },
            {
              sessionId: 'out',
              label: 'out',
              workspaceId: 'w',
              workspaceName: 'W',
              status: 'idle',
              hidden: false,
            },
          ],
        },
      ]);

      // Adoption changes the ids: the list follows, debounced.
      sent = [];
      sink.upsertSession(session('out'));
      vi.advanceTimersByTime(STREAM_SNAPSHOT_DEBOUNCE_MS);
      expect(ofType('conductorSessions')[0].sessions).toContainEqual(
        expect.objectContaining({ sessionId: 'out', agentId: agentIdOf('out') }),
      );
    });

    it('replays cached state to a connecting client', () => {
      sink.setStatus({ state: 'connected', scope });
      sink.upsertSession(session('a'));
      sink.upsertSession(session('b'));
      sink.sessionsChanged([]);
      sink.link({ fromSessionId: 'a', toSessionId: 'b', kind: 'watched', at: 5, live: false });
      sink.emit('b', { kind: 'awaitingInput' });
      sink.emit('a', { kind: 'permissionRequest' });

      const replay: Message[] = [];
      runtime.streamDriver('conductor')!.replayTo((m) => replay.push(m));
      expect(replay).toEqual([
        { type: 'conductorStatus', state: 'connected', scope },
        { type: 'conductorSessions', sessions: [] },
        {
          type: 'agentLinks',
          links: [
            {
              fromId: agentIdOf('a'),
              toId: agentIdOf('b'),
              kind: 'watched',
              count: 1,
              lastAt: 5,
              preview: undefined,
            },
          ],
        },
        { type: 'agentToolPermission', id: agentIdOf('a') },
        {
          type: 'agentStatus',
          id: agentIdOf('b'),
          status: 'waiting',
          awaitingInput: true,
          silent: true,
        },
      ]);
    });

    it('stops broadcasting after dispose', () => {
      sink.upsertSession(session('a'));
      sink.emit('a', { kind: 'toolStart', toolId: 't', toolName: 'Bash' });
      sink.emit('a', { kind: 'toolEnd', toolId: 't' });
      runtime.dispose();
      sent = [];
      vi.advanceTimersByTime(STREAM_SNAPSHOT_DEBOUNCE_MS + TOOL_DONE_DELAY_MS);
      sink.upsertSession(session('late'));
      expect(sent).toEqual([]);
    });

    it('survives a provider that throws from onDismiss', () => {
      provider.onDismiss = () => {
        throw new Error('boom');
      };
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      sink.upsertSession(session('a'));
      runtime.closeAgent(agentIdOf('a'));
      expect(store.size).toBe(0);
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });
  });
});

// ── Runtime guards for hooks-only agents ────────────────────────

describe('runtime guards for hooks-only agents', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the stale check keeps a hooks-only agent while Claude hooks are off', () => {
    vi.useFakeTimers();
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeProvider);
    runtime.hooksEnabled.current = false;
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 'conductor:s1',
        isExternal: true,
        projectDir: '',
        jsonlFile: '',
        hooksOnly: true,
        hookDelivered: true,
      }),
    );
    // Control: an external agent whose transcript is gone IS stale.
    store.set(
      2,
      createAgentState({
        id: 2,
        sessionId: 'gone',
        isExternal: true,
        projectDir: '/nowhere',
        jsonlFile: '/nowhere/gone.jsonl',
      }),
    );

    runtime.startStaleCheck();
    vi.advanceTimersByTime(EXTERNAL_STALE_CHECK_INTERVAL_MS);

    expect(store.has(1)).toBe(true);
    expect(store.has(2)).toBe(false);
    runtime.dispose();
  });

  it('heuristic waiting and permission timers never start for hooks-only agents', () => {
    vi.useFakeTimers();
    const store = new AgentStateStore();
    const sent: Message[] = [];
    store.on('broadcast', (m) => sent.push(m));
    const agent = createAgentState({
      id: 1,
      sessionId: 'conductor:s1',
      isExternal: true,
      projectDir: '',
      jsonlFile: '',
      hooksOnly: true,
    });
    agent.activeToolIds.add('t');
    agent.activeToolNames.set('t', 'Bash');
    store.set(1, agent);
    const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

    startWaitingTimer(1, 10, store, waitingTimers);
    startPermissionTimer(1, store, permissionTimers, new Set());
    vi.advanceTimersByTime(60_000);

    expect(waitingTimers.size).toBe(0);
    expect(permissionTimers.size).toBe(0);
    expect(sent).toEqual([]);
  });
});
