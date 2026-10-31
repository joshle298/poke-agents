/**
 * Switch model: which agents, models, effort levels and fast-mode models a
 * session can continue with, as a maintained table, plus the pure rules that
 * merge the user's favorites into it and validate a continueWithModel request.
 * Shared by the Conductor provider and the demo.
 *
 * The table mirrors Conductor's create-session contract (POST /v0/sessions in
 * https://api.conductor.build/v0/openapi.json: the `model` enum, grouped by
 * agent in the operation's description, the accepted effort levels per agent,
 * the levels that "require support from the selected model" (per-model
 * support isn't in the contract, so they're marked, not filtered), and the
 * models that accept `fastMode`). Last checked 2026-10-31. When
 * Conductor adds a model, add it here; a model missing from the table can't be
 * picked, one the API dropped is refused by Conductor with a 400 the office
 * shows. ACP agents are left out: they need an ACP agent id the create call
 * doesn't take.
 *
 * Labels are Poke Agents' own display names for the ids.
 */

import type { FavoriteModel, ModelCatalogAgent } from '../../../../core/src/messages.js';
import type { ModelChoice, StreamModelCatalog } from '../../../../core/src/provider.js';
import {
  CONTINUE_SESSION_NAME_MAX_LENGTH,
  MODEL_CHOICE_FIELD_MAX_LENGTH,
  MODEL_FAVORITES_MAX,
  SESSION_MESSAGE_MAX_LENGTH,
} from '../../constants.js';

/** One agent's row: models in Conductor's order. */
interface AgentRow {
  agent: string;
  label: string;
  models: ReadonlyArray<readonly [id: string, label: string]>;
  efforts: readonly string[];
  /** Conductor's default when no effort is sent (stated for claude and codex). */
  defaultEffort?: string;
  /** Models that accept fastMode: true. */
  fastModeModels: readonly string[];
  /** Efforts Conductor takes only from models that support them; which
   *  models do isn't in its contract, so they're offered for every model and
   *  Conductor refuses the rest (a 400 the office shows). */
  limitedEfforts?: readonly string[];
}

const CLAUDE_MODELS = [
  ['fable-5-1', 'Fable 5.1'],
  ['fable-5', 'Fable 5'],
  ['opus-5-5-1m', 'Opus 5.5 (1M)'],
  ['opus-5-1m', 'Opus 5 (1M)'],
  ['opus-4-8-1m', 'Opus 4.8 (1M)'],
  ['opus-4-8', 'Opus 4.8'],
  ['opus-4-7-1m', 'Opus 4.7 (1M)'],
  ['opus-4-7', 'Opus 4.7'],
  ['opus-4-6-1m', 'Opus 4.6 (1M)'],
  ['sonnet-5-5-1m', 'Sonnet 5.5 (1M)'],
  ['sonnet-5-1m', 'Sonnet 5 (1M)'],
  ['sonnet-4-6-1m', 'Sonnet 4.6 (1M)'],
  ['sonnet-4-6', 'Sonnet 4.6'],
  ['haiku-5-5-1m', 'Haiku 5.5 (1M)'],
  ['haiku-4-5', 'Haiku 4.5'],
] as const;

const CODEX_MODELS = [
  ['gpt-5.5', 'GPT-5.5'],
  ['gpt-5.4', 'GPT-5.4'],
  ['gpt-5.6-sol', 'GPT-5.6 Sol'],
  ['gpt-5.6-terra', 'GPT-5.6 Terra'],
  ['gpt-5.6-luna', 'GPT-5.6 Luna'],
  ['gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark'],
  ['gpt-5.3-codex', 'GPT-5.3 Codex'],
  ['gpt-5.2-codex', 'GPT-5.2 Codex'],
  ['gpt-6-astra', 'GPT-6 Astra'],
  ['gpt-6.1-sol', 'GPT-6.1 Sol'],
  ['gpt-6-sol', 'GPT-6 Sol'],
  ['gpt-6-luna', 'GPT-6 Luna'],
  ['gpt-daybreak-blue-latest', 'GPT Daybreak Blue'],
] as const;

const CURSOR_MODELS = [
  ['auto', 'Auto'],
  ['composer-2.5', 'Composer 2.5'],
  ['grok-4.7', 'Grok 4.7'],
  ['grok-4.6', 'Grok 4.6'],
  ['grok-4.5', 'Grok 4.5'],
] as const;

/** The maintained table (see the module comment for its source). */
const MODEL_TABLE: readonly AgentRow[] = [
  {
    agent: 'claude',
    label: 'Claude',
    models: CLAUDE_MODELS,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    limitedEfforts: ['ultracode'],
    defaultEffort: 'high',
    fastModeModels: [
      'opus-5-5-1m',
      'opus-5-1m',
      'opus-4-8-1m',
      'opus-4-8',
      'opus-4-7-1m',
      'opus-4-7',
      'opus-4-6-1m',
    ],
  },
  {
    agent: 'codex',
    label: 'Codex',
    models: CODEX_MODELS,
    efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    limitedEfforts: ['max', 'ultra'],
    defaultEffort: 'high',
    fastModeModels: CODEX_MODELS.map(([id]) => id),
  },
  {
    agent: 'cursor',
    label: 'Cursor',
    models: CURSOR_MODELS,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    fastModeModels: CURSOR_MODELS.map(([id]) => id),
  },
];

/** The table as the wire shape (fresh copies, safe to hand out). */
export function catalogAgents(table: readonly AgentRow[] = MODEL_TABLE): ModelCatalogAgent[] {
  return table.map((row) => {
    const agent: ModelCatalogAgent = {
      agent: row.agent,
      label: row.label,
      models: row.models.map(([id, label]) => ({ id, label })),
      efforts: [...row.efforts],
      fastModeModels: [...row.fastModeModels],
    };
    if (row.defaultEffort) agent.defaultEffort = row.defaultEffort;
    if (row.limitedEfforts?.length) agent.limitedEfforts = [...row.limitedEfforts];
    return agent;
  });
}

/**
 * The user's favorites (GET /v0/favorite-models: `{ favoriteModels: [...] }`,
 * or the bare array) that the catalog accepts, in Conductor's order. Conductor
 * says entries can name agents or models its public API doesn't take; those
 * are dropped. An effort the agent doesn't take is dropped from its entry, and
 * fast mode is kept only where the model supports it. Duplicates collapse.
 */
export function mergeFavorites(
  raw: unknown,
  agents: readonly ModelCatalogAgent[],
): FavoriteModel[] {
  const list = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === 'object' &&
        Array.isArray((raw as Record<string, unknown>).favoriteModels)
      ? ((raw as Record<string, unknown>).favoriteModels as unknown[])
      : [];
  const out: FavoriteModel[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (out.length >= MODEL_FAVORITES_MAX) break;
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const row = agents.find((a) => a.agent === e.agent);
    if (!row || typeof e.model !== 'string') continue;
    if (!row.models.some((m) => m.id === e.model)) continue;
    const favorite: FavoriteModel = { agent: row.agent, model: e.model };
    if (typeof e.effort === 'string' && row.efforts.includes(e.effort)) favorite.effort = e.effort;
    if (e.fastMode === true && row.fastModeModels.includes(e.model)) favorite.fastMode = true;
    const key = JSON.stringify([
      favorite.agent,
      favorite.model,
      favorite.effort,
      favorite.fastMode,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(favorite);
  }
  return out;
}

/** The catalog a provider serves: the table plus the favorites it accepts. */
export function buildModelCatalog(rawFavorites: unknown): StreamModelCatalog {
  const agents = catalogAgents();
  const favorites = mergeFavorites(rawFavorites, agents);
  const catalog: StreamModelCatalog = { agents, favorites };
  if (favorites[0]) catalog.defaultAgent = favorites[0].agent;
  return catalog;
}

export type ModelChoiceResult = { ok: true; choice: ModelChoice } | { ok: false; message: string };

const INVALID_REQUEST = 'Invalid request.';

function field(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MODEL_CHOICE_FIELD_MAX_LENGTH
    ? value
    : undefined;
}

/**
 * Validate a continueWithModel request against the catalog: a known agent, one
 * of its models, an effort it accepts (optional), fast mode only where the
 * model supports it, and a message (trimmed) within the length limit. Failures
 * carry a short user-facing message.
 */
export function parseModelChoice(
  raw: Record<string, unknown>,
  catalog: Pick<StreamModelCatalog, 'agents'>,
): ModelChoiceResult {
  const agentId = field(raw.agent);
  const modelId = field(raw.model);
  if (!agentId || !modelId) return { ok: false, message: INVALID_REQUEST };
  const row = catalog.agents.find((a) => a.agent === agentId);
  if (!row) return { ok: false, message: 'Choose Claude, Codex or Cursor.' };
  const model = row.models.find((m) => m.id === modelId);
  if (!model) return { ok: false, message: `${row.label} doesn't offer that model.` };
  const choice: ModelChoice = { agent: row.agent, model: model.id, message: '' };
  if (raw.effort !== undefined) {
    const effort = field(raw.effort);
    if (!effort || !row.efforts.includes(effort)) {
      return { ok: false, message: `${row.label} doesn't accept that effort.` };
    }
    choice.effort = effort;
  }
  if (raw.fastMode !== undefined) {
    if (typeof raw.fastMode !== 'boolean') return { ok: false, message: INVALID_REQUEST };
    if (raw.fastMode && !row.fastModeModels.includes(model.id)) {
      return { ok: false, message: `${model.label} has no fast mode.` };
    }
    if (raw.fastMode) choice.fastMode = true;
  }
  if (typeof raw.message !== 'string') return { ok: false, message: INVALID_REQUEST };
  const message = raw.message.trim();
  if (!message) return { ok: false, message: 'Type a message first.' };
  if (message.length > SESSION_MESSAGE_MAX_LENGTH) {
    return { ok: false, message: 'Message is too long.' };
  }
  choice.message = message;
  return { ok: true, choice };
}

/** The display label of a model id, if the table knows it. */
export function modelLabel(
  modelId: string,
  table: readonly AgentRow[] = MODEL_TABLE,
): string | undefined {
  for (const row of table) {
    const hit = row.models.find(([id]) => id === modelId);
    if (hit) return hit[1];
  }
  return undefined;
}

/**
 * The continuation's name: "<original name> · <model label>". A model suffix
 * an earlier continuation added is replaced rather than stacked, and the
 * original name gives way first when the whole is too long.
 */
export function continuationName(original: string | undefined, modelId: string): string {
  const label = modelLabel(modelId) ?? modelId;
  let base = (original ?? '').replace(/\s+/g, ' ').trim();
  for (const row of MODEL_TABLE) {
    for (const [, known] of row.models) {
      const suffix = ` · ${known}`;
      if (base.endsWith(suffix)) base = base.slice(0, -suffix.length).trimEnd();
    }
  }
  if (!base) base = 'Session';
  const suffix = ` · ${label}`;
  const room = CONTINUE_SESSION_NAME_MAX_LENGTH - suffix.length;
  if (base.length > room) base = `${base.slice(0, Math.max(1, room - 1)).trimEnd()}…`;
  return `${base}${suffix}`;
}
