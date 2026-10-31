/**
 * Switch model: the picker's pure rules (DOM-free, Node-tested). The server
 * validates everything again against its catalog; these only keep the
 * picker's choices consistent and its Start button honest.
 */

import type {
  ContinueWithModel,
  FavoriteModel,
  ModelCatalog,
  ModelCatalogAgent,
} from '../../../core/src/messages.js';
import { MODEL_PICKER_MESSAGE_MAX_LENGTH } from '../constants.js';
import type { ConductorAgent } from './conductorStore.js';

/** What the picker has chosen so far. `effort` '' = the agent's default. */
export interface PickerChoice {
  agent: string;
  model: string;
  effort: string;
  fastMode: boolean;
}

/** The handoff message the picker starts with (the user can edit it). */
export function handoffMessage(name: string | undefined): string {
  const session = name?.trim() ? `the session "${name.trim()}"` : 'the previous session';
  return `Continue the work from ${session} in this workspace. Check its recent commits and changes before you start.`;
}

function agentRow(catalog: ModelCatalog | null, agent: string): ModelCatalogAgent | undefined {
  return catalog?.agents.find((a) => a.agent === agent);
}

/** The display label of an agent id ("Codex"), else the id as given. */
export function agentLabel(
  catalog: ModelCatalog | null,
  agent: string | undefined,
): string | undefined {
  if (!agent) return undefined;
  return agentRow(catalog, agent)?.label ?? agent.charAt(0).toUpperCase() + agent.slice(1);
}

/** The catalog's label for a model id, if it has one. */
function catalogModelLabel(
  catalog: ModelCatalog | null,
  model: string | undefined,
): string | undefined {
  if (!model) return undefined;
  for (const row of catalog?.agents ?? []) {
    const hit = row.models.find((m) => m.id === model);
    if (hit) return hit.label;
  }
  return undefined;
}

/** The display label of a model id within an agent, else the id. */
export function modelName(
  catalog: ModelCatalog | null,
  model: string | undefined,
): string | undefined {
  return catalogModelLabel(catalog, model) ?? model;
}

/** What a session reports about its model: the resolved id (`model`, e.g.
 *  `claude-opus-5-5[1m]`) and the create-session id the catalog names
 *  (`modelId`, e.g. `opus-5-5-1m`). */
type SessionModel = Pick<ConductorAgent, 'harness' | 'model' | 'modelId' | 'effort' | 'fastMode'>;

/** The session's model as the catalog names it, if the catalog has it. */
function catalogModelOf(
  catalog: ModelCatalog | null,
  session: Pick<ConductorAgent, 'model' | 'modelId'> | undefined,
): string | undefined {
  if (catalogModelLabel(catalog, session?.modelId)) return session?.modelId;
  if (catalogModelLabel(catalog, session?.model)) return session?.model;
  return undefined;
}

/** "medium", "medium · fast mode", "fast mode", or undefined. */
export function effortText(
  effort: string | undefined,
  fastMode: boolean | undefined,
): string | undefined {
  const parts = [effort, fastMode ? 'fast mode' : undefined].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** The Pokédex Overview's Agent / Model / Effort rows for a session: the
 *  catalog's label for its model, else the id it reports. */
export function sessionModelRows(
  agent: SessionModel | undefined,
  catalog: ModelCatalog | null,
): { agent?: string; model?: string; effort?: string } {
  return {
    agent: agentLabel(catalog, agent?.harness),
    model:
      catalogModelLabel(catalog, catalogModelOf(catalog, agent)) ?? agent?.model ?? agent?.modelId,
    effort: effortText(agent?.effort, agent?.fastMode),
  };
}

/** The user's favorites for one agent, in Conductor's order. */
export function favoritesFor(catalog: ModelCatalog | null, agent: string): FavoriteModel[] {
  return catalog?.favorites.filter((f) => f.agent === agent) ?? [];
}

export function fastModeSupported(
  catalog: ModelCatalog | null,
  agent: string,
  model: string,
): boolean {
  return agentRow(catalog, agent)?.fastModeModels.includes(model) ?? false;
}

/** The effort select: the agent's default first (value ''), then its levels;
 *  a level only some models accept says so. */
export function effortOptions(
  catalog: ModelCatalog | null,
  agent: string,
): Array<{ value: string; label: string }> {
  const row = agentRow(catalog, agent);
  if (!row) return [];
  const fallback = row.defaultEffort ? `Default (${row.defaultEffort})` : 'Default';
  return [
    { value: '', label: fallback },
    ...row.efforts.map((e) => ({
      value: e,
      label: row.limitedEfforts?.includes(e) ? `${e} (some models)` : e,
    })),
  ];
}

/** A choice with everything the agent doesn't take dropped. */
function settle(catalog: ModelCatalog | null, choice: PickerChoice): PickerChoice {
  const row = agentRow(catalog, choice.agent);
  return {
    ...choice,
    effort: row?.efforts.includes(choice.effort) ? choice.effort : '',
    fastMode: choice.fastMode && fastModeSupported(catalog, choice.agent, choice.model),
  };
}

/** A favorite as a choice. */
export function choiceFromFavorite(
  catalog: ModelCatalog | null,
  favorite: FavoriteModel,
): PickerChoice {
  return settle(catalog, {
    agent: favorite.agent,
    model: favorite.model,
    effort: favorite.effort ?? '',
    fastMode: favorite.fastMode === true,
  });
}

/** The first choice for an agent's tab: its first favorite, else its first model. */
export function choiceForAgent(catalog: ModelCatalog | null, agent: string): PickerChoice {
  const favorite = favoritesFor(catalog, agent)[0];
  if (favorite) return choiceFromFavorite(catalog, favorite);
  const row = agentRow(catalog, agent);
  return { agent, model: row?.models[0]?.id ?? '', effort: '', fastMode: false };
}

/** Pick another model in the current tab, keeping the effort and fast mode
 *  where the new model takes them. */
export function chooseModel(
  catalog: ModelCatalog | null,
  choice: PickerChoice,
  model: string,
): PickerChoice {
  return settle(catalog, { ...choice, model });
}

/**
 * Where the picker opens: the session's own agent when the catalog has it
 * (else the first favorite's, else the first), on the session's model when
 * that agent offers it, with its effort and fast mode where they apply.
 */
export function initialChoice(
  catalog: ModelCatalog | null,
  session: SessionModel | undefined,
): PickerChoice | null {
  if (!catalog || catalog.agents.length === 0) return null;
  const own = session?.harness && agentRow(catalog, session.harness) ? session.harness : undefined;
  const agent =
    own ??
    (catalog.defaultAgent && agentRow(catalog, catalog.defaultAgent)
      ? catalog.defaultAgent
      : undefined) ??
    catalog.agents[0].agent;
  const row = agentRow(catalog, agent);
  const model = catalogModelOf(catalog, session);
  if (own && model && row?.models.some((m) => m.id === model)) {
    return settle(catalog, {
      agent,
      model,
      effort: session?.effort ?? '',
      fastMode: session?.fastMode === true,
    });
  }
  return choiceForAgent(catalog, agent);
}

/** Whether a favorite is exactly the current choice (its row is highlighted). */
export function isFavoriteChosen(favorite: FavoriteModel, choice: PickerChoice): boolean {
  return (
    favorite.agent === choice.agent &&
    favorite.model === choice.model &&
    (favorite.effort ?? '') === choice.effort &&
    (favorite.fastMode === true) === choice.fastMode
  );
}

/** Why Start is disabled, or null when the request can go. */
export function startBlocker(
  catalog: ModelCatalog | null,
  choice: PickerChoice | null,
  message: string,
): string | null {
  if (!catalog || !choice) return 'Loading models…';
  const row = agentRow(catalog, choice.agent);
  if (!row?.models.some((m) => m.id === choice.model)) return 'Choose a model.';
  if (!message.trim()) return 'Write the first message.';
  if (message.trim().length > MODEL_PICKER_MESSAGE_MAX_LENGTH) return 'The message is too long.';
  return null;
}

/** The continueWithModel request for a choice (default effort and fast mode
 *  off are left out). */
export function continueRequest(
  id: number,
  choice: PickerChoice,
  message: string,
): Omit<ContinueWithModel, 'type'> {
  return {
    id,
    agent: choice.agent,
    model: choice.model,
    ...(choice.effort ? { effort: choice.effort } : {}),
    ...(choice.fastMode ? { fastMode: true } : {}),
    message: message.trim(),
  };
}

/**
 * The agent to open once Switch model's new session walks in: the one whose
 * Conductor session is `sessionId` and that is in the office; `expired` when
 * the wait ran out; null while still waiting.
 */
export function followTarget(
  follow: { sessionId: string; at: number } | null,
  agents: Readonly<Record<number, Pick<ConductorAgent, 'conductorSessionId'>>>,
  isInOffice: (id: number) => boolean,
  now: number,
  waitMs: number,
): number | 'expired' | null {
  if (!follow) return null;
  for (const [key, agent] of Object.entries(agents)) {
    const id = Number(key);
    if (agent.conductorSessionId === follow.sessionId && isInOffice(id)) return id;
  }
  return now - follow.at >= waitMs ? 'expired' : null;
}
