import type { ReactNode } from 'react';

import { useConductor } from '../conductor/conductorStore.js';
import { CLOUD_ONLY_NOTE, conductorStatusLine, needsSignIn } from '../conductor/format.js';
import { useNow } from '../conductor/hooks.js';
import { CONDUCTOR_UI_TICK_MS } from '../constants.js';
import { PokeBallIcon } from './PokemonPortrait.js';
import { Button } from './ui/Button.js';

interface ConductorEmptyOfficeProps {
  /** Null in a read-only office (it can't change the scope). */
  onOpenSessions: (() => void) | null;
}

/**
 * Centred in an office with Conductor on and nobody in it: the sign-in steps
 * when there is no usable token, a connection problem, or "No sessions in
 * scope" with the way to widen it. Says that only cloud workspaces appear,
 * the first thing a Conductor user would otherwise suspect.
 */
export function ConductorEmptyOffice({ onOpenSessions }: ConductorEmptyOfficeProps) {
  const status = useConductor((s) => s.status);
  const now = useNow(CONDUCTOR_UI_TICK_MS);
  const state = status?.state ?? 'connecting';

  let title: string;
  let body: ReactNode;
  if (needsSignIn(status)) {
    title = state === 'unauthorized' ? 'Conductor sign-in rejected' : 'Sign in to Conductor';
    body = (
      <ol className="m-0 pl-20 flex flex-col gap-4 text-xs text-left">
        <li>
          Run <span className="text-accent">conductor auth login</span>, or set CONDUCTOR_API_KEY.
        </li>
        <li>Restart Poke Agents.</li>
      </ol>
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
      <div className="pixel-panel pointer-events-auto flex flex-col items-center gap-8 py-12 px-16 max-w-[420px] text-center">
        <PokeBallIcon size={32} />
        <span className="text-lg">{title}</span>
        {body}
        {state === 'connected' && onOpenSessions && (
          <Button size="md" variant="accent" onClick={onOpenSessions}>
            Open Sessions
          </Button>
        )}
        <span className="text-2xs text-text-muted">{CLOUD_ONLY_NOTE}</span>
      </div>
    </div>
  );
}
