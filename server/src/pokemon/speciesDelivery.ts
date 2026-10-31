/**
 * Per-connection `pokemonSpeciesLoaded` delivery.
 *
 * Wraps one socket's outgoing messages. Every species an office shows is sent
 * to it exactly once (tracked by `dex:shiny`):
 * - after `existingAgents`, every species in use;
 * - when an `agentCreated` or `agentDetails` introduces a species: ahead of
 *   that message when the species is already loaded, otherwise as soon as its
 *   load completes (the office draws the upstream character until then);
 * - when the theme is switched on (`pokemonThemeUpdated`), every species in use.
 * Nothing is fetched or sent while sprites are off or the theme is off.
 *
 * The theme state is read from the messages this connection is sent
 * (`settingsLoaded.pokemonTheme`, `pokemonThemeUpdated`); before one arrives
 * it is read once from the adapter setting.
 */

import type { AgentStateStore } from '../agentStateStore.js';
import { isValidDex } from './pmdCache.js';
import {
  arePokemonSpritesEnabled,
  ensureSpeciesLoaded,
  getLoadedSpecies,
  isPokemonThemeOn,
  speciesKey,
} from './pokemonAssets.js';

type OutgoingMessage = Record<string, unknown>;

export interface SpeciesDelivery {
  /** Send one outgoing message, with any `pokemonSpeciesLoaded` it needs around it. */
  send(message: OutgoingMessage): void;
  /** The connection closed: drop pending deliveries. */
  dispose(): void;
}

export function createSpeciesDelivery(
  store: AgentStateStore,
  send: (message: OutgoingMessage) => void,
): SpeciesDelivery {
  const sent = new Set<string>();
  const loading = new Set<string>();
  let themeOn: boolean | undefined;
  let disposed = false;

  const enabled = (): boolean => {
    if (disposed || !arePokemonSpritesEnabled()) return false;
    themeOn ??= isPokemonThemeOn(store);
    return themeOn;
  };

  const deliver = (dex: number, shiny: boolean): void => {
    const key = speciesKey(dex, shiny);
    if (sent.has(key) || !isValidDex(dex)) return;
    const payload = getLoadedSpecies(dex, shiny);
    if (payload) {
      sent.add(key);
      send({ type: 'pokemonSpeciesLoaded', ...payload });
      return;
    }
    if (loading.has(key)) return;
    loading.add(key);
    void ensureSpeciesLoaded(dex, shiny, store).then((ready) => {
      loading.delete(key);
      if (ready && enabled()) deliver(dex, shiny);
    });
  };

  const deliverSpeciesInUse = (): void => {
    for (const agent of store.values()) {
      if (agent.species !== undefined) deliver(agent.species, agent.shiny === true);
    }
  };

  /** The species an agent message refers to: its own fields, else the agent's. */
  const introducedSpecies = (message: OutgoingMessage): [number, boolean] | null => {
    const agent = typeof message.id === 'number' ? store.get(message.id) : undefined;
    const dex = typeof message.species === 'number' ? message.species : agent?.species;
    if (dex === undefined) return null;
    const shiny = typeof message.shiny === 'boolean' ? message.shiny : agent?.shiny === true;
    return [dex, shiny];
  };

  return {
    send(message) {
      switch (message.type) {
        case 'settingsLoaded':
          if (typeof message.pokemonTheme === 'boolean') themeOn = message.pokemonTheme;
          break;
        case 'pokemonThemeUpdated':
          themeOn = message.enabled === true;
          // Switching back on re-sends everything in use, whatever the office dropped meanwhile.
          if (!themeOn) sent.clear();
          break;
        case 'agentCreated':
        case 'agentDetails': {
          const species = introducedSpecies(message);
          if (species && enabled()) deliver(...species);
          break;
        }
      }
      send(message);
      if (
        (message.type === 'existingAgents' || message.type === 'pokemonThemeUpdated') &&
        enabled()
      ) {
        deliverSpeciesInUse();
      }
    },
    dispose() {
      disposed = true;
    },
  };
}
