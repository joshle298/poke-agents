import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useLayoutEffect, useState } from 'react';

import type { BattleLogEntry, Toast } from '../conductor/conductorStore.js';
import { conductorStore, useConductor } from '../conductor/conductorStore.js';
import {
  BATTLE_LOG_FADE_MS,
  MESSAGE_BAR_BORDER_PX,
  MESSAGE_BAR_CHIP_GAP_PX,
  MESSAGE_BAR_CHIP_MAX_WIDTH_PX,
  MESSAGE_BAR_COLLAPSE_MS,
  MESSAGE_BAR_MARGIN_PX,
  MESSAGE_BAR_PAD_X_PX,
  MESSAGE_BAR_PAD_Y_PX,
  MESSAGE_BAR_ROW_GAP_PX,
  MESSAGE_BAR_ROW_PX,
  TOAST_VISIBLE_MS,
  TOAST_Z_INDEX,
} from '../constants.js';
import type { BarLine, MessageBarLayout } from './messageBarLayout.js';
import { barLines, messageBarOpen, typedLength } from './messageBarLayout.js';
import { Button } from './ui/Button.js';

const NO_LINES: readonly BattleLogEntry[] = [];

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Each toast leaves TOAST_VISIBLE_MS after it arrived, shown or not (a
 *  narrow bar shows only the newest). */
function useToastExpiry(toasts: readonly Toast[]): void {
  useEffect(() => {
    if (toasts.length === 0) return;
    const now = Date.now();
    const timers = toasts.map((toast) =>
      setTimeout(
        () => conductorStore.dismissToast(toast.seq),
        Math.max(0, toast.at + TOAST_VISIBLE_MS - now),
      ),
    );
    return () => timers.forEach(clearTimeout);
  }, [toasts]);
}

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

/** One battle-log row: the previous line dimmed, or the newest one with its
 *  first `typed` characters showing (the rest keeps its place, unseen, so the
 *  line never reflows as it types). Screen readers get the bar's live region
 *  instead. */
function LogRow({ line, typed }: { line: BarLine; typed?: number }) {
  const chars = typed === undefined ? null : Array.from(line.text);
  return (
    <div
      className={`message-bar-line truncate ${typed === undefined ? 'text-text-muted' : ''}`}
      style={{ height: MESSAGE_BAR_ROW_PX, lineHeight: `${MESSAGE_BAR_ROW_PX}px` }}
      data-fading={line.fading || undefined}
      aria-hidden="true"
    >
      {chars ? (
        <>
          {chars.slice(0, typed).join('')}
          <span className="invisible">{chars.slice(typed).join('')}</span>
        </>
      ) : (
        line.text
      )}
    </div>
  );
}

/** An action outcome as a compact chip. Over the modals' backdrop (its own
 *  z-index: the bar sets none), so an outcome of an action taken in a modal
 *  stays readable. Click it, or its ×, to dismiss it. */
function ToastChip({ toast }: { toast: Toast }) {
  const error = toast.tone === 'error';
  const dismiss = () => conductorStore.dismissToast(toast.seq);
  return (
    <div
      className={`relative flex items-center gap-6 min-w-0 pl-8 bg-btn-bg border-2 text-xs cursor-pointer ${
        error ? 'border-status-error' : 'border-border'
      }`}
      style={{
        height: MESSAGE_BAR_ROW_PX,
        maxWidth: `min(${MESSAGE_BAR_CHIP_MAX_WIDTH_PX}px, 100%)`,
        zIndex: TOAST_Z_INDEX,
      }}
      title={toast.text}
      onClick={dismiss}
    >
      <span role={error ? 'alert' : 'status'} className="flex items-center gap-6 min-w-0">
        <span
          className={`size-6 shrink-0 ${error ? 'bg-status-error' : 'bg-status-success'}`}
          aria-hidden="true"
        />
        <span className="truncate leading-none">{toast.text}</span>
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 leading-none"
        onClick={(e) => {
          e.stopPropagation();
          dismiss();
        }}
        aria-label="Dismiss"
        title="Dismiss"
      >
        ×
      </Button>
    </div>
  );
}

interface MessageBarProps {
  /** Show battle-log lines: the Pokémon theme and Settings' Battle Log on,
   *  not in debug view. Off, the bar opens only while a toast shows. */
  battleLog: boolean;
  /** Rows, chip placement and height for the page (messageBarLayout). */
  layout: MessageBarLayout;
  /** What covers the bar's right end (the upstream card column), CSS px. */
  rightInsetPx: number;
}

/**
 * The message bar: a text box in a strip under the map, like the one under a
 * GBA game's screen, never over the town. It shows the newest battle-log line
 * typing in (click to show it whole; at once with reduced motion) under the
 * one before it, dimmed, each fading out after BATTLE_LOG_VISIBLE_MS, and the
 * outcomes of Conductor actions as chips on its right (messageBarLayout puts
 * them). With the battle log on it always keeps its height, empty between
 * lines; off, it is one row that opens only while a toast shows. The page
 * around it is a flex column, so the map's canvas shrinks by the bar's height.
 */
export function MessageBar({ battleLog, layout, rightInsetPx }: MessageBarProps) {
  const log = useConductor((s) => s.battleLog);
  const toasts = useConductor((s) => s.toasts);
  useToastExpiry(toasts);
  const [skippedSeq, setSkippedSeq] = useState<number | null>(null);
  const { lines, typed } = useBarLines(battleLog ? log : NO_LINES, skippedSeq);
  const open = messageBarOpen(battleLog, toasts.length);
  const chips = toasts.slice(-layout.maxChips);

  const { newest, previous } = lines;
  const newestRow = newest && <LogRow key={newest.seq} line={newest} typed={typed} />;
  const previousRow = previous && <LogRow key={previous.seq} line={previous} />;
  const chipRow = layout.chips === 'top' && chips.length > 0 && (
    <div key="toasts" className="flex justify-end min-w-0" style={{ gap: MESSAGE_BAR_CHIP_GAP_PX }}>
      {chips.map((toast) => (
        <ToastChip key={toast.seq} toast={toast} />
      ))}
    </div>
  );
  // Fixed rows, top to bottom, so nothing moves when a row empties.
  const rows: ReactNode[] =
    layout.rows === 2 ? [chipRow || previousRow, newestRow] : [chipRow || newestRow];

  return (
    <div
      className="message-bar-strip shrink-0 flex flex-col justify-end overflow-hidden bg-bg-dark"
      style={
        {
          height: open ? layout.height : 0,
          paddingRight: rightInsetPx,
          '--message-bar-collapse': `${MESSAGE_BAR_COLLAPSE_MS}ms`,
          '--message-bar-fade': `${BATTLE_LOG_FADE_MS}ms`,
        } as CSSProperties
      }
      data-testid="message-bar"
    >
      <div
        className="message-bar relative shrink-0 flex"
        style={{
          height: layout.height - 2 * MESSAGE_BAR_MARGIN_PX,
          margin: MESSAGE_BAR_MARGIN_PX,
          borderWidth: MESSAGE_BAR_BORDER_PX,
          padding: `${MESSAGE_BAR_PAD_Y_PX}px ${MESSAGE_BAR_PAD_X_PX}px`,
          gap: MESSAGE_BAR_PAD_X_PX,
        }}
      >
        {/* A click shows the typing line whole (the A button). */}
        <div
          className="flex-1 min-w-0 flex flex-col select-none"
          style={{ gap: MESSAGE_BAR_ROW_GAP_PX }}
          onClick={() => newest && setSkippedSeq(newest.seq)}
        >
          {rows.map((row, i) => (
            <div key={i} className="min-w-0" style={{ height: MESSAGE_BAR_ROW_PX }}>
              {row}
            </div>
          ))}
        </div>
        {layout.chips === 'side' && chips.length > 0 && (
          <div
            className="shrink-0 min-w-0 max-w-1/2 flex flex-col items-end justify-end"
            style={{ gap: MESSAGE_BAR_ROW_GAP_PX }}
          >
            {chips.map((toast) => (
              <ToastChip key={toast.seq} toast={toast} />
            ))}
          </div>
        )}
        {battleLog && (
          <span className="sr-only" role="status" aria-live="polite">
            {newest && <span key={newest.seq}>{newest.text}</span>}
          </span>
        )}
      </div>
    </div>
  );
}
