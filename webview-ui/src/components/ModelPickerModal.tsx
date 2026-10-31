import { useEffect, useMemo, useRef, useState } from 'react';

import { continueWithModel, requestModelCatalog } from '../conductor/actions.js';
import type { ConductorAgent } from '../conductor/conductorStore.js';
import { useConductor } from '../conductor/conductorStore.js';
import { useNow } from '../conductor/hooks.js';
import {
  choiceForAgent,
  choiceFromFavorite,
  chooseModel,
  continueRequest,
  effortOptions,
  fastModeSupported,
  favoritesFor,
  handoffMessage,
  initialChoice,
  isFavoriteChosen,
  modelName,
  type PickerChoice,
  sessionModelRows,
  startBlocker,
} from '../conductor/modelPicker.js';
import { MODEL_PICKER_START_TIMEOUT_MS } from '../constants.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';
import { Modal } from './ui/Modal.js';

/** Why Switch model starts a session instead of changing this one. */
const SWITCH_MODEL_NOTE =
  "Conductor's API can't change the model of a running session, so this starts a new session in the same workspace (same files and branch) with your message.";

/** Re-render often enough to notice a start that never got an answer. */
const START_TICK_MS = 1_000;

interface ModelPickerModalProps {
  agentId: number;
  agent: ConductorAgent | undefined;
  onClose: () => void;
}

/**
 * Switch model…: pick an agent (Claude, Codex, Cursor), a model (the user's
 * Conductor favorites first, starred), an effort and fast mode, edit the
 * handoff message, and start a new session in the same workspace. The office
 * then opens the new session's Pokédex when it walks in (App follows it).
 */
export function ModelPickerModal({ agentId, agent, onClose }: ModelPickerModalProps) {
  const catalog = useConductor((s) => s.modelCatalog);
  const outcome = useConductor((s) => s.actionOutcomes[agentId]);
  const [picked, setPicked] = useState<PickerChoice | null>(null);
  const [message, setMessage] = useState(() => handoffMessage(agent?.label));
  const [sentAt, setSentAt] = useState<number | null>(null);
  const now = useNow(START_TICK_MS, sentAt !== null);

  // Fresh favorites every time the picker opens (the server caches them).
  useEffect(() => requestModelCatalog(), []);

  const choice = picked ?? initialChoice(catalog, agent);
  const listRef = useRef<HTMLUListElement>(null);
  const answer =
    sentAt !== null && outcome?.action === 'continueWithModel' && outcome.at >= sentAt
      ? outcome
      : undefined;
  const pending = sentAt !== null && !answer && now - sentAt < MODEL_PICKER_START_TIMEOUT_MS;

  // Started: close; the App opens the new session once it arrives.
  useEffect(() => {
    if (answer?.ok) onClose();
  }, [answer, onClose]);

  // Keep the chosen model in view (the session's own may be far down the list).
  const chosenKey = choice ? `${choice.agent}:${choice.model}` : '';
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-pressed="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [chosenKey]);

  const current = sessionModelRows(agent, catalog);
  const currentText = [current.agent, current.model, current.effort].filter(Boolean).join(' · ');
  const favorites = useMemo(
    () => (choice ? favoritesFor(catalog, choice.agent) : []),
    [catalog, choice],
  );
  const row = choice ? catalog?.agents.find((a) => a.agent === choice.agent) : undefined;
  const blocker = startBlocker(catalog, choice, message);
  const canStart = blocker === null && !pending;
  const fastOk = choice ? fastModeSupported(catalog, choice.agent, choice.model) : false;

  const start = () => {
    if (!choice || !canStart) return;
    setSentAt(Date.now());
    continueWithModel(continueRequest(agentId, choice, message));
  };

  const status = pending
    ? 'Starting…'
    : answer && !answer.ok
      ? `Couldn't start it: ${answer.message ?? 'Conductor refused the request.'}`
      : sentAt !== null && !answer
        ? 'No answer yet. You can try again.'
        : null;

  return (
    <Modal isOpen onClose={onClose} title="Switch model" className="w-[min(520px,100%)]">
      <div className="px-10 pb-8 flex flex-col gap-10 text-sm">
        {currentText && (
          <div className="text-xs">
            <span className="text-text-muted">Now: </span>
            {currentText}
          </div>
        )}
        <p className="m-0 text-xs text-text-muted" style={{ lineHeight: 1.35 }}>
          {SWITCH_MODEL_NOTE}
        </p>

        {!catalog || !choice ? (
          <span className="text-xs text-text-muted">{catalog?.error ?? 'Loading models…'}</span>
        ) : (
          <>
            <div role="tablist" aria-label="Agent" className="flex gap-4">
              {catalog.agents.map((a) => (
                <Button
                  key={a.agent}
                  role="tab"
                  aria-selected={a.agent === choice.agent}
                  size="sm"
                  variant={a.agent === choice.agent ? 'active' : 'default'}
                  className="flex-1"
                  onClick={() => setPicked(choiceForAgent(catalog, a.agent))}
                >
                  {a.label}
                </Button>
              ))}
            </div>

            <div className="flex flex-col gap-4">
              <span className="text-xs text-accent">Model</span>
              <ul
                ref={listRef}
                aria-label="Models"
                className="m-0 p-0 list-none flex flex-col max-h-[200px] overflow-y-auto pixel-scrollbar border-2 border-border"
              >
                {favorites.map((favorite, i) => {
                  const chosen = isFavoriteChosen(favorite, choice);
                  const extras = [favorite.effort, favorite.fastMode ? 'fast' : undefined]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <li key={`fav:${i}`}>
                      <button
                        type="button"
                        aria-pressed={chosen}
                        title="One of your favorite models in Conductor"
                        className={`w-full text-left text-xs py-3 px-6 border-0 rounded-none cursor-pointer ${
                          chosen ? 'bg-active-bg text-text' : 'bg-transparent hover:bg-btn-hover'
                        }`}
                        onClick={() => setPicked(choiceFromFavorite(catalog, favorite))}
                      >
                        <span
                          className="material-symbols-sharp text-accent mr-4 align-[-1px]"
                          aria-hidden="true"
                        >
                          star
                        </span>
                        <span className="sr-only">Favorite: </span>
                        {modelName(catalog, favorite.model)}
                        {extras && <span className="text-text-muted"> · {extras}</span>}
                      </button>
                    </li>
                  );
                })}
                {row?.models.map((model) => {
                  const chosen =
                    model.id === choice.model &&
                    !favorites.some((f) => isFavoriteChosen(f, choice));
                  return (
                    <li key={model.id}>
                      <button
                        type="button"
                        aria-pressed={chosen}
                        className={`w-full text-left text-xs py-3 px-6 border-0 rounded-none cursor-pointer ${
                          chosen ? 'bg-active-bg text-text' : 'bg-transparent hover:bg-btn-hover'
                        }`}
                        onClick={() => setPicked(chooseModel(catalog, choice, model.id))}
                      >
                        {model.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="flex items-center gap-8 flex-wrap">
              <label className="flex items-center gap-6 text-xs">
                <span className="text-text-muted">Effort</span>
                <select
                  value={choice.effort}
                  onChange={(e) => setPicked({ ...choice, effort: e.target.value })}
                  className="text-xs py-2 px-4 bg-btn-bg border-2 border-border rounded-none text-text"
                >
                  {effortOptions(catalog, choice.agent).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {fastOk && (
                <Checkbox
                  label="Fast mode"
                  checked={choice.fastMode}
                  onChange={() => setPicked({ ...choice, fastMode: !choice.fastMode })}
                  className="w-auto! gap-8 py-2! px-4! text-xs"
                />
              )}
            </div>
          </>
        )}

        <label className="flex flex-col gap-4">
          <span className="text-xs text-accent">First message</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            aria-label="First message of the new session"
            className="w-full resize-none text-xs py-4 px-6 bg-btn-bg border-2 border-border rounded-none text-text"
            style={{ lineHeight: 1.35 }}
          />
        </label>

        <div className="flex items-center justify-between gap-8">
          <span
            className={`text-2xs leading-tight min-w-0 ${
              answer && !answer.ok ? 'text-status-error' : 'text-text-muted'
            }`}
            aria-live="polite"
          >
            {status ?? (blocker && catalog ? blocker : '')}
          </span>
          <div className="flex gap-6 shrink-0">
            <Button size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="md"
              variant={canStart ? 'accent' : 'disabled'}
              disabled={!canStart}
              onClick={start}
            >
              {pending ? 'Starting…' : 'Start'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
