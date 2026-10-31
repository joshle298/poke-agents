import { useEffect, useMemo, useState } from 'react';

import { requestPokemonCatalog, setAgentPokemon } from '../conductor/actions.js';
import type { ConductorAgent } from '../conductor/conductorStore.js';
import { findSpecies, useConductor } from '../conductor/conductorStore.js';
import { useNow } from '../conductor/hooks.js';
import {
  currentEntryId,
  pickerEntries,
  type PickerEntry,
  pickerPortraitUrl,
  shownShiny,
} from '../conductor/pokemonPicker.js';
import { POKEMON_PICKER_PORTRAIT_PX, POKEMON_PICKER_TIMEOUT_MS } from '../constants.js';
import { isBrowserRuntime } from '../runtime.js';
import { CapsuleIcon, PokemonPortrait } from './PokemonPortrait.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';
import { Modal } from './ui/Modal.js';

/** Re-render often enough to notice a choice that never got an answer. */
const CHOICE_TICK_MS = 1_000;

/** One section of the grid: a portrait (lazy) and a name per entry. */
function PickerGrid({
  entries,
  currentId,
  disabled,
  portraitRoute,
  onChoose,
}: {
  entries: readonly PickerEntry[];
  currentId: string | undefined;
  disabled: boolean;
  portraitRoute: boolean;
  onChoose: (id: string) => void;
}) {
  return (
    <ul className="m-0 p-0 list-none grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-4">
      {entries.map((entry) => {
        const current = entry.id === currentId;
        return (
          <li key={entry.id}>
            <button
              type="button"
              aria-pressed={current}
              title={entry.title}
              disabled={disabled}
              onClick={() => onChoose(entry.id)}
              className={`w-full flex flex-col items-center gap-2 py-4 px-2 border-2 rounded-none cursor-pointer ${
                current
                  ? 'bg-active-bg border-accent'
                  : 'bg-btn-bg border-transparent hover:bg-btn-hover'
              }`}
            >
              <PokemonPortrait
                url={pickerPortraitUrl(entry.dex, portraitRoute)}
                size={POKEMON_PICKER_PORTRAIT_PX}
                alt=""
                loading="lazy"
                fallback={<CapsuleIcon size={POKEMON_PICKER_PORTRAIT_PX} />}
              />
              <span className="text-2xs leading-none text-center break-words max-w-full">
                {entry.name}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

interface PokemonPickerModalProps {
  agentId: number;
  agent: ConductorAgent | undefined;
  onClose: () => void;
}

/**
 * Change Pokémon…: which evolution line (or, for a Lead, which legendary)
 * this agent is, shiny or not, or back to automatic (the Pokémon it had
 * before the first choice). Shiny applies to the current Pokémon at once and
 * the picker stays open; a tile or the reset closes it. The level still picks
 * the stage within the line; the office plays the evolution flash. Portraits
 * come lazily from the local server's same-origin route; without it, the
 * capsule stands in.
 */
export function PokemonPickerModal({ agentId, agent, onClose }: PokemonPickerModalProps) {
  const catalog = useConductor((s) => s.pokemonCatalog);
  const speciesMap = useConductor((s) => s.species);
  const pokemonTheme = useConductor((s) => s.pokemonTheme);
  const outcome = useConductor((s) => s.actionOutcomes[agentId]);
  // The last request: a tile or the reset closes the picker once answered;
  // a Shiny toggle keeps it open and shows its value until the office has it.
  const [sent, setSent] = useState<{ at: number; shiny?: boolean } | null>(null);
  const sentAt = sent?.at ?? null;
  const now = useNow(CHOICE_TICK_MS, sentAt !== null);

  useEffect(() => {
    if (!catalog) requestPokemonCatalog();
  }, [catalog]);

  const answer =
    sentAt !== null && outcome?.action === 'setAgentPokemon' && outcome.at >= sentAt
      ? outcome
      : undefined;
  const pending = sentAt !== null && !answer && now - sentAt < POKEMON_PICKER_TIMEOUT_MS;
  const shinyToggle = sent?.shiny !== undefined;
  const currentShiny = agent?.shiny === true;
  const shiny = shownShiny(currentShiny, sent, pending || answer?.ok === true);

  // A tile or the reset was answered: close, so the evolution flash plays in
  // view. A Shiny toggle stays open.
  useEffect(() => {
    if (answer?.ok && !shinyToggle) onClose();
  }, [answer, shinyToggle, onClose]);

  const isLead = agent?.isTeamLead === true;
  const entries = useMemo(() => pickerEntries(catalog, isLead), [catalog, isLead]);
  const currentId = currentEntryId(catalog, agent?.species);
  const portraitRoute = isBrowserRuntime && pokemonTheme;
  const species = findSpecies({ species: speciesMap }, agent?.species, agent?.shiny);
  const nowText = [
    species ? `${species.name}${agent?.shiny ? ' (shiny)' : ''}` : undefined,
    agent?.level !== undefined ? `Lv ${agent.level}` : undefined,
    agent?.pokemonChosen ? 'chosen' : 'automatic',
  ]
    .filter(Boolean)
    .join(' · ');

  const choose = (line: string | null) => {
    if (pending) return;
    if (line !== null && line === currentId && shiny === currentShiny && agent?.pokemonChosen) {
      onClose();
      return;
    }
    setSent({ at: Date.now() });
    setAgentPokemon(agentId, line === null ? { line: null } : { line, shiny });
  };

  const toggleShiny = () => {
    if (pending) return;
    setSent({ at: Date.now(), shiny: !shiny });
    setAgentPokemon(agentId, { shiny: !shiny });
  };

  const lines = entries.filter((e) => e.kind === 'line');
  const legendaries = entries.filter((e) => e.kind === 'legendary');
  return (
    <Modal isOpen onClose={onClose} title="Change Pokémon" className="w-[min(560px,100%)]">
      <div className="px-10 pb-8 flex flex-col gap-8 text-sm">
        {nowText && (
          <div className="text-xs">
            <span className="text-text-muted">Now: </span>
            {nowText}
          </div>
        )}
        <div className="flex items-center justify-between gap-8 flex-wrap">
          <Checkbox
            label="Shiny"
            checked={shiny}
            onChange={toggleShiny}
            className="w-auto! gap-8 py-2! px-4! text-xs"
          />
          <Button
            size="sm"
            variant={agent?.pokemonChosen && !pending ? 'default' : 'disabled'}
            disabled={!agent?.pokemonChosen || pending}
            onClick={() => choose(null)}
            title="Back to the Pokémon Poke Agents picked for this agent"
          >
            Reset to automatic
          </Button>
        </div>
        {!catalog ? (
          <span className="text-xs text-text-muted">Loading…</span>
        ) : (
          <div className="flex flex-col gap-8 max-h-[min(420px,55vh)] overflow-y-auto pixel-scrollbar pr-2">
            <PickerGrid
              entries={lines}
              currentId={currentId}
              disabled={pending}
              portraitRoute={portraitRoute}
              onChoose={choose}
            />
            {legendaries.length > 0 && (
              <>
                <span className="text-xs text-accent">Legendaries (Leads)</span>
                <PickerGrid
                  entries={legendaries}
                  currentId={currentId}
                  disabled={pending}
                  portraitRoute={portraitRoute}
                  onChoose={choose}
                />
              </>
            )}
          </div>
        )}
        <span
          className={`text-2xs leading-tight ${answer && !answer.ok ? 'text-status-error' : 'text-text-muted'}`}
          aria-live="polite"
        >
          {pending
            ? 'Changing…'
            : answer && !answer.ok
              ? `Couldn't change it: ${answer.message ?? 'refused'}`
              : 'The level still picks the stage within the line.'}
        </span>
      </div>
    </Modal>
  );
}
