/**
 * Change Pokémon: the assigner's choice rules, and setAgentPokemon through the
 * client message handler for a stream (Conductor) agent and a `--claude`
 * agent: validation, the read-only refusal, the species loading before
 * agentDetails, persistence across a restart, evolution within the chosen
 * line, and the reset to automatic.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StreamProvider } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type ClientMessageContext, handleClientMessage } from '../src/clientMessageHandler.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { setEvolutionPreloader } from '../src/pokemon/agentLevel.js';
import {
  assignSpeciesIfNeeded,
  choiceRefusal,
  choosePokemon,
  pokemonPickerCatalog,
  promoteToOrchestrator,
  restoredPokemonFields,
  updateLevel,
} from '../src/pokemon/speciesAssigner.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

// Species loads: resolve at once unless a test holds them, to pin that
// agentDetails waits for the new species.
let holdSpeciesLoad: Promise<boolean> | null = null;
vi.mock(import('../src/pokemon/pokemonAssets.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  ensureSpeciesLoaded: vi.fn(() => holdSpeciesLoad ?? Promise.resolve(false)),
}));

type Message = Record<string, unknown>;

const CHARMANDER = 4;
const CHARMELEON = 5;
const CHARIZARD = 6;
const MAGIKARP = 129;
const MEWTWO = 150;

/** Messages that make a Claude-harness session this level (1 + floor(sqrt(n / 4))). */
const MESSAGES_FOR = { lv1: 0, lv20: 4 * 19 ** 2, lv40: 4 * 39 ** 2 } as const;

function agent(patch: Partial<AgentState> = {}): AgentState {
  return createAgentState({
    id: 1,
    sessionId: 'conductor:s1',
    providerId: 'conductor',
    isExternal: true,
    projectDir: '',
    jsonlFile: '',
    details: { harness: 'claude', messageCount: MESSAGES_FOR.lv20 },
    ...patch,
  });
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('species assigner: the user’s choice', () => {
  it('shows a chosen line at the stage the level reaches, and marks it chosen', () => {
    const store = new AgentStateStore();
    const a = agent();
    assignSpeciesIfNeeded(a, store, { stableKey: 's1' });
    expect(a.level).toBe(20);
    expect(choosePokemon(a, store, { line: 'charmander', shiny: true })).toBe(true);
    expect(a).toMatchObject({
      pokemonLine: 'charmander',
      species: CHARMELEON,
      shiny: true,
      pokemonChosen: true,
    });
    // The same request again changes nothing.
    expect(choosePokemon(a, store, { line: 'charmander', shiny: true })).toBe(false);
  });

  it('keeps evolving within the chosen line as the level rises', () => {
    const store = new AgentStateStore();
    const a = agent({ details: { harness: 'claude', messageCount: MESSAGES_FOR.lv1 } });
    assignSpeciesIfNeeded(a, store, { stableKey: 's1' });
    choosePokemon(a, store, { line: 'charmander' });
    expect(a.species).toBe(CHARMANDER);
    expect(updateLevel(a, { messageCount: MESSAGES_FOR.lv20 })).toEqual({
      levelChanged: true,
      speciesChanged: true,
    });
    expect(a.species).toBe(CHARMELEON);
    updateLevel(a, { messageCount: MESSAGES_FOR.lv40 });
    expect(a.species).toBe(CHARIZARD);
    expect(a.pokemonLine).toBe('charmander');
  });

  it('stops a chosen line before its large stage', () => {
    const store = new AgentStateStore();
    const a = agent({ details: { harness: 'claude', messageCount: MESSAGES_FOR.lv40 } });
    assignSpeciesIfNeeded(a, store, { stableKey: 's1' });
    choosePokemon(a, store, { line: 'magikarp' });
    expect(a.species).toBe(MAGIKARP);
  });

  it('changes only the shiny flag when no line is given', () => {
    const store = new AgentStateStore();
    const a = agent();
    assignSpeciesIfNeeded(a, store, { stableKey: 's1' });
    const { pokemonLine, species } = a;
    expect(choosePokemon(a, store, { shiny: true })).toBe(true);
    expect(a).toMatchObject({ pokemonLine, species, shiny: true, pokemonChosen: true });
  });

  it('resets to automatic, and a reset of an automatic Pokémon does nothing', () => {
    const store = new AgentStateStore();
    const a = agent();
    assignSpeciesIfNeeded(a, store, { stableKey: 's1' });
    const automatic = { pokemonLine: a.pokemonLine, species: a.species, shiny: a.shiny };
    expect(choosePokemon(a, store, { line: null })).toBe(false);
    choosePokemon(a, store, {
      line: automatic.pokemonLine === 'charmander' ? 'bulbasaur' : 'charmander',
      shiny: true,
    });
    expect(choosePokemon(a, store, { line: null })).toBe(true);
    expect(a.pokemonChosen).toBeUndefined();
    // Alone in the office, the automatic pick is the same as before.
    expect({ pokemonLine: a.pokemonLine, species: a.species, shiny: a.shiny }).toEqual(automatic);
  });

  it('gives back the automatic Pokémon the first choice replaced, not a new pick', () => {
    const store = new AgentStateStore();
    const a = agent();
    assignSpeciesIfNeeded(a, store, { stableKey: 's1' });
    store.set(1, a);
    const automatic = { pokemonLine: a.pokemonLine, species: a.species, shiny: a.shiny };
    const first = automatic.pokemonLine === 'charmander' ? 'bulbasaur' : 'charmander';
    choosePokemon(a, store, { line: first, shiny: true }, { stableKey: 's1' });
    choosePokemon(a, store, { line: 'squirtle' }, { stableKey: 's1' });
    expect(a).toMatchObject({ pokemonAutoLine: automatic.pokemonLine, pokemonAutoShiny: false });
    // Meanwhile another agent took the automatic line: a fresh least-used
    // pick would land elsewhere.
    const other = agent({ id: 2, sessionId: 'conductor:s2' });
    other.pokemonLine = automatic.pokemonLine;
    other.shiny = false;
    store.set(2, other);
    expect(choosePokemon(a, store, { line: null }, { stableKey: 's1' })).toBe(true);
    expect({ pokemonLine: a.pokemonLine, species: a.species, shiny: a.shiny }).toEqual(automatic);
    expect(a.pokemonChosen).toBeUndefined();
    expect(a.pokemonAutoLine).toBeUndefined();
    expect(a.pokemonAutoShiny).toBeUndefined();
  });

  it('gives back the automatic Pokémon after a shiny-only choice, at the stage the level reaches now', () => {
    const store = new AgentStateStore();
    const a = agent({ details: { harness: 'claude', messageCount: MESSAGES_FOR.lv1 } });
    assignSpeciesIfNeeded(a, store, { stableKey: 's1' });
    const line = a.pokemonLine;
    choosePokemon(a, store, { shiny: true }, { stableKey: 's1' });
    expect(a).toMatchObject({ pokemonLine: line, shiny: true, pokemonChosen: true });
    choosePokemon(a, store, { line: 'charmander' }, { stableKey: 's1' });
    expect(a.species).toBe(CHARMANDER);
    // It grew while it was a Charmander; the automatic line comes back at Lv 40.
    a.details = { harness: 'claude', messageCount: MESSAGES_FOR.lv40 };
    updateLevel(a);
    choosePokemon(a, store, { line: null }, { stableKey: 's1' });
    expect(a).toMatchObject({ pokemonLine: line, shiny: false, level: 40 });
    expect(a.species).not.toBe(CHARIZARD);
  });

  it('resets a delegating Lead to its legendary', () => {
    const store = new AgentStateStore();
    const a = agent();
    assignSpeciesIfNeeded(a, store, { stableKey: 's1' });
    choosePokemon(a, store, { line: 'charmander' });
    choosePokemon(a, store, { line: null }, { stableKey: 's1', orchestrator: true });
    const legendaries = pokemonPickerCatalog().legendaries;
    expect(legendaries.map((l) => l.dex)).toContain(a.species);
    expect(legendaries.map((l) => l.id)).toContain(a.pokemonLine);
    expect(a.pokemonChosen).toBeUndefined();
  });

  it('never lets Lead promotion replace a chosen Pokémon, and keeps a chosen legendary', () => {
    const store = new AgentStateStore();
    const a = agent();
    assignSpeciesIfNeeded(a, store, { stableKey: 's1' });
    choosePokemon(a, store, { line: 'charmander' });
    expect(promoteToOrchestrator(a, store)).toBe(false);
    expect(a.species).toBe(CHARMELEON);
    choosePokemon(a, store, { line: 'mewtwo' });
    expect(a.species).toBe(MEWTWO);
    expect(updateLevel(a, { messageCount: MESSAGES_FOR.lv40 }).speciesChanged).toBe(false);
  });

  it('allows a line for anyone and a legendary for a Lead only', () => {
    expect(choiceRefusal('charmander', { lead: false })).toBeNull();
    expect(choiceRefusal('mewtwo', { lead: true })).toBeNull();
    expect(choiceRefusal('mewtwo', { lead: false })).toBe('Only a Lead can be a legendary.');
    // Large legendaries are never offered; unknown ids neither.
    expect(choiceRefusal('lugia', { lead: true })).toBe('Unknown Pokémon.');
    expect(choiceRefusal('missingno', { lead: true })).toBe('Unknown Pokémon.');
  });

  it('offers the lines without their large stages and the Lead legendaries', () => {
    const catalog = pokemonPickerCatalog();
    const magikarp = catalog.lines.find((l) => l.id === 'magikarp');
    expect(magikarp?.members).toEqual([{ dex: MAGIKARP, name: 'Magikarp', stage: 1 }]);
    expect(catalog.lines.find((l) => l.id === 'charmander')?.members.map((m) => m.stage)).toEqual([
      1, 2, 3,
    ]);
    expect(catalog.legendaries.map((l) => l.id)).toContain('mewtwo');
    expect(catalog.legendaries.map((l) => l.id)).not.toContain('lugia');
  });

  it('restores a choice only with a line the catalog still has', () => {
    expect(
      restoredPokemonFields({
        pokemonLine: 'charmander',
        species: 5,
        shiny: true,
        pokemonChosen: true,
      }),
    ).toEqual({ pokemonLine: 'charmander', species: 5, shiny: true, pokemonChosen: true });
    expect(
      restoredPokemonFields({
        pokemonLine: 'charmander',
        pokemonChosen: true,
        pokemonAutoLine: 'pikachu',
        pokemonAutoShiny: true,
      }),
    ).toMatchObject({ pokemonChosen: true, pokemonAutoLine: 'pikachu', pokemonAutoShiny: true });
    // The automatic line goes with the choice, and only when it still exists.
    expect(
      restoredPokemonFields({
        pokemonLine: 'charmander',
        pokemonChosen: true,
        pokemonAutoLine: 'x',
      }),
    ).not.toHaveProperty('pokemonAutoLine');
    expect(
      restoredPokemonFields({ pokemonLine: 'charmander', pokemonAutoLine: 'pikachu' }),
    ).not.toHaveProperty('pokemonAutoLine');
    expect(restoredPokemonFields({ pokemonLine: 'gone', pokemonChosen: true })).toEqual({});
    expect(restoredPokemonFields({ pokemonLine: 'charmander', pokemonChosen: 'yes' })).toEqual({
      pokemonLine: 'charmander',
      species: undefined,
      shiny: undefined,
    });
  });
});

function fakeConductor(): StreamProvider {
  return {
    kind: 'stream',
    id: 'conductor',
    displayName: 'Conductor',
    protocolVersion: 1,
    formatToolStatus: (toolName: string) => `Using ${toolName}`,
    permissionExemptTools: new Set<string>(),
    subagentToolNames: new Set(['Task', 'Agent']),
    readingTools: new Set(['Read']),
    start: async () => {},
    stop: async () => {},
  };
}

describe('setAgentPokemon', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let sent: Message[];
  let broadcasts: Message[];

  function boot(): void {
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    store.on('broadcast', (m) => broadcasts.push(m));
    runtime = new AgentRuntime(store, claudeProvider);
  }

  function attach() {
    return runtime.attachStreamProvider(fakeConductor(), {
      memory: store.getAdapter() as FileStateAdapter,
    });
  }

  function shutdown(): void {
    runtime.dispose();
    store.dispose();
  }

  function ctx(privileged = true): ClientMessageContext {
    return { store, runtime, cache: null, privileged };
  }

  function send(msg: Message, privileged = true): void {
    handleClientMessage(msg, (m) => sent.push(m), ctx(privileged));
  }

  function results(): Message[] {
    return sent.filter((m) => m.type === 'conductorActionResult');
  }

  function details(id: number): Message[] {
    return broadcasts.filter((m) => m.type === 'agentDetails' && m.id === id);
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-pokemon-choice-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    sent = [];
    broadcasts = [];
    holdSpeciesLoad = null;
    boot();
  });

  afterEach(() => {
    shutdown();
    setEvolutionPreloader(null);
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function adopt(sink: ReturnType<typeof attach>, sessionId: string, messageCount: number): number {
    sink.upsertSession({
      sessionId,
      label: sessionId,
      initialStatus: 'waiting',
      details: { harness: 'claude', messageCount },
    });
    return runtime.streamDriver('conductor')!.agentIdFor(sessionId)!;
  }

  it('refuses malformed requests, unknown lines and a legendary for a non-Lead', () => {
    const sink = attach();
    const id = adopt(sink, 's1', MESSAGES_FOR.lv20);
    send({ type: 'setAgentPokemon', id: 'x', line: 'charmander' });
    send({ type: 'setAgentPokemon', id, line: 42 });
    send({ type: 'setAgentPokemon', id });
    send({ type: 'setAgentPokemon', id, shiny: 'yes' });
    send({ type: 'setAgentPokemon', id: 999, line: 'charmander' });
    send({ type: 'setAgentPokemon', id, line: 'missingno' });
    send({ type: 'setAgentPokemon', id, line: 'mewtwo' });
    expect(results().map((r) => [r.ok, r.message])).toEqual([
      [false, 'Invalid request.'],
      [false, 'Invalid request.'],
      [false, 'Invalid request.'],
      [false, 'Invalid request.'],
      [false, 'This agent has no Pokémon.'],
      [false, 'Unknown Pokémon.'],
      [false, 'Only a Lead can be a legendary.'],
    ]);
    expect(results().every((r) => r.action === 'setAgentPokemon')).toBe(true);
  });

  it('refuses a read-only office, and gives it an empty picker', () => {
    const sink = attach();
    const id = adopt(sink, 's1', MESSAGES_FOR.lv20);
    const before = store.get(id)!.species;
    send({ type: 'setAgentPokemon', id, line: 'charmander' }, false);
    send({ type: 'requestPokemonCatalog' }, false);
    expect(results()).toEqual([
      {
        type: 'conductorActionResult',
        action: 'setAgentPokemon',
        id,
        ok: false,
        message: 'Read-only office: open the tokened URL to make changes.',
      },
    ]);
    expect(sent.find((m) => m.type === 'pokemonCatalog')).toEqual({
      type: 'pokemonCatalog',
      lines: [],
      legendaries: [],
    });
    expect(store.get(id)!.species).toBe(before);
  });

  it('serves the picker’s catalog to a privileged office', () => {
    send({ type: 'requestPokemonCatalog' });
    const catalog = sent.find((m) => m.type === 'pokemonCatalog') as {
      lines: Array<{ id: string }>;
      legendaries: Array<{ id: string }>;
    };
    expect(catalog.lines.length).toBeGreaterThan(20);
    expect(catalog.legendaries.map((l) => l.id)).toContain('mewtwo');
  });

  it('changes a stream agent once its species loads, remembers it, and keeps it across a restart', async () => {
    let sink = attach();
    const id = adopt(sink, 's1', MESSAGES_FOR.lv20);
    let release: (ready: boolean) => void = () => {};
    holdSpeciesLoad = new Promise((resolve) => (release = resolve));
    broadcasts = [];

    send({ type: 'setAgentPokemon', id, line: 'charmander', shiny: true });
    expect(results().at(-1)).toMatchObject({ action: 'setAgentPokemon', id, ok: true });
    // agentDetails waits for the new species' sprites.
    expect(details(id)).toEqual([]);
    release(true);
    await flushPromises();
    expect(details(id).at(-1)).toMatchObject({
      species: CHARMELEON,
      shiny: true,
      pokemonChosen: true,
    });
    holdSpeciesLoad = null;

    const saved = (store.getAdapter() as FileStateAdapter).loadStreamAgents().get('conductor:s1');
    expect(saved).toMatchObject({
      pokemonLine: 'charmander',
      species: CHARMELEON,
      shiny: true,
      pokemonChosen: true,
    });

    // Restart: a new office comes back with the choice, and evolution stays
    // in the chosen line.
    shutdown();
    boot();
    sink = attach();
    const again = adopt(sink, 's1', MESSAGES_FOR.lv40);
    expect(store.get(again)).toMatchObject({
      pokemonLine: 'charmander',
      species: CHARIZARD,
      shiny: true,
      pokemonChosen: true,
    });

    // Delegating no longer turns it into a legendary.
    sink.link({ fromSessionId: 's1', toSessionId: 's2', kind: 'spawned', at: 1, live: false });
    adopt(sink, 's2', MESSAGES_FOR.lv1);
    expect(store.get(again)!.isTeamLead).toBe(true);
    expect(store.get(again)!.species).toBe(CHARIZARD);

    // A Lead may pick a legendary.
    send({ type: 'setAgentPokemon', id: again, line: 'mewtwo' });
    await flushPromises();
    expect(store.get(again)).toMatchObject({ species: MEWTWO, pokemonChosen: true });
  });

  it('resets a stream agent to the automatic Pokémon it had, across a restart, and forgets the choice', async () => {
    let sink = attach();
    const id = adopt(sink, 's1', MESSAGES_FOR.lv1);
    const automatic = { line: store.get(id)!.pokemonLine, species: store.get(id)!.species };
    send({
      type: 'setAgentPokemon',
      id,
      line: automatic.species === CHARMANDER ? 'bulbasaur' : 'charmander',
    });
    await flushPromises();
    let saved = (store.getAdapter() as FileStateAdapter).loadStreamAgents().get('conductor:s1');
    expect(saved).toMatchObject({ pokemonChosen: true, pokemonAutoLine: automatic.line });

    // Restart, then another session takes the automatic line before the reset.
    shutdown();
    boot();
    sink = attach();
    const again = adopt(sink, 's1', MESSAGES_FOR.lv1);
    const other = adopt(sink, 's2', MESSAGES_FOR.lv1);
    store.get(other)!.pokemonLine = automatic.line;
    send({ type: 'setAgentPokemon', id: again, line: null });
    await flushPromises();
    expect(results().every((r) => r.ok)).toBe(true);
    expect(store.get(again)).toMatchObject({
      pokemonLine: automatic.line,
      species: automatic.species,
      pokemonChosen: undefined,
    });
    expect(details(again).at(-1)).toMatchObject({
      species: automatic.species,
      pokemonChosen: false,
    });
    saved = (store.getAdapter() as FileStateAdapter).loadStreamAgents().get('conductor:s1');
    expect(saved?.pokemonChosen).toBeUndefined();
    expect(saved?.pokemonAutoLine).toBeUndefined();
  });

  it('changes a --claude agent through the store and persists it with the agent', async () => {
    const claude = createAgentState({
      id: 7,
      sessionId: 'claude-session',
      isExternal: true,
      projectDir: '/tmp/p',
      jsonlFile: '/tmp/p/s.jsonl',
      toolCallCount: 0,
    });
    assignSpeciesIfNeeded(claude, store);
    store.set(7, claude);
    const automaticLine = claude.pokemonLine;
    let release: (ready: boolean) => void = () => {};
    setEvolutionPreloader(() => new Promise((resolve) => (release = resolve)));
    broadcasts = [];

    send({ type: 'setAgentPokemon', id: 7, line: 'charmander' });
    expect(results().at(-1)).toMatchObject({ id: 7, ok: true });
    expect(details(7)).toEqual([]);
    release(true);
    await flushPromises();
    expect(details(7).at(-1)).toMatchObject({ species: CHARMANDER, pokemonChosen: true });

    const persisted = (store.getAdapter() as FileStateAdapter).loadAgents().find((a) => a.id === 7);
    expect(persisted).toMatchObject({
      pokemonLine: 'charmander',
      pokemonChosen: true,
      pokemonAutoLine: automaticLine,
    });
    expect(restoredPokemonFields(persisted!)).toMatchObject({
      pokemonLine: 'charmander',
      pokemonChosen: true,
      pokemonAutoLine: automaticLine,
    });
  });
});
