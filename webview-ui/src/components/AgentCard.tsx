import type { MouseEvent as ReactMouseEvent } from 'react';

import type { PartyCondition, PartySlot } from '../conductor/party.js';
import { conditionBadge, needsAttention } from '../conductor/party.js';
import { PARTY_CHILD_INDENT_PX, PORTRAIT_SOURCE_PX } from '../constants.js';
import type { CardVariant } from './cardBar.js';
import { CharacterMugShot } from './CharacterMugShot.js';
import { HpBar } from './HpBar.js';
import { PokemonPortrait } from './PokemonPortrait.js';
import { Button } from './ui/Button.js';

/** How a given agent's character looks, for the tab mug shot. */
export interface AgentAppearance {
  palette: number;
  hueShift: number;
}

/** Agent activity reflected by the tab's status dot. */
export type AgentActivity = 'idle' | 'working' | 'attention';

/** Activity plus the drawer-owned "connection broken" state, and a stream
 *  session that errored (fainted). */
export type TabStatus = AgentActivity | 'disconnected' | 'error';

/** Modifier state of a card or character click: ⌘/Ctrl-click and
 *  double-click open a stream agent's session in its own app. */
export interface SelectMods {
  meta: boolean;
  double: boolean;
}

const STATUS_DOT: Record<TabStatus, string> = {
  idle: 'bg-status-success', // green — turn complete, nothing pending
  working: 'bg-accent-bright', // blue — actively running
  attention: 'bg-status-permission', // yellow — needs permission or input
  disconnected: 'bg-status-error', // red — terminal socket dropped
  error: 'bg-status-error', // red — the session errored
};

const CONDITION_DOT: Record<PartyCondition, string> = {
  working: 'bg-status-active',
  needsYou: 'bg-status-permission',
  done: 'bg-status-success',
  asleep: 'bg-status-asleep',
  error: 'bg-status-error',
};

const CONDITION_LABEL: Record<PartyCondition, string> = {
  working: 'Working',
  needsYou: 'Needs you',
  done: 'Done',
  asleep: 'Asleep',
  error: 'Fainted',
};

const BADGE_CLASS: Record<string, string> = {
  SLP: 'text-text-muted',
  FNT: 'text-status-error',
  '!': 'text-accent',
};

const CARD_VARIANT: Record<CardVariant, string> = {
  default: 'bg-btn-bg border-transparent hover:bg-btn-hover',
  focused: 'bg-active-bg border-transparent',
  active: 'bg-active-bg border-accent',
};

interface AgentCardProps {
  agentId: number;
  variant: CardVariant;
  appearance: AgentAppearance;
  status: TabStatus | null;
  /** When false the × is invisible (not removed — the card keeps its width so
   *  the bar doesn't reflow). Mobile only shows it on the active terminal tab
   *  to keep a stray tap from killing an agent. */
  showClose?: boolean;
  /** Party slot content (Pokémon theme). Absent = the upstream mug-shot card. */
  slot?: PartySlot | null;
  /** Party slot with the portrait only (narrow windows, mobile). */
  compact?: boolean;
  /** Hover text for the card (defaults to "Agent N"). */
  title?: string;
  /** Tooltip of the × (defaults by agent kind: hide a Conductor session,
   *  close anything else). */
  closeTitle?: string;
  onSelect: (agentId: number, mods?: SelectMods) => void;
  onClose: (agentId: number) => void;
}

function clickMods(e: ReactMouseEvent, double: boolean): SelectMods {
  return { meta: e.metaKey || e.ctrlKey, double };
}

/** One agent's card. Upstream: mug shot beside a close-button/status-dot
 *  column, doubling as the terminal panel's tab. Under the Pokémon theme a
 *  party slot: portrait, nickname, Lv, HP and a status badge; it blinks while
 *  its session needs you. */
export function AgentCard({
  agentId,
  variant,
  appearance,
  status,
  showClose = true,
  slot,
  compact = false,
  title,
  closeTitle: closeTitleProp,
  onSelect,
  onClose,
}: AgentCardProps) {
  const closeTitle = closeTitleProp ?? (slot?.isStream ? 'Hide session' : 'Close agent');
  const closeButton = (
    <Button
      variant="ghost"
      size="icon"
      onClick={(e) => {
        // Don't also select the tab we're about to remove.
        e.stopPropagation();
        onClose(agentId);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      title={closeTitle}
      className={`leading-none ${showClose ? '' : 'invisible'}`}
    >
      ×
    </Button>
  );

  if (!slot) {
    return (
      <div
        className={`pointer-events-auto flex items-stretch gap-1 p-1 cursor-pointer border-2 shrink-0 ${CARD_VARIANT[variant]}`}
        onClick={(e) => onSelect(agentId, clickMods(e, false))}
        onDoubleClick={(e) => onSelect(agentId, clickMods(e, true))}
        title={title ?? `Agent ${agentId}`}
      >
        <CharacterMugShot palette={appearance.palette} hueShift={appearance.hueShift} />
        {/* Close on top, status dot at the bottom, both centred over the
            same column beside the mug shot. */}
        <div className="flex flex-col items-center justify-between shrink-0">
          {closeButton}
          {/* 1px left: optically centres the solid square under the pixel-font ×
              glyph, which sits a hair left in its cell. mb (not pb) lifts it off
              the card's bottom edge: the span is a fixed-size empty box, so
              padding is invisible — only margin moves it. */}
          <span
            className={`size-6 shrink-0 relative -left-1 mb-2 ${status ? STATUS_DOT[status] : ''}`}
          />
        </div>
      </div>
    );
  }

  const badge = conditionBadge(slot.condition);
  const attention = needsAttention(slot.condition) ? 'party-attention' : '';
  const statusLabel = slot.condition ? CONDITION_LABEL[slot.condition] : '';
  const hoverText = [
    slot.nickname,
    slot.speciesName,
    slot.level !== undefined ? `Lv ${slot.level}` : undefined,
    statusLabel,
  ]
    .filter(Boolean)
    .join(' · ');
  const dot = (
    <span
      className={`inline-block size-6 shrink-0 ${slot.condition ? CONDITION_DOT[slot.condition] : ''}`}
      aria-label={statusLabel || undefined}
    />
  );
  const portrait = (
    <PokemonPortrait
      url={slot.portraitUrl}
      size={PORTRAIT_SOURCE_PX}
      alt={slot.speciesName ?? ''}
      fallback={<CharacterMugShot palette={appearance.palette} hueShift={appearance.hueShift} />}
    />
  );

  if (compact) {
    return (
      <div
        className={`pointer-events-auto flex items-stretch gap-1 p-1 cursor-pointer border-2 shrink-0 ${CARD_VARIANT[variant]} ${attention}`}
        onClick={(e) => onSelect(agentId, clickMods(e, false))}
        onDoubleClick={(e) => onSelect(agentId, clickMods(e, true))}
        title={hoverText}
      >
        {portrait}
        <div className="flex flex-col items-center justify-between shrink-0">
          {closeButton}
          <span className="relative -left-1 mb-2">{dot}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`pointer-events-auto flex items-center gap-4 p-2 cursor-pointer border-2 min-w-0 ${CARD_VARIANT[variant]} ${attention}`}
      style={{ marginLeft: slot.depth * PARTY_CHILD_INDENT_PX }}
      onClick={(e) => onSelect(agentId, clickMods(e, false))}
      onDoubleClick={(e) => onSelect(agentId, clickMods(e, true))}
      title={hoverText}
    >
      {portrait}
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex items-baseline gap-4 min-w-0">
          {slot.depth > 0 && (
            <span className="text-2xs text-text-muted leading-none" aria-hidden="true">
              ↳
            </span>
          )}
          <span className="text-sm leading-none truncate min-w-0">{slot.nickname}</span>
        </div>
        <div className="flex items-center gap-4 text-2xs leading-none text-text-muted">
          {slot.level !== undefined && <span className="shrink-0">Lv{slot.level}</span>}
          {slot.speciesName && <span className="truncate min-w-0">{slot.speciesName}</span>}
        </div>
        {slot.hp !== null && <HpBar fraction={slot.hp} widthPx={64} heightPx={3} />}
      </div>
      <div className="flex flex-col items-center justify-between self-stretch shrink-0 gap-2">
        {closeButton}
        {badge ? (
          <span className={`text-2xs leading-none ${BADGE_CLASS[badge] ?? ''}`}>{badge}</span>
        ) : (
          dot
        )}
      </div>
    </div>
  );
}
