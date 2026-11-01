import type { CSSProperties, FocusEvent, ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { BattleLogEntry, Toast } from '../conductor/conductorStore.js';
import { conductorStore, useConductor } from '../conductor/conductorStore.js';
import {
  BATTLE_LOG_FADE_MS,
  MESSAGE_BAR_CHIP_GAP_PX,
  MESSAGE_BAR_CHIP_LINE_PX,
  MESSAGE_BAR_CHIP_TEXT_PAD_PX,
  MESSAGE_BAR_FRAME_PX,
  MESSAGE_BAR_MARGIN_PX,
  MESSAGE_BAR_MORE_SPACE_PX,
  MESSAGE_BAR_PAD_X_PX,
  MESSAGE_BAR_PAD_Y_PX,
  MESSAGE_BAR_ROW_PX,
  MESSAGE_BAR_TRANSITION_MS,
  TOAST_Z_INDEX,
} from '../constants.js';
import type {
  BarLine,
  BarLines,
  ChipPlacement,
  HeardToasts,
  MessageBarLayout,
  PlacedChip,
} from './messageBarLayout.js';
import {
  barLines,
  liveToasts,
  messageBarStripHeight,
  placeChips,
  toastExpiresAt,
  typedLength,
} from './messageBarLayout.js';
import { Button } from './ui/Button.js';

const NO_LINES: readonly BattleLogEntry[] = [];
const NOTHING_HEARD: HeardToasts = { success: 0, error: 0 };

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** The strip's transitions (index.css reads them). */
const STRIP_STYLE = {
  '--message-bar-transition': `${MESSAGE_BAR_TRANSITION_MS}ms`,
  '--message-bar-fade': `${BATTLE_LOG_FADE_MS}ms`,
} as CSSProperties;

/** The battle-log lines up now, and the clock they were read at: re-read
 *  when a line arrives (before paint), when one starts fading or leaves, and
 *  every frame while the newest is still typing. */
function useBarLines(log: readonly BattleLogEntry[], skippedSeq: number | null) {
  const [now, setNow] = useState(() => Date.now());
  const newestSeq = log.length > 0 ? log[log.length - 1].seq : null;
  useLayoutEffect(() => {
    setNow(Date.now());
  }, [newestSeq]);

  const lines = barLines(log, now);
  const { nextChangeAt, newest } = lines;
  useEffect(() => {
    if (nextChangeAt === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextChangeAt - Date.now()));
    return () => clearTimeout(timer);
  }, [nextChangeAt]);

  const length = newest === null ? 0 : Array.from(newest.text).length;
  const typed =
    newest === null || prefersReducedMotion() || skippedSeq === newest.seq
      ? length
      : typedLength(newest.text, now - newest.at);
  const typing = typed < length;
  useEffect(() => {
    if (!typing) return;
    let frame = requestAnimationFrame(function tick() {
      setNow(Date.now());
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [typing]);

  return { lines, typed };
}

/**
 * The newest line, its first `typed` characters showing; the rest keeps its
 * place unseen, so the line never reflows as it types. It may wrap onto every
 * row it has (pushing the previous line out of the box, as the game's text
 * box scrolls), and gets its ellipsis and its ▼ only once it has typed in.
 */
function NewestLine({ line, typed, maxLines }: { line: BarLine; typed: number; maxLines: number }) {
  const chars = Array.from(line.text);
  const done = typed >= chars.length;
  const clip: CSSProperties = done
    ? { display: '-webkit-box', WebkitLineClamp: maxLines, WebkitBoxOrient: 'vertical' }
    : { maxHeight: maxLines * MESSAGE_BAR_ROW_PX };
  return (
    <div
      className="message-bar-line relative shrink-0 self-start max-w-full"
      style={{ paddingRight: MESSAGE_BAR_MORE_SPACE_PX }}
      data-fading={line.fading || undefined}
    >
      <div className="overflow-hidden break-words" style={clip}>
        {chars.slice(0, typed).join('')}
        <span className="invisible">{chars.slice(typed).join('')}</span>
      </div>
      <span className="message-bar-more" data-shown={done || undefined} />
    </div>
  );
}

/** The battle log's rows: the previous line (dimmed) over the newest, which
 *  may take both. A click shows a typing line whole (the A button). Screen
 *  readers get the bar's live region instead. */
function LogLines({
  lines,
  typed,
  rows,
  onSkip,
}: {
  lines: BarLines;
  typed: number;
  rows: 0 | 1 | 2;
  onSkip: () => void;
}) {
  const { newest, previous } = lines;
  return (
    <div
      className="flex-1 min-w-0 self-end flex flex-col justify-end overflow-hidden select-none"
      style={{ height: rows * MESSAGE_BAR_ROW_PX, lineHeight: `${MESSAGE_BAR_ROW_PX}px` }}
      onClick={onSkip}
      aria-hidden="true"
    >
      {rows === 2 && previous && (
        <div
          key={previous.seq}
          className="message-bar-line shrink-0 truncate"
          data-previous=""
          data-fading={previous.fading || undefined}
        >
          {previous.text}
        </div>
      )}
      {rows > 0 && newest && (
        <NewestLine key={newest.seq} line={newest} typed={typed} maxLines={rows} />
      )}
    </div>
  );
}

/** The text box: the GBA dialog under the Pokémon theme, the panel look
 *  without it (index.css). `ghost` draws only what is inside it (the phone's
 *  chip layer, laid exactly over the bar). `empty` hides it in a strip that
 *  holds only chips, while none shows. */
function BarBox({
  layout,
  ghost = false,
  empty = false,
  children,
}: {
  layout: MessageBarLayout;
  ghost?: boolean;
  empty?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="message-bar shrink-0 text-xl"
      style={
        {
          height: layout.height - 2 * MESSAGE_BAR_MARGIN_PX,
          margin: MESSAGE_BAR_MARGIN_PX,
          '--message-bar-frame': `${MESSAGE_BAR_FRAME_PX}px`,
          '--message-bar-pad-x': `${MESSAGE_BAR_PAD_X_PX}px`,
          '--message-bar-pad-y': `${MESSAGE_BAR_PAD_Y_PX}px`,
        } as CSSProperties
      }
      data-ghost={ghost || undefined}
      data-empty={empty || undefined}
    >
      <div className="relative flex h-full min-w-0" style={{ gap: MESSAGE_BAR_PAD_X_PX }}>
        {children}
      </div>
    </div>
  );
}

/** Each toast leaves at toastExpiresAt, shown or not, unless its chip is
 *  held (the pointer on it, or focus in it). */
function useToastTimers(toasts: readonly Toast[]) {
  const [held, setHeld] = useState<ReadonlySet<number>>(() => new Set());
  const [resumedAt, setResumedAt] = useState<Readonly<Record<number, number>>>({});
  useEffect(() => {
    const now = Date.now();
    const timers = toasts
      .filter((toast) => !held.has(toast.seq))
      .map((toast) =>
        setTimeout(
          () => conductorStore.dismissToast(toast.seq),
          Math.max(0, toastExpiresAt(toast, resumedAt[toast.seq]) - now),
        ),
      );
    return () => timers.forEach(clearTimeout);
  }, [toasts, held, resumedAt]);
  return useCallback((seq: number, on: boolean) => {
    setHeld((prev) => {
      if (prev.has(seq) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(seq);
      else next.delete(seq);
      return next;
    });
    if (!on) setResumedAt((prev) => ({ ...prev, [seq]: Date.now() }));
  }, []);
}

/** An action outcome as a compact chip: a mark in its tone, its text (wrapped
 *  onto the lines it has, the whole of it in its tooltip), and × to dismiss
 *  it (a click anywhere on it does too). The text is aria-hidden: the bar's
 *  live regions read it, and the × is named after it. */
function ToastChip({
  chip,
  onDismiss,
  onHold,
}: {
  chip: PlacedChip<Toast>;
  onDismiss: (seq: number, button: HTMLElement | null) => void;
  onHold: (seq: number, on: boolean) => void;
}) {
  const { toast, rows, lines } = chip;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  useEffect(() => {
    if (!held) return;
    onHold(toast.seq, true);
    return () => onHold(toast.seq, false);
  }, [held, toast.seq, onHold]);

  return (
    <div
      className="message-bar-chip pointer-events-auto relative flex items-center min-w-0 max-w-full text-xs cursor-pointer"
      style={{ height: rows * MESSAGE_BAR_ROW_PX, zIndex: TOAST_Z_INDEX }}
      data-tone={toast.tone}
      data-testid="message-bar-chip"
      title={toast.text}
      onClick={() => onDismiss(toast.seq, null)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
    >
      <span className="message-bar-chip-mark shrink-0" aria-hidden="true" />
      <span
        className="min-w-0 overflow-hidden break-words"
        style={{
          display: '-webkit-box',
          WebkitLineClamp: lines,
          WebkitBoxOrient: 'vertical',
          lineHeight: `${MESSAGE_BAR_CHIP_LINE_PX}px`,
          paddingBottom: MESSAGE_BAR_CHIP_TEXT_PAD_PX,
        }}
        aria-hidden="true"
      >
        {toast.text}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 self-stretch w-24! h-auto! text-base leading-none"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(toast.seq, e.currentTarget);
        }}
        aria-label={`Dismiss: ${toast.text}`}
        data-toast-dismiss=""
      >
        ×
      </Button>
    </div>
  );
}

/**
 * The chips (placeChips), in a column beside the lines or along the top of
 * the box. Times every toast out, held or not; dismissing with the keyboard
 * moves focus to the next chip, or back to where it came from.
 */
function ToastChips({
  toasts,
  placement,
  layout,
}: {
  toasts: readonly Toast[];
  placement: ChipPlacement<Toast>;
  layout: MessageBarLayout;
}) {
  const onHold = useToastTimers(toasts);
  const containerRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onDismiss = useCallback((seq: number, button: HTMLElement | null) => {
    let next: HTMLElement | null = null;
    const container = containerRef.current;
    if (button && container && document.activeElement === button) {
      const buttons = Array.from(container.querySelectorAll<HTMLElement>('[data-toast-dismiss]'));
      const at = buttons.indexOf(button);
      next = buttons[at + 1] ?? buttons[at - 1] ?? returnFocusRef.current;
    }
    conductorStore.dismissToast(seq);
    if (next?.isConnected) next.focus();
  }, []);
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const from = e.relatedTarget;
    if (from instanceof HTMLElement && !e.currentTarget.contains(from)) {
      returnFocusRef.current = from;
    }
  };

  const chips = placement.chips.map((chip) => (
    <ToastChip key={chip.toast.seq} chip={chip} onDismiss={onDismiss} onHold={onHold} />
  ));
  return layout.chips === 'side' ? (
    <div
      ref={containerRef}
      className="shrink-0 min-w-0 max-w-1/2 flex flex-col items-end justify-end"
      onFocus={onFocus}
    >
      {chips}
    </div>
  ) : (
    <div
      ref={containerRef}
      className="absolute top-0 inset-x-0 flex justify-end"
      style={{ gap: MESSAGE_BAR_CHIP_GAP_PX }}
      onFocus={onFocus}
    >
      {chips}
    </div>
  );
}

interface MessageBarProps {
  /** Show battle-log lines: the Pokémon theme and Settings' Battle Log on,
   *  not in debug view. */
  battleLog: boolean;
  /** Conductor action outcomes can arrive (a tokened Conductor office):
   *  without the battle log the strip keeps a row for them. */
  notices: boolean;
  /** Rows, chip placement and height for the page (messageBarLayout). */
  layout: MessageBarLayout;
  /** What covers the bar's right end (the upstream card column), CSS px. */
  rightInsetPx: number;
  /** Phones: MessageBarChipLayer draws the chips outside the sliding track,
   *  over the room this bar keeps for them. */
  chipsElsewhere?: boolean;
}

/**
 * The message bar: a text box in a strip under the map, like the one under a
 * GBA game's screen, never over the town. It shows the newest battle-log line
 * typing in (click to show it whole; at once with reduced motion) under the
 * one before it, dimmed, each fading out after BATTLE_LOG_VISIBLE_MS, and the
 * outcomes of Conductor actions as chips (placeChips). The page around it is a
 * flex column, so the map's canvas shrinks by the strip's height, which only
 * Settings changes (messageBarStripHeight). Its live regions read the newest
 * line, success and error.
 */
export function MessageBar({
  battleLog,
  notices,
  layout,
  rightInsetPx,
  chipsElsewhere = false,
}: MessageBarProps) {
  const log = useConductor((s) => s.battleLog);
  const toasts = useConductor((s) => s.toasts);
  const [skippedSeq, setSkippedSeq] = useState<number | null>(null);
  const { lines, typed } = useBarLines(battleLog ? log : NO_LINES, skippedSeq);
  const placement = placeChips(toasts, layout, battleLog);
  // Toasts up when the bar mounts were read out by the bar before it.
  const [heard, setHeard] = useState(() => liveToasts(toasts, NOTHING_HEARD).heard);
  const live = liveToasts(toasts, heard);
  if (live.heard !== heard) setHeard(live.heard);
  const newest = lines.newest;

  return (
    <div
      className="message-bar-strip shrink-0 flex flex-col justify-end overflow-hidden bg-bg-dark"
      style={{
        ...STRIP_STYLE,
        height: messageBarStripHeight(layout, { battleLog, notices, toastCount: toasts.length }),
        paddingRight: rightInsetPx,
      }}
      data-testid="message-bar"
    >
      <BarBox layout={layout} empty={!battleLog && placement.chips.length === 0}>
        {battleLog ? (
          <LogLines
            lines={lines}
            typed={typed}
            rows={placement.logRows}
            onSkip={() => newest && setSkippedSeq(newest.seq)}
          />
        ) : (
          <div className="flex-1" />
        )}
        {!chipsElsewhere && <ToastChips toasts={toasts} placement={placement} layout={layout} />}
      </BarBox>
      {battleLog && (
        <span className="sr-only" role="status" aria-live="polite">
          {newest && <span key={newest.seq}>{newest.text}</span>}
        </span>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {live.status && <span key={live.status.seq}>{live.status.text}</span>}
      </span>
      <span className="sr-only" role="alert">
        {live.alert && <span key={live.alert.seq}>{live.alert.text}</span>}
      </span>
    </div>
  );
}

/**
 * Phones: the bar's chips, outside the sliding track (its transform would
 * keep them under the modals, and off-screen on the terminal page), laid over
 * the bar at the bottom of the office page, which keeps their room. Above the
 * modals (TOAST_Z_INDEX); `hidden` while the Pokédex sheet covers the bar (it
 * shows its own action outcomes).
 */
export function MessageBarChipLayer({
  battleLog,
  notices,
  layout,
  hidden,
}: {
  battleLog: boolean;
  notices: boolean;
  layout: MessageBarLayout;
  hidden: boolean;
}) {
  const toasts = useConductor((s) => s.toasts);
  return (
    <div
      className="message-bar-strip absolute inset-x-0 bottom-0 flex flex-col justify-end overflow-hidden pointer-events-none"
      style={{
        ...STRIP_STYLE,
        height: messageBarStripHeight(layout, { battleLog, notices, toastCount: toasts.length }),
        zIndex: TOAST_Z_INDEX,
        visibility: hidden ? 'hidden' : undefined,
      }}
    >
      <BarBox layout={layout} ghost>
        <div className="flex-1" />
        <ToastChips
          toasts={toasts}
          placement={placeChips(toasts, layout, battleLog)}
          layout={layout}
        />
      </BarBox>
    </div>
  );
}
