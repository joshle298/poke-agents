import { useEffect, useMemo, useState } from 'react';

import { requestConductorSessions, restoreSession } from '../conductor/actions.js';
import { findSpecies, useConductor } from '../conductor/conductorStore.js';
import { agoText, workspaceLabel } from '../conductor/format.js';
import { useNow } from '../conductor/hooks.js';
import { archivedPortraitUrl, archivedSpecies } from '../conductor/party.js';
import { archivedSessions } from '../conductor/sessionsView.js';
import { CONDUCTOR_UI_TICK_MS, PORTRAIT_SOURCE_PX } from '../constants.js';
import { isBrowserRuntime } from '../runtime.js';
import { CapsuleIcon, PokemonPortrait } from './PokemonPortrait.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface ArchiveModalProps {
  isOpen: boolean;
  onClose: () => void;
  readOnly: boolean;
}

/**
 * Archived sessions (Archive in the toolbar): sessions archived in Conductor.
 * Restore unarchives one, and it walks back into the office.
 */
export function ArchiveModal({ isOpen, onClose, readOnly }: ArchiveModalProps) {
  const sessions = useConductor((s) => s.sessions);
  const sessionSpecies = useConductor((s) => s.sessionSpecies);
  const speciesMap = useConductor((s) => s.species);
  const pokemonTheme = useConductor((s) => s.pokemonTheme);
  // The standalone server serves portraits by dex while the theme is on.
  const portraitRoute = isBrowserRuntime && pokemonTheme;
  const now = useNow(CONDUCTOR_UI_TICK_MS, isOpen);
  // Restores in flight: the row stays but its button waits until the
  // session leaves the archived list (or the toast reports a failure).
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (isOpen && !readOnly) requestConductorSessions();
  }, [isOpen, readOnly]);

  const archived = useMemo(() => archivedSessions(sessions ?? []), [sessions]);
  // Every list update settles the requests it answered.
  useEffect(() => setPending(new Set()), [sessions]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Archived sessions"
      className="w-[min(520px,100%)]"
    >
      <div className="flex flex-col gap-6 px-10 pb-8">
        <span className="text-xs text-text-muted">
          Sessions you archived in Conductor. Restore one to bring it back to the office.
        </span>
        {archived.length === 0 ? (
          <div className="py-8 text-sm flex flex-col gap-4">
            <span>No archived sessions.</span>
            <span className="text-xs text-text-muted">
              Archive a session from its Pokédex to keep it here.
            </span>
          </div>
        ) : (
          <ul className="m-0 p-0 list-none flex flex-col gap-4">
            {archived.map((session) => {
              const ref = archivedSpecies(session, sessionSpecies);
              const species = findSpecies({ species: speciesMap }, ref?.species, ref?.shiny);
              const waiting = pending.has(session.sessionId);
              return (
                <li
                  key={session.sessionId}
                  className="flex items-center gap-8 p-4 border-2 border-border bg-btn-bg"
                >
                  <PokemonPortrait
                    url={archivedPortraitUrl(ref, { species: speciesMap }, portraitRoute)}
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
                          ? `archived ${agoText(session.archivedAt, now)}`
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
                      {waiting ? 'Restoring…' : 'Restore'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {pokemonTheme && (
          <span className="text-2xs text-text-muted">
            Your PC Box: archived Pokémon rest here until you restore them.
          </span>
        )}
      </div>
    </Modal>
  );
}
