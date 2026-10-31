import type { ReactNode } from 'react';

import { useConductor } from '../conductor/conductorStore.js';
import { CLOUD_ONLY_NOTE, conductorStatusLine, needsSignIn } from '../conductor/format.js';
import { useNow } from '../conductor/hooks.js';
import { CONDUCTOR_CONNECTED_NOTICE_MS, CONDUCTOR_UI_TICK_MS } from '../constants.js';
import { ConductorConnectCard } from './ConductorConnectCard.js';
import { CapsuleIcon } from './PokemonPortrait.js';
import { Button } from './ui/Button.js';

interface ConductorEmptyOfficeProps {
  /** Null in a read-only office (it can't change the scope). */
  onOpenSessions: (() => void) | null;
  /** A read-only office can watch but not connect. */
  readOnly: boolean;
}

/**
 * Centred in an office with Conductor on and nobody in it: the Connect card
 * when there is no usable key, "Connected as …" right after connecting, a
 * connection problem, or "No sessions in scope" with the way to widen it.
 * Says that only cloud workspaces appear, the first thing a Conductor user
 * would otherwise suspect.
 */
export function ConductorEmptyOffice({ onOpenSessions, readOnly }: ConductorEmptyOfficeProps) {
  const status = useConductor((s) => s.status);
  const signIn = useConductor((s) => s.signIn);
  const now = useNow(CONDUCTOR_UI_TICK_MS);
  const state = status?.state ?? 'connecting';
  const justConnected =
    signIn?.action === 'connect' &&
    signIn.ok &&
    !needsSignIn(status) &&
    now - signIn.at < CONDUCTOR_CONNECTED_NOTICE_MS;

  let title: string;
  let body: ReactNode;
  if (needsSignIn(status)) {
    title = 'Connect to Conductor';
    body = <ConductorConnectCard readOnly={readOnly} />;
  } else if (justConnected) {
    title = signIn.message ?? 'Connected to Conductor';
    body = (
      <span className="text-xs text-text-muted">
        {state === 'connected'
          ? 'Sessions active in your cloud workspaces walk in here.'
          : conductorStatusLine(status, now)}
      </span>
    );
  } else if (state === 'connected') {
    title = 'No sessions in scope';
    body = (
      <span className="text-xs text-text-muted">
        Sessions active in your cloud workspaces walk in here.
      </span>
    );
  } else {
    title = state === 'connecting' ? 'Connecting to Conductor…' : 'Waiting for Conductor';
    body = <span className="text-xs text-text-muted">{conductorStatusLine(status, now)}</span>;
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 p-16">
      {/* Scrolls rather than clipping in a short window (the Connect card is tall). */}
      <div className="pixel-panel pointer-events-auto flex flex-col items-center gap-8 py-12 px-16 max-w-[460px] max-h-full overflow-y-auto text-center">
        <CapsuleIcon size={32} />
        <span className="text-lg">{title}</span>
        {body}
        {state === 'connected' && onOpenSessions && (
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
