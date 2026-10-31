import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';

import { useConductor } from '../conductor/conductorStore.js';
import {
  BATTLE_LOG_FADE_MS,
  BATTLE_LOG_MAX_WIDTH_PX,
  BATTLE_LOG_VISIBLE_MS,
} from '../constants.js';

interface BattleLogProps {
  /** Distance from the office region's bottom edge, in CSS px. */
  bottomPx: number;
}

type Phase = 'shown' | 'fading' | 'hidden';

/**
 * The battle log: the newest office event ("Pikachu used Bash!") as a
 * one-line GBA dialog at the bottom centre of the office, fading out after
 * BATTLE_LOG_VISIBLE_MS. The store keeps the last BATTLE_LOG_CAPACITY events.
 */
export function BattleLog({ bottomPx }: BattleLogProps) {
  const latest = useConductor((s) => s.battleLog[s.battleLog.length - 1]);
  const [phase, setPhase] = useState<Phase>('hidden');

  useEffect(() => {
    if (!latest) return;
    const age = Math.max(0, Date.now() - latest.at);
    if (age >= BATTLE_LOG_VISIBLE_MS) {
      setPhase('hidden');
      return;
    }
    setPhase('shown');
    const fade = setTimeout(
      () => setPhase('fading'),
      Math.max(0, BATTLE_LOG_VISIBLE_MS - BATTLE_LOG_FADE_MS - age),
    );
    const hide = setTimeout(() => setPhase('hidden'), BATTLE_LOG_VISIBLE_MS - age);
    return () => {
      clearTimeout(fade);
      clearTimeout(hide);
    };
  }, [latest]);

  if (!latest || phase === 'hidden') return null;

  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 z-15 pointer-events-none select-none"
      style={{ bottom: bottomPx, maxWidth: `min(${BATTLE_LOG_MAX_WIDTH_PX}px, calc(100% - 24px))` }}
      role="status"
      aria-live="polite"
    >
      <div
        className="battle-log py-6 px-14 text-base whitespace-nowrap overflow-hidden text-ellipsis"
        style={
          {
            opacity: phase === 'fading' ? 0 : 1,
            '--battle-log-fade': `${BATTLE_LOG_FADE_MS}ms`,
          } as CSSProperties
        }
      >
        {latest.text}
      </div>
    </div>
  );
}
