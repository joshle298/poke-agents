import { describe, expect, it } from 'vitest';

import type { PersistedAgent } from '../../core/src/schemas.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { assignPaletteIfNeeded } from '../src/paletteAssigner.js';
import {
  assignSpeciesIfNeeded,
  choiceRefusal,
  choosePokemon,
  fnv1a,
  levelFor,
  pokemonPickerCatalog,
  promoteToOrchestrator,
  restoredPokemonFields,
  stableKeyFor,
  stageForLevel,
  updateLevel,
} from '../src/pokemon/speciesAssigner.js';
import { POKEMON_CATALOG } from '../src/pokemon/speciesCatalog.js';
import type { AgentState } from '../src/types.js';

const PICKER_LINES = pokemonPickerCatalog().lines;
const LINE_COUNT = PICKER_LINES.length;
const LEAD_DEXES = new Set(POKEMON_CATALOG.leadDefaults);
const SIZE_BY_DEX = new Map(
  [...POKEMON_CATALOG.lines.flatMap((l) => l.members), ...POKEMON_CATALOG.legendaries].map((m) => [
    m.dex,
    m.size,
  ]),
);

function agent(id: number, extra: Partial<AgentState> = {}): AgentState {
  return createAgentState({
    id,
    sessionId: `session-${id}`,
    projectDir: '',
    jsonlFile: '',
    isExternal: true,
    ...extra,
  });
}

/** Create, assign and add `count` agents, the way every creation path does. */
function populate(store: AgentStateStore, count: number, firstId = 1): AgentState[] {
  const out: AgentState[] = [];
  for (let id = firstId; id < firstId + count; id++) {
    const a = agent(id);
    assignSpeciesIfNeeded(a, store);
    store.set(id, a);
    out.push(a);
  }
  return out;
}

function lineMembers(id: string): number[] {
  return POKEMON_CATALOG.lines.find((l) => l.id === id)!.members.map((m) => m.dex);
}

describe('fnv1a', () => {
  it('matches the reference 32-bit FNV-1a values', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });
});

describe('stableKeyFor', () => {
  it('prefers the provider session id without its namespace', () => {
    const conductor = agent(1, { sessionId: 'conductor:5f0c', providerId: 'conductor' });
    expect(stableKeyFor(conductor)).toBe('5f0c');
    expect(stableKeyFor(agent(2, { sessionId: 'claude-uuid' }))).toBe('claude-uuid');
    expect(stableKeyFor(agent(7, { sessionId: '' }))).toBe('agent:7');
    expect(stableKeyFor(conductor, 'explicit')).toBe('explicit');
  });
});

describe('assignSpeciesIfNeeded', () => {
  it('gives every agent its own line until all lines are in use', () => {
    const store = new AgentStateStore();
    const agents = populate(store, LINE_COUNT);
    const lines = new Set(agents.map((a) => a.pokemonLine));
    expect(lines.size).toBe(LINE_COUNT);
    expect(agents.every((a) => a.shiny === false)).toBe(true);
    for (const a of agents) {
      expect(lineMembers(a.pokemonLine!)).toContain(a.species);
      expect(SIZE_BY_DEX.get(a.species!)).not.toBe('large');
      expect(a.level).toBe(1);
    }
  });

  it('makes duplicates shiny once every line is in use', () => {
    const store = new AgentStateStore();
    populate(store, LINE_COUNT);
    const second = populate(store, LINE_COUNT, LINE_COUNT + 1);
    expect(second.every((a) => a.shiny === true)).toBe(true);
    expect(new Set(second.map((a) => a.pokemonLine)).size).toBe(LINE_COUNT);
    // A third round has one normal and one shiny of each line to copy: it goes normal.
    const [third] = populate(store, 1, 2 * LINE_COUNT + 1);
    expect(third.shiny).toBe(false);
  });

  it('is idempotent and deterministic for a key and an office', () => {
    const storeA = new AgentStateStore();
    const storeB = new AgentStateStore();
    populate(storeA, 3);
    populate(storeB, 3);
    const a = agent(10, { sessionId: 'same-session' });
    const b = agent(10, { sessionId: 'same-session' });
    assignSpeciesIfNeeded(a, storeA);
    assignSpeciesIfNeeded(b, storeB);
    expect([b.pokemonLine, b.species, b.shiny]).toEqual([a.pokemonLine, a.species, a.shiny]);

    const before = { ...a };
    assignSpeciesIfNeeded(a, storeA);
    expect([a.pokemonLine, a.species, a.shiny, a.level]).toEqual([
      before.pokemonLine,
      before.species,
      before.shiny,
      before.level,
    ]);
  });

  it('breaks ties by the key over catalog order', () => {
    const a = agent(1, { sessionId: 'a' });
    assignSpeciesIfNeeded(a, new AgentStateStore());
    expect(a.pokemonLine).toBe(PICKER_LINES[0xe40c292c % LINE_COUNT].id);
    // Different keys spread over the tied lines.
    const picks = new Set(
      Array.from({ length: 20 }, (_, i) => {
        const x = agent(i + 1, { sessionId: `key-${i}` });
        assignSpeciesIfNeeded(x, new AgentStateStore());
        return x.pokemonLine;
      }),
    );
    expect(picks.size).toBeGreaterThan(5);
  });

  it('keeps a restored line, species and shiny flag', () => {
    const store = new AgentStateStore();
    populate(store, 5);
    const restored = agent(
      9,
      restoredPokemonFields({ pokemonLine: 'charmander', species: 5, shiny: true }),
    );
    assignSpeciesIfNeeded(restored, store);
    expect([restored.pokemonLine, restored.species, restored.shiny]).toEqual([
      'charmander',
      5,
      true,
    ]);
  });

  it('starts at the stage its activity has already reached', () => {
    const a = agent(1, { details: { harness: 'claude', messageCount: 4900 } });
    a.pokemonLine = 'charmander';
    assignSpeciesIfNeeded(a, new AgentStateStore());
    expect(a.level).toBe(36);
    expect(a.species).toBe(6);
  });

  it('assigns a legendary when asked for an orchestrator', () => {
    const a = agent(1);
    assignSpeciesIfNeeded(a, new AgentStateStore(), { orchestrator: true });
    expect(LEAD_DEXES.has(a.species!)).toBe(true);
    expect(a.level).toBe(1);
  });

  it('runs from assignPaletteIfNeeded, even for an agent that already has a palette', () => {
    const store = new AgentStateStore();
    const fresh = agent(1);
    assignPaletteIfNeeded(fresh, store);
    expect(fresh.palette).toBeDefined();
    expect(fresh.species).toBeDefined();

    const teammate = agent(2, { palette: fresh.palette, hueShift: 0 });
    assignPaletteIfNeeded(teammate, store);
    expect(teammate.palette).toBe(fresh.palette);
    expect(teammate.species).toBeDefined();
  });
});

describe('level', () => {
  it('follows 1 + floor(sqrt(messageCount / k)) with k = 4, or 2 for Codex', () => {
    expect(levelFor({ messageCount: 0 })).toBe(1);
    expect(levelFor({ harness: 'claude', messageCount: 899 })).toBe(15);
    expect(levelFor({ harness: 'claude', messageCount: 900 })).toBe(16);
    expect(levelFor({ harness: 'cursor', messageCount: 900 })).toBe(16);
    expect(levelFor({ harness: 'something-new', messageCount: 900 })).toBe(16);
    expect(levelFor({ harness: 'codex', messageCount: 449 })).toBe(15);
    expect(levelFor({ harness: 'codex', messageCount: 450 })).toBe(16);
    expect(levelFor({ harness: 'Codex', messageCount: 2450 })).toBe(36);
  });

  it('falls back to 1 + floor(sqrt(toolCalls)) without a message count', () => {
    expect(levelFor({})).toBe(1);
    expect(levelFor({ toolCalls: 224 })).toBe(15);
    expect(levelFor({ toolCalls: 225 })).toBe(16);
    expect(levelFor({ messageCount: Number.NaN, toolCalls: 9 })).toBe(4);
    expect(levelFor({ messageCount: -5, toolCalls: 9 })).toBe(4);
  });

  it('clamps to 1..100', () => {
    expect(levelFor({ messageCount: 10_000_000 })).toBe(100);
    expect(levelFor({ toolCalls: 1e9 })).toBe(100);
  });

  it('maps levels to stages at 16 and 36', () => {
    expect([1, 15, 16, 35, 36, 100].map(stageForLevel)).toEqual([1, 1, 2, 2, 3, 3]);
  });
});

describe('updateLevel', () => {
  function charmander(extra: Partial<AgentState> = {}): AgentState {
    const a = agent(1, extra);
    a.pokemonLine = 'charmander';
    assignSpeciesIfNeeded(a, new AgentStateStore());
    return a;
  }

  it('evolves at Lv 16 and Lv 36 from the session message count', () => {
    const a = charmander({ details: { harness: 'claude', messageCount: 10 } });
    expect([a.level, a.species]).toEqual([2, 4]);

    a.details = { harness: 'claude', messageCount: 899 };
    expect(updateLevel(a)).toEqual({ levelChanged: true, speciesChanged: false });
    expect(a.species).toBe(4);

    a.details = { harness: 'claude', messageCount: 900 };
    expect(updateLevel(a)).toEqual({ levelChanged: true, speciesChanged: true });
    expect([a.level, a.species]).toEqual([16, 5]);

    expect(updateLevel(a)).toEqual({ levelChanged: false, speciesChanged: false });

    a.details = { harness: 'claude', messageCount: 4900 };
    expect(updateLevel(a)).toEqual({ levelChanged: true, speciesChanged: true });
    expect(a.species).toBe(6);
  });

  it('levels Codex sessions twice as fast per message', () => {
    const a = charmander({ details: { harness: 'codex', messageCount: 450 } });
    expect([a.level, a.species]).toEqual([16, 5]);
    const b = charmander({ details: { harness: 'claude', messageCount: 450 } });
    expect([b.level, b.species]).toEqual([11, 4]);
  });

  it('uses tool calls when there is no message count, and explicit activity first', () => {
    const a = charmander();
    a.toolCallCount = 225;
    expect(updateLevel(a)).toEqual({ levelChanged: true, speciesChanged: true });
    expect([a.level, a.species]).toEqual([16, 5]);
    updateLevel(a, { toolCalls: 1225 });
    expect([a.level, a.species]).toEqual([36, 6]);
  });

  it('never de-evolves a shown species', () => {
    const a = agent(1, restoredPokemonFields({ pokemonLine: 'charmander', species: 5 }));
    assignSpeciesIfNeeded(a, new AgentStateStore());
    expect(updateLevel(a)).toEqual({ levelChanged: false, speciesChanged: false });
    expect([a.level, a.species]).toEqual([1, 5]);
  });

  it('stops at the end of a short line', () => {
    const a = agent(1);
    a.pokemonLine = 'psyduck';
    assignSpeciesIfNeeded(a, new AgentStateStore());
    updateLevel(a, { messageCount: 1_000_000 });
    expect(a.species).toBe(55);
  });

  it('never evolves into a large species', () => {
    const magikarp = agent(1);
    magikarp.pokemonLine = 'magikarp';
    assignSpeciesIfNeeded(magikarp, new AgentStateStore());
    expect(updateLevel(magikarp, { messageCount: 1_000_000 }).speciesChanged).toBe(false);
    expect(magikarp.species).toBe(129);

    const bagon = agent(2);
    bagon.pokemonLine = 'bagon';
    assignSpeciesIfNeeded(bagon, new AgentStateStore());
    updateLevel(bagon, { messageCount: 1_000_000 });
    expect(bagon.species).toBe(372);
  });

  it('picks a branch per session where a line branches, and keeps it', () => {
    const eeveelutions = new Set([134, 135, 136, 196, 197, 470, 471, 700]);
    const picks = new Set<number>();
    for (let i = 0; i < 24; i++) {
      const a = agent(i + 1, { sessionId: `eevee-${i}` });
      a.pokemonLine = 'eevee';
      assignSpeciesIfNeeded(a, new AgentStateStore());
      expect(a.species).toBe(133);
      updateLevel(a, { messageCount: 900 });
      expect(eeveelutions.has(a.species!)).toBe(true);
      const evolved = a.species;
      updateLevel(a, { messageCount: 1_000_000 });
      expect(a.species).toBe(evolved);
      picks.add(evolved!);
    }
    expect(picks.size).toBeGreaterThan(1);

    const ralts = agent(1);
    ralts.pokemonLine = 'ralts';
    assignSpeciesIfNeeded(ralts, new AgentStateStore());
    updateLevel(ralts, { messageCount: 900 });
    expect(ralts.species).toBe(281);
    updateLevel(ralts, { messageCount: 4900 });
    expect([282, 475]).toContain(ralts.species);
  });
});

describe('promoteToOrchestrator', () => {
  it('switches to a non-large Lead legendary once', () => {
    const store = new AgentStateStore();
    const [lead] = populate(store, 1);
    expect(promoteToOrchestrator(lead, store)).toBe(true);
    expect(LEAD_DEXES.has(lead.species!)).toBe(true);
    expect(SIZE_BY_DEX.get(lead.species!)).not.toBe('large');
    expect(lead.shiny).toBe(false);
    expect(promoteToOrchestrator(lead, store)).toBe(false);
  });

  it('spreads Leads over the defaults, then repeats them shiny', () => {
    const store = new AgentStateStore();
    const agents = populate(store, LEAD_DEXES.size + 1);
    for (const a of agents) promoteToOrchestrator(a, store);
    const first = agents.slice(0, LEAD_DEXES.size);
    expect(new Set(first.map((a) => a.species))).toEqual(LEAD_DEXES);
    expect(first.every((a) => a.shiny === false)).toBe(true);
    expect(agents[LEAD_DEXES.size].shiny).toBe(true);
  });

  it('does not evolve a legendary', () => {
    const store = new AgentStateStore();
    const [lead] = populate(store, 1);
    promoteToOrchestrator(lead, store);
    const species = lead.species;
    expect(updateLevel(lead, { messageCount: 1_000_000 })).toEqual({
      levelChanged: true,
      speciesChanged: false,
    });
    expect(lead.species).toBe(species);
  });
});

describe('persistence', () => {
  it('validates persisted fields against the catalog', () => {
    expect(restoredPokemonFields({ pokemonLine: 'charmander', species: 5, shiny: true })).toEqual({
      pokemonLine: 'charmander',
      species: 5,
      shiny: true,
    });
    expect(restoredPokemonFields({ pokemonLine: 'charmander', species: 25 })).toEqual({
      pokemonLine: 'charmander',
      species: undefined,
      shiny: undefined,
    });
    expect(restoredPokemonFields({ pokemonLine: 'mewtwo', species: 4 })).toEqual({
      pokemonLine: 'mewtwo',
      species: 150,
      shiny: undefined,
    });
    expect(restoredPokemonFields({ pokemonLine: 'missingno', species: 0 })).toEqual({});
    expect(restoredPokemonFields({ pokemonLine: 'rayquaza' })).toEqual({});
    expect(restoredPokemonFields({ pokemonLine: 42, species: '5', shiny: 'yes' })).toEqual({});
    expect(restoredPokemonFields({})).toEqual({});
  });

  it('persists the line, species and shiny flag with the agent', () => {
    const saved: PersistedAgent[][] = [];
    const store = new AgentStateStore();
    store.setAdapter({
      loadAgents: () => [],
      saveAgents: (agents) => saved.push(agents),
      loadSeats: () => ({}),
      saveSeats: () => undefined,
      getSetting: <T>(_key: string, fallback: T) => fallback,
      setSetting: () => undefined,
    });
    const [a] = populate(store, 1);
    store.persist();
    expect(saved[0][0]).toMatchObject({
      pokemonLine: a.pokemonLine,
      species: a.species,
      shiny: false,
    });
  });
});

describe('expanded roster', () => {
  it('offers 915 species while excluding large species and unreachable descendants', () => {
    const picker = pokemonPickerCatalog();
    const members = picker.lines.flatMap((line) => line.members);
    expect(members.length + picker.legendaries.length).toBe(915);
    expect(picker.lines).toHaveLength(428);
    expect(picker.legendaries).toHaveLength(63);
    for (const line of picker.lines) {
      const raw = POKEMON_CATALOG.lines.find((candidate) => candidate.id === line.id)!;
      for (const member of line.members) {
        expect(SIZE_BY_DEX.get(member.dex)).not.toBe('large');
        const parent = raw.members.find((candidate) => candidate.dex === member.dex)!.evolvesFrom;
        if (parent !== undefined) expect(line.members.some((m) => m.dex === parent)).toBe(true);
      }
    }
  });

  it('keeps Wurmple on the same branch when leveling incrementally or directly', () => {
    const branches = new Set<number>();
    for (let i = 0; i < 24; i++) {
      const incremental = agent(i + 1, { sessionId: `wurmple-${i}`, pokemonLine: 'wurmple' });
      assignSpeciesIfNeeded(incremental, new AgentStateStore());
      expect(incremental.species).toBe(265);
      updateLevel(incremental, { messageCount: 900 });
      const middle = incremental.species!;
      expect([266, 268]).toContain(middle);
      branches.add(middle);
      updateLevel(incremental, { messageCount: 4900 });
      expect(incremental.species).toBe(middle === 266 ? 267 : 269);

      const direct = agent(i + 1, {
        sessionId: `wurmple-${i}`,
        pokemonLine: 'wurmple',
        details: { messageCount: 4900 },
      });
      assignSpeciesIfNeeded(direct, new AgentStateStore());
      expect(direct.species).toBe(incremental.species);
    }
    expect(branches).toEqual(new Set([266, 268]));
  });

  it.each([
    [266, 267],
    [268, 269],
  ])('restores Wurmple branch %i and evolves to %i', (species, evolved) => {
    const a = agent(1, restoredPokemonFields({ pokemonLine: 'wurmple', species }));
    assignSpeciesIfNeeded(a, new AgentStateStore());
    expect(a.species).toBe(species);
    updateLevel(a, { messageCount: 4900 });
    expect(a.species).toBe(evolved);
  });

  it('keeps both Nincada evolutions terminal', () => {
    const branches = new Set<number>();
    for (let i = 0; i < 24; i++) {
      const a = agent(i + 1, { sessionId: `nincada-${i}`, pokemonLine: 'nincada' });
      assignSpeciesIfNeeded(a, new AgentStateStore());
      updateLevel(a, { messageCount: 900 });
      expect([291, 292]).toContain(a.species);
      const evolved = a.species!;
      branches.add(evolved);
      updateLevel(a, { messageCount: 4900 });
      expect(a.species).toBe(evolved);
    }
    expect(branches).toEqual(new Set([291, 292]));
  });

  it('allows a Lead to choose and restore an additional legendary', () => {
    expect(choiceRefusal('raikou', { lead: false })).toBe('Only a Lead can be a legendary.');
    expect(choiceRefusal('raikou', { lead: true })).toBeNull();
    const store = new AgentStateStore();
    const a = agent(1);
    assignSpeciesIfNeeded(a, store, { orchestrator: true });
    expect(choosePokemon(a, store, { line: 'raikou' }, { orchestrator: true })).toBe(true);
    expect(a.species).toBe(243);
    const restored = agent(1, restoredPokemonFields(a));
    assignSpeciesIfNeeded(restored, store, { orchestrator: true });
    updateLevel(restored, { messageCount: 4900 });
    expect(restored.species).toBe(243);
  });

  it('preserves the eight automatic Lead defaults', () => {
    expect(POKEMON_CATALOG.leadDefaults).toEqual([150, 151, 145, 245, 251, 385, 491, 493]);
  });
});

describe('legacy evolution choices', () => {
  it.each([
    { line: 'eevee', expected: [196, 134, 135, 471, 700, 197, 470, 136] },
    { line: 'ralts', expected: [282, 475, 282, 475, 282, 475, 282, 475] },
  ])('preserves session branches for $line', ({ line, expected }) => {
    for (let i = 0; i < expected.length; i++) {
      const a = agent(i + 1, { sessionId: `legacy-${i}`, pokemonLine: line });
      assignSpeciesIfNeeded(a, new AgentStateStore());
      updateLevel(a, { messageCount: 4900 });
      expect(a.species).toBe(expected[i]);
    }
  });
});
