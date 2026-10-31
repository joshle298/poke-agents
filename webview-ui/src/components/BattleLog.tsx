import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';

import { useConductor } from '../conductor/conductorStore.js';
import {
  BATTLE_LOG_FADE_MS,
  BATTLE_LOG_MAX_WIDTH_PX,
  BATTLE_LOG_VISIBLE_MS,
  EDITOR_PALETTE_EDGE_PX,
} from '../constants.js';
import type { BoxSize } from '../hooks/useBoxSize.js';
import { useBoxSize } from '../hooks/useBoxSize.js';
import type { Rect } from './topBarLayout.js';
import { placeBattleLog } from './topBarLayout.js';

interface BattleLogProps {
  /** What covers the office's right edge, as a CSS length (the Pokédex
   *  drawer, the upstream card column): the log centres in the rest. */
  rightInset: string;
  /** What the log keeps clear of, in the office's coordinates: the desktop
   *  top bar's pieces (none on phones). */
  obstacles: readonly Rect[];
  /** The layout editor's palette while it is open (in the office's
   *  bottom-left corner, EDITOR_PALETTE_EDGE_PX in), else null. */
  palette: BoxSize | null;
}

type Phase = 'shown' | 'fading' | 'hidden';

/**
 * The battle log: the newest office event ("Pikachu used Bash!") as a
 * one-line GBA dialog centred in the lower part of the office, a quarter of
 * its height above the bottom edge (BATTLE_LOG_BOTTOM_FRACTION), fading out
 * after BATTLE_LOG_VISIBLE_MS. It moves above the layout editor's palette and
 * below the top bar when those reach that spot, and hides while no spot
 * between them is clear (`placeBattleLog`). The store keeps the last
 * BATTLE_LOG_CAPACITY events.
 */
export function BattleLog({ rightInset, obstacles, palette }: BattleLogProps) {
  const latest = useConductor((s) => s.battleLog[s.battleLog.length - 1]);
  const [phase, setPhase] = useState<Phase>('hidden');
  const [areaRef, area] = useBoxSize<HTMLDivElement>();
  const [logRef, log] = useBoxSize<HTMLDivElement>();

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

  const paletteRect: Rect | null =
    palette && palette.height > 0
      ? {
          left: EDITOR_PALETTE_EDGE_PX,
          top: area.height - EDITOR_PALETTE_EDGE_PX - palette.height,
          right: EDITOR_PALETTE_EDGE_PX + palette.width,
          bottom: area.height - EDITOR_PALETTE_EDGE_PX,
        }
      : null;
  // Null until both boxes are measured (the same commit, before the first
  // paint), and while nowhere is clear.
  const top = placeBattleLog({
    areaWidth: area.width,
    areaHeight: area.height,
    logWidth: log.width,
    logHeight: log.height,
    obstacles: paletteRect ? [...obstacles, paletteRect] : obstacles,
  });

  return (
    <div
      ref={areaRef}
      className="absolute top-0 bottom-0 left-0 z-15 pointer-events-none select-none"
      style={{ right: rightInset }}
    >
      <div
        className="absolute left-0 right-0 flex justify-center"
        style={{ top: top ?? 0, visibility: top === null ? 'hidden' : undefined }}
        role="status"
        aria-live="polite"
      >
        <div
          ref={logRef}
          className="battle-log min-w-0 py-6 px-14 text-base whitespace-nowrap overflow-hidden text-ellipsis"
          style={
            {
              maxWidth: `min(${BATTLE_LOG_MAX_WIDTH_PX}px, calc(100% - 24px))`,
              opacity: phase === 'fading' ? 0 : 1,
              '--battle-log-fade': `${BATTLE_LOG_FADE_MS}ms`,
            } as CSSProperties
          }
        >
          {latest.text}
        </div>
      </div>
    </div>
  );
}
