import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { useConductor } from '../conductor/conductorStore.js';
import { emptyOfficeCard } from '../conductor/emptyOffice.js';
import { CLOUD_ONLY_NOTE, conductorStatusLine, elapsedText } from '../conductor/format.js';
import { useNow } from '../conductor/hooks.js';
import { CONDUCTOR_CONNECTING_TICK_MS, CONDUCTOR_UI_TICK_MS } from '../constants.js';
import { transport } from '../transport/index.js';
import type { TransportState } from '../transport/types.js';
import { ConductorConnectCard } from './ConductorConnectCard.js';
import { CapsuleIcon } from './PokemonPortrait.js';
import { Button } from './ui/Button.js';

interface ConductorEmptyOfficeProps {
  /** Null in a read-only office (it can't change the scope). */
  onOpenSessions: (() => void) | null;
  /** A read-only office can watch but not connect. */
  readOnly: boolean;
}

const WALK_IN_TEXT = 'Sessions active in your cloud workspaces walk in here.';

/** The office's socket state, kept current. */
function useTransportState(): TransportState {
  const [state, setState] = useState<TransportState>(transport.state);
  useEffect(() => {
    setState(transport.state);
    return transport.onStateChange(setState);
  }, []);
  return state;
}

/**
 * Centred in an office with Conductor on and nobody in it: the Connect card
 * when there is no usable key, "Connected as …" right after connecting, a
 * connection problem, "No sessions in scope" with the way to widen it, or
 * "Connecting to Conductor…" with the seconds so far (after
 * CONDUCTOR_SLOW_CONNECT_MS, "Still connecting…" and why sessions may take a
 * while). emptyOfficeCard decides from the store's newest state, so the card
 * never lingers once the server reports connected or sessions are present.
 * Says that only cloud workspaces appear, the first thing a Conductor user
 * would otherwise suspect.
 */
export function ConductorEmptyOffice({ onOpenSessions, readOnly }: ConductorEmptyOfficeProps) {
  const status = useConductor((s) => s.status);
  const signIn = useConductor((s) => s.signIn);
  const connectingSince = useConductor((s) => s.connectingSince);
  const agentCount = useConductor((s) => s.agentIds.length);
  const transportState = useTransportState();
  const waiting = status === null || status.state === 'connecting';
  const now = useNow(waiting ? CONDUCTOR_CONNECTING_TICK_MS : CONDUCTOR_UI_TICK_MS);
  const card = emptyOfficeCard({
    status,
    signIn,
    connectingSince,
    agentCount,
    transportState,
    now,
  });
  if (!card) return null;

  let title: string;
  let body: ReactNode;
  switch (card.kind) {
    case 'signIn':
      title = 'Connect to Conductor';
      body = <ConductorConnectCard readOnly={readOnly} />;
      break;
    case 'justConnected':
      title = card.headline;
      body = (
        <>
          {card.note && <span className="text-xs">{card.note}</span>}
          <span className="text-xs text-text-muted">
            {status?.state === 'connected' ? WALK_IN_TEXT : conductorStatusLine(status, now)}
          </span>
        </>
      );
      break;
    case 'noSessions':
      title = 'No sessions in scope';
      body = <span className="text-xs text-text-muted">{WALK_IN_TEXT}</span>;
      break;
    case 'connecting':
      title = card.slow ? 'Still connecting…' : 'Connecting to Conductor…';
      body = (
        <>
          {card.slow && (
            <span className="text-xs">Conductor may be slow; sessions appear as they load.</span>
          )}
          <span className="text-xs text-text-muted" role="timer" data-testid="conductor-elapsed">
            {elapsedText(card.elapsedMs)} elapsed
          </span>
        </>
      );
      break;
    case 'reconnecting':
      title = 'Reconnecting…';
      body = (
        <span className="text-xs text-text-muted">
          The office lost its connection to Poke Agents and is reconnecting.
        </span>
      );
      break;
    case 'problem':
      title = 'Waiting for Conductor';
      body = <span className="text-xs text-text-muted">{conductorStatusLine(status, now)}</span>;
      break;
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 p-16">
      {/* Scrolls rather than clipping in a short window (the Connect card is tall). */}
      <div className="pixel-panel pointer-events-auto flex flex-col items-center gap-8 py-12 px-16 max-w-[460px] max-h-full overflow-y-auto text-center">
        <CapsuleIcon size={32} />
        <span className="text-lg">{title}</span>
        {body}
        {status?.state === 'connected' && onOpenSessions && (
          <Button size="md" variant="accent" onClick={onOpenSessions}>
            Open Sessions
          </Button>
        )}
        <span className="text-xs leading-tight text-text-muted pt-4">{CLOUD_ONLY_NOTE}</span>
      </div>
    </div>
  );
}

/**
 * Centred in a standalone office started with every provider off
 * (`--no-conductor` without `--claude`): nothing can ever walk in, so say how
 * to restart it. The CLI prints the same advice.
 */
export function NothingTrackedOffice() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 p-16">
      <div className="pixel-panel pointer-events-auto flex flex-col items-center gap-8 py-12 px-16 max-w-[420px] text-center">
        <CapsuleIcon size={32} />
        <span className="text-lg">Nothing to track</span>
        <span className="text-xs text-text-muted">
          Restart without <span className="text-accent">--no-conductor</span>, or add{' '}
          <span className="text-accent">--claude</span>.
        </span>
      </div>
    </div>
  );
}
