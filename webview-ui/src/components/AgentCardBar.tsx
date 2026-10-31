import { useSleepClock } from '../conductor/hooks.js';
import type { PartySlot } from '../conductor/party.js';
import {
  CONDUCTOR_UI_TICK_MS,
  PARTY_BAR_COMPACT_WIDTH_PX,
  PARTY_BAR_WIDE_WIDTH_PX,
  TERMINAL_SIDEBAR_WIDTH_PX,
} from '../constants.js';
import type { AgentAppearance, SelectMods, TabStatus } from './AgentCard.js';
import { AgentCard } from './AgentCard.js';
import { cardVariant } from './cardBar.js';

/** 'overlay' = the upstream card column drawn over the office's right edge;
 *  'wide' / 'compact' = the Pokémon party bar, in flow beside the office,
 *  with full slots or portraits only. */
export type CardBarLayout = 'overlay' | 'wide' | 'compact';

interface AgentCardBarProps {
  /** Agents to show, top to bottom. */
  agentIds: number[];
  /** The agent whose terminal pane is showing (standalone). Its card gets the
   *  accent border. */
  activeAgentId?: number | null;
  /** The agent whose character is selected in the office. Its card gets the
   *  active background; `activeAgentId` wins when both name the same agent. */
  focusedAgentId?: number | null;
  getAppearance: (agentId: number) => AgentAppearance;
  statusFor: (agentId: number) => TabStatus | null;
  onSelect: (agentId: number, mods?: SelectMods) => void;
  onClose: (agentId: number) => void;
  layout?: CardBarLayout;
  /** Party slot per agent (party layouts), as of `now` (asleep is
   *  time-derived; the bar keeps its own clock). */
  slotFor?: (agentId: number, now: number) => PartySlot | null;
  /** Hover text per agent (overlay layout; defaults to "Agent N"). */
  titleFor?: (agentId: number) => string | undefined;
  /** Tooltip of each card's × ("Hide session" for Conductor agents). */
  closeTitleFor?: (agentId: number) => string;
}

/**
 * The column of agent cards along the office's right edge, shared by both
 * desktop hosts.
 *
 * Overlay layout (upstream look): transparent and borderless, drawn on top of
 * the office space — the negative margin exactly cancels the column's width,
 * so it takes no layout room. Pointer events pass through the empty parts so
 * the office stays clickable underneath; only the cards are interactive.
 *
 * Party layouts (Pokémon theme): an in-flow column, so the office reflows
 * beside it instead of being covered by the wider slots.
 *
 * In standalone, TerminalDrawer owns the bar and the cards double as the
 * terminal panel's tabs (the panel opens to the bar's right). In VS Code the
 * bar stands alone and lists every agent in the office, external sessions
 * included; a card click raises that agent's editor terminal via focusAgent.
 */
export function AgentCardBar({
  agentIds,
  activeAgentId = null,
  focusedAgentId = null,
  getAppearance,
  statusFor,
  onSelect,
  onClose,
  layout = 'overlay',
  slotFor,
  titleFor,
  closeTitleFor,
}: AgentCardBarProps) {
  const now = useSleepClock(CONDUCTOR_UI_TICK_MS, layout !== 'overlay' && slotFor !== undefined);
  if (agentIds.length === 0) return null;

  if (layout === 'overlay') {
    return (
      <div
        className="relative z-30 h-full shrink-0 flex flex-col items-center gap-4 pt-4 overflow-y-auto pointer-events-none"
        style={{ width: TERMINAL_SIDEBAR_WIDTH_PX, marginLeft: -TERMINAL_SIDEBAR_WIDTH_PX }}
      >
        {agentIds.map((agentId) => (
          <AgentCard
            key={agentId}
            agentId={agentId}
            variant={cardVariant(agentId, { activeId: activeAgentId, focusedId: focusedAgentId })}
            appearance={getAppearance(agentId)}
            status={statusFor(agentId)}
            title={titleFor?.(agentId)}
            closeTitle={closeTitleFor?.(agentId)}
            onSelect={onSelect}
            onClose={onClose}
          />
        ))}
      </div>
    );
  }

  const wide = layout === 'wide';
  return (
    <div
      className={`relative z-30 h-full shrink-0 flex flex-col gap-4 p-4 overflow-y-auto overflow-x-hidden pixel-scrollbar bg-bg-dark border-l-2 border-border ${
        wide ? 'items-stretch' : 'items-center'
      }`}
      style={{ width: wide ? PARTY_BAR_WIDE_WIDTH_PX : PARTY_BAR_COMPACT_WIDTH_PX }}
      aria-label="Party"
    >
      {agentIds.map((agentId) => (
        <AgentCard
          key={agentId}
          agentId={agentId}
          variant={cardVariant(agentId, { activeId: activeAgentId, focusedId: focusedAgentId })}
          appearance={getAppearance(agentId)}
          status={statusFor(agentId)}
          slot={slotFor?.(agentId, now) ?? null}
          compact={!wide}
          closeTitle={closeTitleFor?.(agentId)}
          onSelect={onSelect}
          onClose={onClose}
        />
      ))}
    </div>
  );
}
