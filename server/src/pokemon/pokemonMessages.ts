/**
 * Client messages for Change Pokémon: the picker's catalog
 * (requestPokemonCatalog → pokemonCatalog) and the choice itself
 * (setAgentPokemon → conductorActionResult, then agentDetails once the new
 * species is loaded). Which Pokémon an agent is belongs to Poke Agents' own
 * view state: nothing here touches Conductor. Dispatched after the read-only
 * gate, so both are privileged; refusePokemonMessage answers a read-only
 * office.
 *
 * Stream agents change through their StreamAgentDriver (it remembers the
 * choice with the session); other agents (`--claude`) through the store,
 * which persists it with the agent.
 */

import type { ClientMessageContext } from '../clientMessageHandler.js';
import { announceSpeciesChange } from './agentLevel.js';
import {
  choiceRefusal,
  choosePokemon,
  type PokemonChoice,
  pokemonPickerCatalog,
} from './speciesAssigner.js';

type WsSend = (message: Record<string, unknown>) => void;

const READ_ONLY_MESSAGE = 'Read-only office: open the tokened URL to make changes.';
const INVALID_REQUEST_MESSAGE = 'Invalid request.';
const NO_POKEMON_MESSAGE = 'This agent has no Pokémon.';

export const POKEMON_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'requestPokemonCatalog',
  'setAgentPokemon',
]);

export function handlePokemonMessage(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): void {
  switch (msg.type) {
    case 'requestPokemonCatalog':
      send({ type: 'pokemonCatalog', ...pokemonPickerCatalog() });
      return;
    case 'setAgentPokemon':
      setAgentPokemon(msg, send, ctx);
      return;
  }
}

/** The read-only gate's answer: an empty picker, or a refused choice. */
export function refusePokemonMessage(msg: Record<string, unknown>, send: WsSend): void {
  if (msg.type === 'requestPokemonCatalog') {
    send({ type: 'pokemonCatalog', lines: [], legendaries: [] });
  } else if (msg.type === 'setAgentPokemon') {
    reply(send, false, READ_ONLY_MESSAGE, msg.id);
  }
}

/** The request as a choice, or null when it is malformed. */
function parseChoice(msg: Record<string, unknown>): PokemonChoice | null {
  const { line, shiny } = msg;
  if (line !== undefined && line !== null && typeof line !== 'string') return null;
  if (shiny !== undefined && typeof shiny !== 'boolean') return null;
  if (line === undefined && shiny === undefined) return null;
  const choice: PokemonChoice = {};
  if (line !== undefined) choice.line = line;
  if (shiny !== undefined) choice.shiny = shiny;
  return choice;
}

function setAgentPokemon(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): void {
  const id = msg.id;
  if (!Number.isSafeInteger(id)) return reply(send, false, INVALID_REQUEST_MESSAGE);
  const agentId = id as number;
  const choice = parseChoice(msg);
  if (!choice) return reply(send, false, INVALID_REQUEST_MESSAGE, agentId);
  const agent = ctx.store.get(agentId);
  if (!agent || agent.species === undefined) return reply(send, false, NO_POKEMON_MESSAGE, agentId);
  if (typeof choice.line === 'string') {
    const refusal = choiceRefusal(choice.line, { lead: agent.isTeamLead === true });
    if (refusal) return reply(send, false, refusal, agentId);
  }
  const driver = ctx.runtime?.streamDriverForAgent(agentId);
  if (driver) {
    driver.setAgentPokemon(agentId, choice);
  } else if (choosePokemon(agent, ctx.store, choice)) {
    ctx.store.persist();
    announceSpeciesChange(agentId, agent, ctx.store);
  }
  reply(send, true, undefined, agentId);
}

function reply(send: WsSend, ok: boolean, message?: string, id?: unknown): void {
  send({
    type: 'conductorActionResult',
    action: 'setAgentPokemon',
    id: Number.isSafeInteger(id) ? id : undefined,
    ok,
    message,
  });
}
