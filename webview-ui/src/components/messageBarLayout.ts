import {
  BATTLE_LOG_FADE_MS,
  BATTLE_LOG_VISIBLE_MS,
  MESSAGE_BAR_BORDER_PX,
  MESSAGE_BAR_MARGIN_PX,
  MESSAGE_BAR_PAD_Y_PX,
  MESSAGE_BAR_ROW_GAP_PX,
  MESSAGE_BAR_ROW_PX,
  MESSAGE_BAR_SIDE_CHIPS_MIN_PX,
  MESSAGE_BAR_TWO_ROWS_MIN_PAGE_PX,
  MESSAGE_BAR_TYPE_MAX_MS,
  MESSAGE_BAR_TYPE_MS_PER_CHAR,
  TOAST_MAX_VISIBLE,
} from '../constants.js';

/**
 * The message bar's rules (DOM-free; MessageBar renders them): its size and
 * where the chips go, which battle-log lines show and when they fade, and the
 * typewriter reveal of the newest line.
 */

export interface MessageBarLayout {
  /** Rows of text: the previous battle-log line (dimmed) over the newest, or
   *  just the newest on a short office page; one row of chips without the
   *  battle log. */
  rows: 1 | 2;
  /** Where action toasts go: a column beside the lines, one chip per row, or
   *  along the top row (in place of the previous line; of the newest on one
   *  row), as many side by side as `maxChips`. */
  chips: 'side' | 'top';
  /** How many chips show at once (the newest ones). */
  maxChips: number;
  /** The open bar's height, CSS px: its margin, frame, padding and rows. */
  height: number;
}

/** The open bar's height for `rows` rows of text. */
export function messageBarHeight(rows: 1 | 2): number {
  return (
    2 * (MESSAGE_BAR_MARGIN_PX + MESSAGE_BAR_BORDER_PX + MESSAGE_BAR_PAD_Y_PX) +
    rows * MESSAGE_BAR_ROW_PX +
    (rows - 1) * MESSAGE_BAR_ROW_GAP_PX
  );
}

/**
 * The bar's layout for an office page (the map and the bar) `height` tall
 * whose bar is `width` wide. With the battle log: two rows (one on a short
 * page), the chips in a column beside them, or over the top row of a narrow
 * bar (one chip). Without it the bar holds only chips: one row, two side by
 * side (one on a narrow bar). Unmeasured (0) reads as roomy.
 */
export function messageBarLayout(
  page: { width: number; height: number },
  battleLog: boolean,
): MessageBarLayout {
  const narrow = page.width > 0 && page.width < MESSAGE_BAR_SIDE_CHIPS_MIN_PX;
  if (!battleLog) {
    const maxChips = narrow ? 1 : TOAST_MAX_VISIBLE;
    return { rows: 1, chips: 'top', maxChips, height: messageBarHeight(1) };
  }
  const rows = page.height > 0 && page.height < MESSAGE_BAR_TWO_ROWS_MIN_PAGE_PX ? 1 : 2;
  return narrow
    ? { rows, chips: 'top', maxChips: 1, height: messageBarHeight(rows) }
    : { rows, chips: 'side', maxChips: rows, height: messageBarHeight(rows) };
}

/**
 * Whether the bar takes its height under the map: always while it shows the
 * battle log (an empty bar between lines, so the map never jumps), else only
 * while a toast shows. Closed, it has no height and the map gets the room.
 */
export function messageBarOpen(battleLog: boolean, toastCount: number): boolean {
  return battleLog || toastCount > 0;
}

/** A battle-log entry (the conductor store's BattleLogEntry). */
interface LogEntry {
  seq: number;
  text: string;
  at: number;
}

export interface BarLine extends LogEntry {
  /** In its last BATTLE_LOG_FADE_MS: fading out. */
  fading: boolean;
}

export interface BarLines {
  /** The newest line, until BATTLE_LOG_VISIBLE_MS after it arrived. */
  newest: BarLine | null;
  /** The line before it, while that is still up itself (shown dimmed). */
  previous: BarLine | null;
  /** When the next line starts fading or leaves, if any is up. */
  nextChangeAt: number | null;
}

/** Which battle-log lines the bar shows at `now`. Each line keeps its own
 *  timing from when it arrived: up for BATTLE_LOG_VISIBLE_MS, fading over
 *  the last BATTLE_LOG_FADE_MS of that. */
export function barLines(log: readonly LogEntry[], now: number): BarLines {
  const fadeAt = (entry: LogEntry) => entry.at + BATTLE_LOG_VISIBLE_MS - BATTLE_LOG_FADE_MS;
  const goneAt = (entry: LogEntry) => entry.at + BATTLE_LOG_VISIBLE_MS;
  const line = (entry: LogEntry | undefined): BarLine | null =>
    entry && now < goneAt(entry) ? { ...entry, fading: now >= fadeAt(entry) } : null;
  const newest = line(log[log.length - 1]);
  const previous = newest ? line(log[log.length - 2]) : null;
  const changes = [newest, previous]
    .filter((l): l is BarLine => l !== null)
    .map((l) => (l.fading ? goneAt(l) : fadeAt(l)));
  return { newest, previous, nextChangeAt: changes.length > 0 ? Math.min(...changes) : null };
}

/** How long the typewriter takes over a line of `chars` characters. */
export function typeDurationMs(chars: number): number {
  return Math.min(chars * MESSAGE_BAR_TYPE_MS_PER_CHAR, MESSAGE_BAR_TYPE_MAX_MS);
}

/** How many characters (code points, so an accent or emoji is never split) of
 *  `text` the typewriter shows `elapsedMs` after the line arrived. */
export function typedLength(text: string, elapsedMs: number): number {
  const chars = Array.from(text).length;
  const duration = typeDurationMs(chars);
  if (elapsedMs >= duration) return chars;
  if (elapsedMs <= 0) return 0;
  return Math.floor((chars * elapsedMs) / duration);
}
