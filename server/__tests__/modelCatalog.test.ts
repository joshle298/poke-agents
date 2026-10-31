import { describe, expect, it } from 'vitest';

import { CONTINUE_SESSION_NAME_MAX_LENGTH, SESSION_MESSAGE_MAX_LENGTH } from '../src/constants.js';
import {
  buildModelCatalog,
  catalogAgents,
  continuationName,
  mergeFavorites,
  modelLabel,
  parseModelChoice,
} from '../src/providers/stream/modelCatalog.js';

const agents = catalogAgents();
const catalog = buildModelCatalog(undefined);

function choice(patch: Record<string, unknown> = {}) {
  return parseModelChoice(
    { agent: 'codex', model: 'gpt-5.5', message: 'Continue the work.', ...patch },
    catalog,
  );
}

describe('model catalog: the maintained table', () => {
  it('groups the models by agent: Claude, Codex, Cursor, each id under one agent', () => {
    expect(agents.map((a) => [a.agent, a.label])).toEqual([
      ['claude', 'Claude'],
      ['codex', 'Codex'],
      ['cursor', 'Cursor'],
    ]);
    const ids = agents.flatMap((a) => a.models.map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(agents[0].models.map((m) => m.id)).toContain('opus-5-5-1m');
    expect(agents[1].models.map((m) => m.id)).toContain('gpt-6.1-sol');
    expect(agents[2].models.map((m) => m.id)).toEqual([
      'auto',
      'composer-2.5',
      'grok-4.7',
      'grok-4.6',
      'grok-4.5',
    ]);
  });

  it('states each agent’s efforts, default and fast-mode models consistently', () => {
    for (const agent of agents) {
      const ids = new Set(agent.models.map((m) => m.id));
      for (const fast of agent.fastModeModels) expect(ids.has(fast)).toBe(true);
      if (agent.defaultEffort) expect(agent.efforts).toContain(agent.defaultEffort);
      for (const model of agent.models) expect(model.label.length).toBeGreaterThan(0);
    }
    const [claude, codex, cursor] = agents;
    expect(claude.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
    expect(claude.defaultEffort).toBe('high');
    expect(claude.fastModeModels).toContain('opus-4-7');
    expect(claude.fastModeModels).not.toContain('sonnet-4-6');
    expect(codex.efforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(codex.fastModeModels).toHaveLength(codex.models.length);
    expect(cursor.efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(cursor.defaultEffort).toBeUndefined();
  });

  it('marks the efforts Conductor takes only from models that support them', () => {
    const [claude, codex, cursor] = agents;
    expect(claude.limitedEfforts).toEqual(['ultracode']);
    expect(codex.limitedEfforts).toEqual(['max', 'ultra']);
    expect(cursor.limitedEfforts).toBeUndefined();
    for (const agent of agents) {
      for (const effort of agent.limitedEfforts ?? []) expect(agent.efforts).toContain(effort);
    }
  });

  it('hands out copies, so a caller cannot change the table', () => {
    const first = catalogAgents();
    first[0].models.push({ id: 'made-up', label: 'Made up' });
    first[0].efforts.length = 0;
    expect(catalogAgents()[0].models.some((m) => m.id === 'made-up')).toBe(false);
    expect(catalogAgents()[0].efforts.length).toBeGreaterThan(0);
  });

  it('labels the ids it knows', () => {
    expect(modelLabel('opus-5-5-1m')).toBe('Opus 5.5 (1M)');
    expect(modelLabel('gpt-5.3-codex-spark')).toBe('GPT-5.3 Codex Spark');
    expect(modelLabel('not-a-model')).toBeUndefined();
  });
});

describe('model catalog: favorites', () => {
  it('keeps the favorites the catalog accepts, in Conductor’s order', () => {
    const favorites = mergeFavorites(
      {
        favoriteModels: [
          { agent: 'codex', model: 'gpt-5.5', effort: 'medium', fastMode: true },
          { agent: 'acp', model: 'some-acp-model', acpAgentId: 'x' },
          { agent: 'claude', model: 'claude-made-up' },
          { agent: 'claude', model: 'opus-5-5-1m', effort: 'ultracode', fastMode: false },
          { agent: 'cursor', model: 'grok-4.7', effort: 'xhigh' },
        ],
      },
      agents,
    );
    expect(favorites).toEqual([
      { agent: 'codex', model: 'gpt-5.5', effort: 'medium', fastMode: true },
      { agent: 'claude', model: 'opus-5-5-1m', effort: 'ultracode' },
      { agent: 'cursor', model: 'grok-4.7', effort: 'xhigh' },
    ]);
  });

  it('drops an effort the agent does not take and fast mode the model lacks; collapses repeats', () => {
    const favorites = mergeFavorites(
      [
        { agent: 'cursor', model: 'auto', effort: 'ultra' },
        { agent: 'claude', model: 'sonnet-4-6', fastMode: true },
        { agent: 'claude', model: 'sonnet-4-6' },
        'junk',
        null,
        { agent: 'claude' },
      ],
      agents,
    );
    expect(favorites).toEqual([
      { agent: 'cursor', model: 'auto' },
      { agent: 'claude', model: 'sonnet-4-6' },
    ]);
  });

  it('reads nothing from a malformed response', () => {
    expect(mergeFavorites(undefined, agents)).toEqual([]);
    expect(mergeFavorites({ favoriteModels: 'x' }, agents)).toEqual([]);
    expect(mergeFavorites(42, agents)).toEqual([]);
  });

  it('defaults the picker to the first favorite’s agent', () => {
    const built = buildModelCatalog({
      favoriteModels: [{ agent: 'cursor', model: 'composer-2.5' }],
    });
    expect(built.defaultAgent).toBe('cursor');
    expect(built.favorites).toEqual([{ agent: 'cursor', model: 'composer-2.5' }]);
    expect(built.agents).toEqual(agents);
    expect(buildModelCatalog({ favoriteModels: [] }).defaultAgent).toBeUndefined();
  });
});

describe('model catalog: validating a continueWithModel request', () => {
  it('accepts a model of the agent, with an effort it takes and fast mode it supports', () => {
    expect(choice({ effort: 'xhigh', fastMode: true, message: '  Go on.  ' })).toEqual({
      ok: true,
      choice: {
        agent: 'codex',
        model: 'gpt-5.5',
        effort: 'xhigh',
        fastMode: true,
        message: 'Go on.',
      },
    });
    // fastMode false is the same as leaving it out.
    expect(choice({ fastMode: false })).toEqual({
      ok: true,
      choice: { agent: 'codex', model: 'gpt-5.5', message: 'Continue the work.' },
    });
  });

  it('refuses an unknown agent, another agent’s model, or a made-up model', () => {
    expect(choice({ agent: 'acp' })).toEqual({
      ok: false,
      message: 'Choose Claude, Codex or Cursor.',
    });
    expect(choice({ agent: 'claude', model: 'gpt-5.5' })).toEqual({
      ok: false,
      message: "Claude doesn't offer that model.",
    });
    expect(choice({ model: 'gpt-99' })).toEqual({
      ok: false,
      message: "Codex doesn't offer that model.",
    });
    expect(choice({ agent: 7 })).toEqual({ ok: false, message: 'Invalid request.' });
    expect(choice({ model: 'x'.repeat(65) })).toEqual({ ok: false, message: 'Invalid request.' });
  });

  it('refuses an effort the agent does not take', () => {
    expect(choice({ agent: 'cursor', model: 'auto', effort: 'max' })).toEqual({
      ok: false,
      message: "Cursor doesn't accept that effort.",
    });
    expect(choice({ effort: 3 })).toEqual({
      ok: false,
      message: "Codex doesn't accept that effort.",
    });
  });

  it('refuses fast mode on a model without it, and a non-boolean flag', () => {
    expect(choice({ agent: 'claude', model: 'sonnet-4-6', fastMode: true })).toEqual({
      ok: false,
      message: 'Sonnet 4.6 has no fast mode.',
    });
    expect(choice({ fastMode: 'yes' })).toEqual({ ok: false, message: 'Invalid request.' });
  });

  it('needs a message within the length limit', () => {
    expect(choice({ message: '   ' })).toEqual({ ok: false, message: 'Type a message first.' });
    expect(choice({ message: undefined })).toEqual({ ok: false, message: 'Invalid request.' });
    expect(choice({ message: 'x'.repeat(SESSION_MESSAGE_MAX_LENGTH + 1) })).toEqual({
      ok: false,
      message: 'Message is too long.',
    });
  });
});

describe('model catalog: the continuation’s name', () => {
  it('is "<original name> · <model label>"', () => {
    expect(continuationName('Fix flaky tests', 'gpt-5.5')).toBe('Fix flaky tests · GPT-5.5');
    expect(continuationName('  Fix   flaky tests ', 'opus-5-5-1m')).toBe(
      'Fix flaky tests · Opus 5.5 (1M)',
    );
  });

  it('replaces the model suffix of an earlier continuation instead of stacking', () => {
    expect(continuationName('Fix flaky tests · GPT-5.5', 'grok-4.7')).toBe(
      'Fix flaky tests · Grok 4.7',
    );
  });

  it('falls back to "Session", and cuts a long name before the model', () => {
    expect(continuationName(undefined, 'auto')).toBe('Session · Auto');
    const long = continuationName('word '.repeat(60), 'gpt-6.1-sol');
    expect(long.length).toBeLessThanOrEqual(CONTINUE_SESSION_NAME_MAX_LENGTH);
    expect(long.endsWith('… · GPT-6.1 Sol')).toBe(true);
  });
});
