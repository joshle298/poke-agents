/**
 * With --claude, Claude Code agents are Pokémon too, and level up from the
 * tool calls their transcripts (or, for hooks-only agents, their hooks)
 * report: 1 + floor(sqrt(toolCallCount)). The count survives a restart.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { countToolCall, setEvolutionPreloader } from '../src/pokemon/agentLevel.js';
import { assignSpeciesIfNeeded } from '../src/pokemon/speciesAssigner.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { SessionRouter } from '../src/sessionRouter.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';
import type { AgentState, PersistedAgent } from '../src/types.js';

type Message = Record<string, unknown>;

function toolUse(toolId: string) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'ls' } }],
    },
  });
}

function claudeAgent(id: number, store: AgentStateStore, extra: Partial<AgentState> = {}) {
  const agent = createAgentState({
    id,
    sessionId: `claude-${id}`,
    isExternal: true,
    projectDir: '/work',
    jsonlFile: '/work/session.jsonl',
    ...extra,
  });
  assignSpeciesIfNeeded(agent, store);
  store.set(id, agent);
  return agent;
}

describe('Claude agent levels', () => {
  let store: AgentStateStore;
  let sent: Message[];
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  beforeEach(() => {
    setHookProvider(claudeProvider);
    setEvolutionPreloader(null);
    store = new AgentStateStore();
    sent = [];
    store.on('broadcast', (m: Message) => sent.push(m));
  });

  afterEach(() => setEvolutionPreloader(null));

  it('counts each tool call in the transcript once and announces the level', () => {
    const agent = claudeAgent(1, store);
    expect(agent.level).toBe(1);
    processTranscriptLine(1, toolUse('t1'), store, timers, timers);
    expect(agent.toolCallCount).toBe(1);
    expect(sent.filter((m) => m.type === 'agentDetails')).toEqual([
      expect.objectContaining({ id: 1, level: 2, species: agent.species }),
    ]);

    // The same tool seen again (hooks plus the transcript) is not a new call.
    processTranscriptLine(1, toolUse('t1'), store, timers, timers);
    for (const id of ['t2', 't3', 't4'])
      processTranscriptLine(1, toolUse(id), store, timers, timers);
    expect(agent.toolCallCount).toBe(4);
    expect(agent.level).toBe(3);
    expect(sent.filter((m) => m.type === 'agentDetails').at(-1)).toMatchObject({ level: 3 });
  });

  it('counts hook tool calls for an agent with no transcript', () => {
    const agent = claudeAgent(2, store, { jsonlFile: '', hooksOnly: true, hookDelivered: true });
    const handler = new HookEventHandler(
      store,
      timers,
      timers,
      claudeProvider,
      new SessionRouter(),
    );
    handler.registerAgent('claude-2', 2);
    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'claude-2',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    expect(agent.toolCallCount).toBe(1);
    expect(agent.level).toBe(2);
  });

  it('holds an evolution until its sprites are ready when the host preloads them', async () => {
    const agent = claudeAgent(3, store, { toolCallCount: 224, pokemonLine: 'charmander' });
    const before = agent.species;
    expect(before).toBe(4);
    let release: (ready: boolean) => void = () => {};
    const preload = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    setEvolutionPreloader(preload);
    // The 225th call: Lv 16, the next stage.
    countToolCall(3, agent, store);
    expect(agent.level).toBe(16);
    expect(agent.species).toBe(5);
    expect(preload).toHaveBeenCalledWith(agent.species, agent.shiny === true);
    expect(sent.filter((m) => m.type === 'agentDetails')).toEqual([]);
    release(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.filter((m) => m.type === 'agentDetails')).toEqual([
      expect.objectContaining({ id: 3, level: 16, species: agent.species }),
    ]);
  });
});

describe('Claude agent levels across a restart', () => {
  let tmpDir: string;
  let runtime: AgentRuntime | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-claude-level-'));
  });
  afterEach(() => {
    runtime?.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists the tool-call count and restores the agent at its level', () => {
    const jsonlFile = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(jsonlFile, '');
    let saved: PersistedAgent[] = [];
    const adapter: StateAdapter = {
      loadAgents: () => saved,
      saveAgents: (agents) => {
        saved = agents as PersistedAgent[];
      },
      loadSeats: () => ({}),
      saveSeats: () => {},
      getSetting: <T>(_key: string, fallback: T) => fallback,
      setSetting: () => {},
    };
    const before = new AgentStateStore();
    before.setAdapter(adapter);
    claudeAgent(5, before, { jsonlFile, projectDir: tmpDir, toolCallCount: 9 });
    before.persist();
    expect(saved[0]).toMatchObject({ id: 5, toolCallCount: 9 });

    const after = new AgentStateStore();
    after.setAdapter(adapter);
    runtime = new AgentRuntime(after, claudeProvider);
    runtime.restoreExternalAgents();
    expect(after.get(5)).toMatchObject({ toolCallCount: 9, level: 4 });
  });
});
