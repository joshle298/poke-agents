import { hpTone } from '../conductor/party.js';

const TONE_FILL = {
  high: 'bg-hp-high',
  mid: 'bg-hp-mid',
  low: 'bg-hp-low',
} as const;

interface HpBarProps {
  /** Context left, 0..1. */
  fraction: number;
  /** Bar track width in CSS px. */
  widthPx: number;
  heightPx?: number;
  /** Show the "HP" tag before the bar, GBA style. */
  showTag?: boolean;
}

/** A Pokémon-style HP bar: context left, green above half, yellow from a
 *  fifth, red below. */
export function HpBar({ fraction, widthPx, heightPx = 4, showTag = true }: HpBarProps) {
  const pct = Math.round(fraction * 100);
  return (
    <span className="inline-flex items-center gap-3" title={`HP ${pct}% (context left)`}>
      {showTag && <span className="text-2xs leading-none text-accent">HP</span>}
      <span
        className="relative inline-block bg-hp-bg border border-border shrink-0"
        style={{ width: widthPx, height: heightPx + 2 }}
      >
        <span
          className={`absolute left-0 top-0 bottom-0 ${TONE_FILL[hpTone(fraction)]}`}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}
