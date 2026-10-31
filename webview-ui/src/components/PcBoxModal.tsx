import { useEffect, useMemo, useState } from 'react';

import { requestConductorSessions, restoreSession } from '../conductor/actions.js';
import { findSpecies, useConductor } from '../conductor/conductorStore.js';
import { agoText, workspaceLabel } from '../conductor/format.js';
import { useNow } from '../conductor/hooks.js';
import { pcBoxPortraitUrl, pcBoxSpecies } from '../conductor/party.js';
import { archivedSessions } from '../conductor/sessionsView.js';
import { CONDUCTOR_UI_TICK_MS, PORTRAIT_SOURCE_PX } from '../constants.js';
import { isBrowserRuntime } from '../runtime.js';
import { CapsuleIcon, PokemonPortrait } from './PokemonPortrait.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface PcBoxModalProps {
  isOpen: boolean;
  onClose: () => void;
  readOnly: boolean;
}

/**
 * The PC Box: sessions deposited (archived) in Conductor. Withdraw
 * unarchives one, and it walks back into the office.
 */
export function PcBoxModal({ isOpen, onClose, readOnly }: PcBoxModalProps) {
  const sessions = useConductor((s) => s.sessions);
  const sessionSpecies = useConductor((s) => s.sessionSpecies);
  const speciesMap = useConductor((s) => s.species);
  const pokemonTheme = useConductor((s) => s.pokemonTheme);
  // The standalone server serves portraits by dex while the theme is on.
  const portraitRoute = isBrowserRuntime && pokemonTheme;
  const now = useNow(CONDUCTOR_UI_TICK_MS, isOpen);
  // Withdrawals in flight: the row stays but its button waits until the
  // session leaves the archived list (or the toast reports a failure).
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (isOpen && !readOnly) requestConductorSessions();
  }, [isOpen, readOnly]);

  const archived = useMemo(() => archivedSessions(sessions ?? []), [sessions]);
  // Every list update settles the requests it answered.
  useEffect(() => setPending(new Set()), [sessions]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="PC Box" className="w-[min(520px,100%)]">
      <div className="flex flex-col gap-6 px-10 pb-8">
        {archived.length === 0 ? (
          <div className="py-8 text-sm flex flex-col gap-4">
            <span>The PC is empty.</span>
            <span className="text-xs text-text-muted">
              Deposit a session from its Pokédex to store it here.
            </span>
          </div>
        ) : (
          <ul className="m-0 p-0 list-none flex flex-col gap-4">
            {archived.map((session) => {
              const ref = pcBoxSpecies(session, sessionSpecies);
              const species = findSpecies({ species: speciesMap }, ref?.species, ref?.shiny);
              const waiting = pending.has(session.sessionId);
              return (
                <li
                  key={session.sessionId}
                  className="flex items-center gap-8 p-4 border-2 border-border bg-btn-bg"
                >
                  <PokemonPortrait
                    url={pcBoxPortraitUrl(ref, { species: speciesMap }, portraitRoute)}
                    size={PORTRAIT_SOURCE_PX}
                    alt={species?.name ?? ''}
                    fallback={<CapsuleIcon size={PORTRAIT_SOURCE_PX} />}
                  />
                  <div className="flex-1 min-w-0 flex flex-col gap-2">
                    <span className="text-sm truncate">{session.label}</span>
                    <span className="text-2xs text-text-muted truncate">
                      {[
                        workspaceLabel(session.workspaceNumber, session.workspaceName),
                        session.repo,
                        session.archivedAt
                          ? `deposited ${agoText(session.archivedAt, now)}`
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  {!readOnly && (
                    <Button
                      size="sm"
                      variant={waiting ? 'disabled' : 'default'}
                      disabled={waiting}
                      onClick={() => {
                        setPending((prev) => new Set(prev).add(session.sessionId));
                        restoreSession(session.sessionId);
                      }}
                    >
                      {waiting ? 'Withdrawing…' : 'Withdraw'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
