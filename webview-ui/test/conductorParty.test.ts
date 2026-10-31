import { describe, expect, it } from 'vitest';

import type { ConductorAgent } from '../src/conductor/conductorStore.js';
import {
  agentCondition,
  agentMsUntilAsleep,
  buildPartySlot,
  conditionBadge,
  hpFraction,
  hpTone,
  needsAttention,
  partyOrder,
  pcBoxPortraitUrl,
  pcBoxSpecies,
  pickPortrait,
  portraitEmotion,
} from '../src/conductor/party.js';
import { PARTY_MAX_NEST_DEPTH, SLEEP_AFTER_MS } from '../src/constants.js';

function agent(patch: Partial<ConductorAgent> = {}): ConductorAgent {
  return { id: 1, awaitingInput: false, permission: false, tools: [], ...patch };
}

describe('partyOrder', () => {
  const order = (ids: number[], leads: Record<number, number>) =>
    partyOrder(ids, (id) => leads[id]).map((e) => [e.id, e.depth]);

  it('puts Leads first, each followed by its children, then everyone else', () => {
    // 4 and 5 are children of 3; 6 is a child of 1.
    expect(order([1, 2, 3, 4, 5, 6], { 4: 3, 5: 3, 6: 1 })).toEqual([
      [1, 0],
      [6, 1],
      [3, 0],
      [4, 1],
      [5, 1],
      [2, 0],
    ]);
  });

  it('nests grandchildren and caps the indent depth', () => {
    const ids = [1, 2, 3, 4];
    const result = order(ids, { 2: 1, 3: 2, 4: 3 });
    expect(result.map(([id]) => id)).toEqual([1, 2, 3, 4]);
    expect(result.map(([, depth]) => depth)).toEqual([0, 1, 2, PARTY_MAX_NEST_DEPTH]);
  });

  it('shows a child whose Lead is not in the office at the top level', () => {
    expect(order([7, 8], { 8: 99 })).toEqual([
      [7, 0],
      [8, 0],
    ]);
  });

  it('keeps every agent of a lead cycle', () => {
    const result = order([1, 2, 3], { 1: 2, 2: 1 });
    expect(result.map(([id]) => id).sort()).toEqual([1, 2, 3]);
  });

  it('ignores an agent naming itself as its Lead', () => {
    expect(order([1], { 1: 1 })).toEqual([[1, 0]]);
  });
});

describe('agentCondition', () => {
  const now = 10_000_000;

  it('is null before any activity', () => {
    expect(agentCondition(undefined, now)).toBeNull();
    expect(agentCondition(agent(), now)).toBeNull();
  });

  it('ranks error, then needs-you, then working', () => {
    expect(agentCondition(agent({ status: 'error', permission: true }), now)).toBe('error');
    expect(agentCondition(agent({ status: 'active', permission: true }), now)).toBe('needsYou');
    expect(agentCondition(agent({ status: 'waiting', awaitingInput: true }), now)).toBe('needsYou');
    expect(agentCondition(agent({ status: 'active' }), now)).toBe('working');
    expect(
      agentCondition(agent({ tools: [{ toolId: 't', status: 'Running', done: false }] }), now),
    ).toBe('working');
  });

  it('falls asleep once done for SLEEP_AFTER_MS', () => {
    const justDone = agent({ status: 'waiting', lastActiveAt: now - 1_000 });
    expect(agentCondition(justDone, now)).toBe('done');
    const longDone = agent({ status: 'waiting', lastActiveAt: now - SLEEP_AFTER_MS });
    expect(agentCondition(longDone, now)).toBe('asleep');
    // The provider's newer activity keeps it awake.
    const providerActive = agent({
      status: 'waiting',
      lastActiveAt: now - SLEEP_AFTER_MS * 2,
      lastActivityAt: now - 1_000,
    });
    expect(agentCondition(providerActive, now)).toBe('done');
    // No timing known: done, not asleep.
    expect(agentCondition(agent({ status: 'waiting' }), now)).toBe('done');
    // Nothing but when this client first saw it (a hook agent after a reload).
    const seenLongAgo = agent({ status: 'waiting', seenAt: now - SLEEP_AFTER_MS });
    expect(agentCondition(seenLongAgo, now)).toBe('asleep');
    // Any real activity time wins over when it was seen.
    const seenButActive = agent({
      status: 'waiting',
      seenAt: now - SLEEP_AFTER_MS,
      lastActivityAt: now - 1_000,
    });
    expect(agentCondition(seenButActive, now)).toBe('done');
    // A background tool still open: working, never asleep.
    const openTool = agent({
      status: 'waiting',
      lastActiveAt: now - SLEEP_AFTER_MS,
      tools: [{ toolId: 'bg', status: 'Subtask: watch', done: false }],
    });
    expect(agentCondition(openTool, now)).toBe('working');
    expect(agentMsUntilAsleep(openTool, now)).toBeNull();
  });

  it('blinks only for needs-you', () => {
    expect(needsAttention('needsYou')).toBe(true);
    expect(needsAttention('error')).toBe(false);
    expect(needsAttention(null)).toBe(false);
  });
});

describe('portraits and badges', () => {
  it('maps conditions to PMD emotions', () => {
    expect(portraitEmotion('working')).toBe('Determined');
    expect(portraitEmotion('needsYou')).toBe('Worried');
    expect(portraitEmotion('done')).toBe('Happy');
    expect(portraitEmotion('error')).toBe('Pain');
    expect(portraitEmotion('asleep')).toBe('Sigh');
    expect(portraitEmotion(null)).toBe('Normal');
  });

  it('falls back to Normal, then any portrait', () => {
    expect(pickPortrait({ Normal: 'n', Pain: 'p' }, 'Pain')).toBe('p');
    expect(pickPortrait({ Normal: 'n' }, 'Pain')).toBe('n');
    expect(pickPortrait({ Happy: 'h' }, 'Pain')).toBe('h');
    expect(pickPortrait(undefined, 'Pain')).toBeUndefined();
    expect(pickPortrait({}, 'Pain')).toBeUndefined();
  });

  it('shows SLP, FNT and ! status badges', () => {
    expect(conditionBadge('asleep')).toBe('SLP');
    expect(conditionBadge('error')).toBe('FNT');
    expect(conditionBadge('needsYou')).toBe('!');
    expect(conditionBadge('working')).toBeNull();
  });
});

describe('HP', () => {
  it('is context left, hidden until usage is known', () => {
    expect(hpFraction(agent())).toBeNull();
    expect(hpFraction(agent({ contextTokens: 50, maxContextTokens: 0 }))).toBeNull();
    expect(hpFraction(agent({ contextTokens: 50_000, maxContextTokens: 200_000 }))).toBe(0.75);
    expect(hpFraction(agent({ contextTokens: 300, maxContextTokens: 200 }))).toBe(0);
  });

  it('is green above half, yellow from a fifth, red below', () => {
    expect(hpTone(0.51)).toBe('high');
    expect(hpTone(0.5)).toBe('mid');
    expect(hpTone(0.2)).toBe('mid');
    expect(hpTone(0.19)).toBe('low');
  });
});

describe('buildPartySlot', () => {
  it('collects nickname, species, level, HP and the condition portrait', () => {
    const state = {
      agents: {
        3: agent({
          id: 3,
          providerId: 'conductor',
          label: 'Fix login',
          species: 4,
          level: 12,
          status: 'error',
          contextTokens: 100,
          maxContextTokens: 400,
        }),
      },
      species: {
        '4:0': {
          type: 'pokemonSpeciesLoaded' as const,
          dex: 4,
          shiny: false,
          name: 'Charmander',
          shadowSize: 1,
          anims: {},
          portraits: { Normal: '/n.png', Pain: '/pain.png' },
          credits: { sprite: [], portrait: [], pageUrl: '' },
        },
      },
    };
    expect(buildPartySlot(state, 3, 1, 0)).toEqual({
      nickname: 'Fix login',
      speciesName: 'Charmander',
      level: 12,
      hp: 0.75,
      portraitUrl: '/pain.png',
      condition: 'error',
      depth: 1,
      isStream: true,
    });
  });

  it('falls back to "Agent N" with no portrait for an unknown agent', () => {
    expect(buildPartySlot({ agents: {}, species: {} }, 9, 0, 0)).toMatchObject({
      nickname: 'Agent 9',
      portraitUrl: undefined,
      hp: null,
      condition: null,
      isStream: false,
    });
  });
});

describe('PC Box portraits', () => {
  const loaded = {
    species: {
      '25:0': {
        type: 'pokemonSpeciesLoaded' as const,
        dex: 25,
        shiny: false,
        name: 'Sparky',
        shadowSize: 1,
        anims: {},
        portraits: { Normal: '/api/pokemon/0025/portrait/Normal.png?v=loaded' },
        credits: { sprite: [], portrait: [], pageUrl: '' },
      },
    },
  };

  it("takes the summary's species first, so a reload still knows the Pokémon", () => {
    const remembered = { 'sess-a': { species: 7, shiny: false } };
    expect(pcBoxSpecies({ sessionId: 'sess-a', species: 4, shiny: true }, remembered)).toEqual({
      species: 4,
      shiny: true,
    });
    expect(pcBoxSpecies({ sessionId: 'sess-a' }, remembered)).toEqual({
      species: 7,
      shiny: false,
    });
    expect(pcBoxSpecies({ sessionId: 'sess-b' }, remembered)).toBeUndefined();
  });

  it("uses a loaded species' own portrait", () => {
    expect(pcBoxPortraitUrl({ species: 25, shiny: false }, loaded, true)).toBe(
      '/api/pokemon/0025/portrait/Normal.png?v=loaded',
    );
  });

  it("asks the server's portrait route for a species nobody in the office uses", () => {
    expect(pcBoxPortraitUrl({ species: 4, shiny: false }, loaded, true)).toBe(
      '/api/pokemon/0004/portrait/Normal.png',
    );
    // A shiny shows the base form's portrait.
    expect(pcBoxPortraitUrl({ species: 133, shiny: true }, loaded, true)).toBe(
      '/api/pokemon/0133/portrait/Normal.png',
    );
  });

  it('falls back to the orb without the route, a species or a valid dex', () => {
    expect(pcBoxPortraitUrl({ species: 4, shiny: false }, loaded, false)).toBeUndefined();
    expect(pcBoxPortraitUrl(undefined, loaded, true)).toBeUndefined();
    expect(pcBoxPortraitUrl({ species: 0, shiny: false }, loaded, true)).toBeUndefined();
    expect(pcBoxPortraitUrl({ species: 1026, shiny: false }, loaded, true)).toBeUndefined();
    expect(pcBoxPortraitUrl({ species: 2.5, shiny: false }, loaded, true)).toBeUndefined();
  });
});
