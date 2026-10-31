import { describe, expect, it } from 'vitest';

import type { ModelCatalog } from '../../core/src/messages.js';
import { ConductorStore } from '../src/conductor/conductorStore.js';
import {
  agentLabel,
  choiceForAgent,
  choiceFromFavorite,
  chooseModel,
  continueRequest,
  effortOptions,
  effortText,
  fastModeSupported,
  favoritesFor,
  followTarget,
  handoffMessage,
  initialChoice,
  isFavoriteChosen,
  modelName,
  sessionModelRows,
  startBlocker,
} from '../src/conductor/modelPicker.js';
import { MODEL_PICKER_MESSAGE_MAX_LENGTH } from '../src/constants.js';

/** A small synthetic catalog in the server's shape. */
const CATALOG: ModelCatalog = {
  type: 'modelCatalog',
  agents: [
    {
      agent: 'claude',
      label: 'Claude',
      models: [
        { id: 'opus-5-5-1m', label: 'Opus 5.5 (1M)' },
        { id: 'sonnet-4-6', label: 'Sonnet 4.6' },
      ],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
      defaultEffort: 'high',
      fastModeModels: ['opus-5-5-1m'],
      limitedEfforts: ['ultracode'],
    },
    {
      agent: 'codex',
      label: 'Codex',
      models: [
        { id: 'gpt-5.5', label: 'GPT-5.5' },
        { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      ],
      efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultEffort: 'high',
      fastModeModels: ['gpt-5.5', 'gpt-6.1-sol'],
      limitedEfforts: ['max', 'ultra'],
    },
    {
      agent: 'cursor',
      label: 'Cursor',
      models: [{ id: 'auto', label: 'Auto' }],
      efforts: ['low', 'medium', 'high', 'xhigh'],
      fastModeModels: ['auto'],
    },
  ],
  favorites: [
    { agent: 'codex', model: 'gpt-6.1-sol', effort: 'ultra', fastMode: true },
    { agent: 'claude', model: 'opus-5-5-1m', effort: 'ultracode' },
  ],
  defaultAgent: 'codex',
};

describe('Switch model picker rules', () => {
  it('prefills a handoff message naming the session', () => {
    expect(handoffMessage('Fix flaky tests')).toBe(
      'Continue the work from the session "Fix flaky tests" in this workspace. Check its recent commits and changes before you start.',
    );
    expect(handoffMessage('  ')).toMatch(/^Continue the work from the previous session in/);
  });

  it('names agents and models from the catalog, falling back to the ids', () => {
    expect(agentLabel(CATALOG, 'codex')).toBe('Codex');
    expect(agentLabel(null, 'cursor')).toBe('Cursor');
    expect(agentLabel(CATALOG, undefined)).toBeUndefined();
    expect(modelName(CATALOG, 'opus-5-5-1m')).toBe('Opus 5.5 (1M)');
    expect(modelName(CATALOG, 'claude-opus-5-5[1m]')).toBe('claude-opus-5-5[1m]');
    expect(effortText('medium', true)).toBe('medium · fast mode');
    expect(effortText(undefined, true)).toBe('fast mode');
    expect(effortText(undefined, false)).toBeUndefined();
  });

  it('gives the Pokédex its Agent, Model and Effort rows', () => {
    expect(
      sessionModelRows(
        { harness: 'codex', model: 'gpt-5.5', effort: 'medium', fastMode: true },
        CATALOG,
      ),
    ).toEqual({ agent: 'Codex', model: 'GPT-5.5', effort: 'medium · fast mode' });
    expect(sessionModelRows(undefined, CATALOG)).toEqual({});
  });

  it('names a Claude session’s model by its create-session id, not the resolved one', () => {
    const session = { harness: 'claude', model: 'claude-opus-5-5[1m]', modelId: 'opus-5-5-1m' };
    expect(sessionModelRows(session, CATALOG).model).toBe('Opus 5.5 (1M)');
    // Without the catalog (or an id it lists), the id the session reports.
    expect(sessionModelRows(session, null).model).toBe('claude-opus-5-5[1m]');
    expect(sessionModelRows({ modelId: 'opus-9' }, CATALOG).model).toBe('opus-9');
  });

  it('opens on the session’s own agent and model, keeping what that model takes', () => {
    expect(
      initialChoice(CATALOG, {
        harness: 'claude',
        model: 'opus-5-5-1m',
        effort: 'max',
        fastMode: true,
      }),
    ).toEqual({ agent: 'claude', model: 'opus-5-5-1m', effort: 'max', fastMode: true });
    // The resolved id with the create-session id beside it: the session's own.
    expect(
      initialChoice(CATALOG, {
        harness: 'claude',
        model: 'claude-opus-5-5[1m]',
        modelId: 'opus-5-5-1m',
        effort: 'low',
      }),
    ).toEqual({ agent: 'claude', model: 'opus-5-5-1m', effort: 'low', fastMode: false });
    // A model the catalog doesn't list: the agent's first favorite.
    expect(initialChoice(CATALOG, { harness: 'claude', model: 'claude-opus-5-5[1m]' })).toEqual({
      agent: 'claude',
      model: 'opus-5-5-1m',
      effort: 'ultracode',
      fastMode: false,
    });
    // An unknown harness: the first favorite's agent.
    expect(initialChoice(CATALOG, { harness: 'acp' })?.agent).toBe('codex');
    expect(initialChoice(null, { harness: 'claude' })).toBeNull();
    expect(initialChoice({ ...CATALOG, agents: [] }, undefined)).toBeNull();
  });

  it('switches tabs to the agent’s first favorite, else its first model', () => {
    expect(choiceForAgent(CATALOG, 'codex')).toEqual({
      agent: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'ultra',
      fastMode: true,
    });
    expect(choiceForAgent(CATALOG, 'cursor')).toEqual({
      agent: 'cursor',
      model: 'auto',
      effort: '',
      fastMode: false,
    });
  });

  it('keeps effort and fast mode on another model only where it takes them', () => {
    const fast = { agent: 'claude', model: 'opus-5-5-1m', effort: 'xhigh', fastMode: true };
    expect(chooseModel(CATALOG, fast, 'sonnet-4-6')).toEqual({
      agent: 'claude',
      model: 'sonnet-4-6',
      effort: 'xhigh',
      fastMode: false,
    });
    expect(fastModeSupported(CATALOG, 'claude', 'sonnet-4-6')).toBe(false);
    expect(fastModeSupported(CATALOG, 'cursor', 'auto')).toBe(true);
  });

  it('lists favorites per agent with a star row that is chosen only when it matches exactly', () => {
    expect(favoritesFor(CATALOG, 'claude')).toEqual([
      { agent: 'claude', model: 'opus-5-5-1m', effort: 'ultracode' },
    ]);
    expect(favoritesFor(null, 'claude')).toEqual([]);
    const favorite = CATALOG.favorites[0];
    const choice = choiceFromFavorite(CATALOG, favorite);
    expect(isFavoriteChosen(favorite, choice)).toBe(true);
    expect(isFavoriteChosen(favorite, { ...choice, effort: 'high' })).toBe(false);
    // A favorite with an effort the agent doesn't take loses it.
    expect(
      choiceFromFavorite(CATALOG, { agent: 'cursor', model: 'auto', effort: 'ultra' }),
    ).toEqual({
      agent: 'cursor',
      model: 'auto',
      effort: '',
      fastMode: false,
    });
  });

  it('offers the agent’s default effort first', () => {
    expect(effortOptions(CATALOG, 'claude')[0]).toEqual({ value: '', label: 'Default (high)' });
    expect(effortOptions(CATALOG, 'cursor').map((o) => o.value)).toEqual([
      '',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(effortOptions(CATALOG, 'cursor')[0].label).toBe('Default');
    expect(effortOptions(CATALOG, 'acp')).toEqual([]);
  });

  it('says which effort levels only some models take', () => {
    const labels = (agent: string) => effortOptions(CATALOG, agent).map((o) => o.label);
    expect(labels('claude').slice(-2)).toEqual(['max', 'ultracode (some models)']);
    expect(labels('codex').slice(-2)).toEqual(['max (some models)', 'ultra (some models)']);
    expect(effortOptions(CATALOG, 'codex').at(-1)?.value).toBe('ultra');
    expect(labels('cursor')).not.toContainEqual(expect.stringContaining('some models'));
  });

  it('says why Start is disabled', () => {
    const choice = { agent: 'codex', model: 'gpt-5.5', effort: '', fastMode: false };
    expect(startBlocker(null, null, 'go')).toBe('Loading models…');
    expect(startBlocker(CATALOG, { ...choice, model: 'opus-5-5-1m' }, 'go')).toBe(
      'Choose a model.',
    );
    expect(startBlocker(CATALOG, choice, '   ')).toBe('Write the first message.');
    expect(startBlocker(CATALOG, choice, 'x'.repeat(MODEL_PICKER_MESSAGE_MAX_LENGTH + 1))).toBe(
      'The message is too long.',
    );
    expect(startBlocker(CATALOG, choice, 'go')).toBeNull();
  });

  it('builds the request without a default effort or fast mode off', () => {
    expect(
      continueRequest(
        3,
        { agent: 'codex', model: 'gpt-5.5', effort: '', fastMode: false },
        '  Go.  ',
      ),
    ).toEqual({ id: 3, agent: 'codex', model: 'gpt-5.5', message: 'Go.' });
    expect(
      continueRequest(
        3,
        { agent: 'codex', model: 'gpt-5.5', effort: 'max', fastMode: true },
        'Go.',
      ),
    ).toEqual({
      id: 3,
      agent: 'codex',
      model: 'gpt-5.5',
      effort: 'max',
      fastMode: true,
      message: 'Go.',
    });
  });

  it('follows the new session into the office, or stops waiting', () => {
    const follow = { sessionId: 'new', at: 1_000 };
    const agents = { 4: { conductorSessionId: 'old' }, 9: { conductorSessionId: 'new' } };
    expect(followTarget(follow, agents, () => true, 2_000, 60_000)).toBe(9);
    expect(followTarget(follow, agents, (id) => id !== 9, 2_000, 60_000)).toBeNull();
    expect(followTarget(follow, {}, () => true, 61_000, 60_000)).toBe('expired');
    expect(followTarget(null, agents, () => true, 2_000, 60_000)).toBeNull();
  });
});

describe('Conductor store: Switch model and Change Pokémon', () => {
  it('keeps the catalogs, the new agent facts and the session to follow', () => {
    let now = 5_000;
    const store = new ConductorStore({ now: () => now });
    store.apply(CATALOG);
    store.apply({
      type: 'pokemonCatalog',
      lines: [{ id: 'charmander', members: [{ dex: 4, name: 'Charmander', stage: 1 }] }],
      legendaries: [],
    });
    store.apply({
      type: 'agentDetails',
      id: 2,
      providerId: 'conductor',
      label: 'Fix flaky tests',
      model: 'claude-opus-5-5[1m]',
      modelId: 'opus-5-5-1m',
      effort: 'medium',
      fastMode: true,
      species: 4,
      pokemonChosen: true,
    });
    const state = store.getState();
    expect(state.modelCatalog).toBe(CATALOG);
    expect(state.pokemonCatalog?.lines).toHaveLength(1);
    expect(state.agents[2]).toMatchObject({
      model: 'claude-opus-5-5[1m]',
      modelId: 'opus-5-5-1m',
      effort: 'medium',
      fastMode: true,
      pokemonChosen: true,
    });

    now = 6_000;
    store.apply({
      type: 'conductorActionResult',
      action: 'continueWithModel',
      id: 2,
      ok: true,
      sessionId: 'new-session',
    });
    expect(store.getState().follow).toEqual({ sessionId: 'new-session', at: 6_000 });
    expect(store.getState().actionOutcomes[2]).toMatchObject({
      action: 'continueWithModel',
      ok: true,
    });
    expect(store.getState().toasts.at(-1)?.text).toBe(
      'Started a new session to continue Fix flaky tests',
    );
    store.clearFollow();
    expect(store.getState().follow).toBeNull();

    store.apply({
      type: 'conductorActionResult',
      action: 'setAgentPokemon',
      id: 2,
      ok: false,
      message: 'Unknown Pokémon.',
    });
    expect(store.getState().toasts.at(-1)?.text).toBe(
      "Couldn't change the Pokémon: Unknown Pokémon.",
    );
    // A refused start follows nothing, and its toast says what happened.
    store.apply({
      type: 'conductorActionResult',
      action: 'continueWithModel',
      id: 2,
      ok: false,
      message: "Conductor didn't confirm the new session.",
    });
    expect(store.getState().follow).toBeNull();
    expect(store.getState().toasts.at(-1)?.text).toBe(
      "Switch model: Conductor didn't confirm the new session.",
    );
  });
});
