import {
  BATTLE_LOG_FADE_MS,
  BATTLE_LOG_VISIBLE_MS,
  MESSAGE_BAR_CHIP_BORDER_PX,
  MESSAGE_BAR_CHIP_LINE_PX,
  MESSAGE_BAR_CHIP_TEXT_PAD_PX,
  MESSAGE_BAR_FRAME_PX,
  MESSAGE_BAR_MARGIN_PX,
  MESSAGE_BAR_PAD_Y_PX,
  MESSAGE_BAR_ROW_PX,
  MESSAGE_BAR_SIDE_CHIPS_MIN_PX,
  MESSAGE_BAR_TWO_ROWS_MIN_PAGE_PX,
  MESSAGE_BAR_TYPE_MAX_MS,
  MESSAGE_BAR_TYPE_MS_PER_CHAR,
  TOAST_ERROR_VISIBLE_MS,
  TOAST_RESUME_MS,
  TOAST_VISIBLE_MS,
} from '../constants.js';

/**
 * The message bar's rules (DOM-free; MessageBar renders them): its size, which
 * toasts show as chips and where, which battle-log lines show and when they
 * fade, the typewriter reveal of the newest line, and when a toast leaves.
 */

export interface MessageBarLayout {
  /** Rows of the text box: the previous battle-log line over the newest (or
   *  the newest wrapped onto both), or one row on a short office page; one
   *  row of chips without the battle log. */
  rows: 1 | 2;
  /** Where action toasts go: a column beside the lines, or over the lines
   *  (narrow bars, and the bar without the battle log). */
  chips: 'side' | 'over';
  /** How many chips show at once. */
  maxChips: number;
  /** The open bar's height, CSS px: its margin, frame, padding and rows. */
  height: number;
}

/** The open bar's height for `rows` rows of text. */
export function messageBarHeight(rows: 1 | 2): number {
  return (
    2 * (MESSAGE_BAR_MARGIN_PX + MESSAGE_BAR_FRAME_PX + MESSAGE_BAR_PAD_Y_PX) +
    rows * MESSAGE_BAR_ROW_PX
  );
}

/**
 * The bar's layout for an office page (the map and the bar) `height` tall
 * whose bar is `width` wide. With the battle log: two rows (one on a short
 * page), the chips in a column beside them, one per row, or one chip over the
 * lines of a narrow bar (and always on phones, `chipsOver`: their chips are
 * drawn outside the sliding track, over room the bar keeps). Without it the
 * bar holds only chips: one row, two side by side (one on a narrow bar).
 * Unmeasured (0) reads as roomy.
 */
export function messageBarLayout(
  page: { width: number; height: number },
  battleLog: boolean,
  { chipsOver = false }: { chipsOver?: boolean } = {},
): MessageBarLayout {
  const narrow = page.width > 0 && page.width < MESSAGE_BAR_SIDE_CHIPS_MIN_PX;
  if (!battleLog) {
    return { rows: 1, chips: 'over', maxChips: narrow ? 1 : 2, height: messageBarHeight(1) };
  }
  const rows = page.height > 0 && page.height < MESSAGE_BAR_TWO_ROWS_MIN_PAGE_PX ? 1 : 2;
  return narrow || chipsOver
    ? { rows, chips: 'over', maxChips: 1, height: messageBarHeight(rows) }
    : { rows, chips: 'side', maxChips: rows, height: messageBarHeight(rows) };
}

/**
 * The strip's height under the map. With the battle log it always has its
 * height, empty between lines. Without it, it keeps one row while action
 * outcomes can arrive (a tokened Conductor office), empty between them, so a
 * toast never moves the map: the map is centred in the canvas, so a bar that
 * opened for each toast would slide the whole town up by half its height and
 * back down when it left. Where no outcome can arrive (VS Code, a view-only
 * office, Claude Code only) it is closed and the map has the room, opening
 * only for a toast that arrives anyway.
 */
export function messageBarStripHeight(
  layout: MessageBarLayout,
  opts: { battleLog: boolean; notices: boolean; toastCount: number },
): number {
  return opts.battleLog || opts.notices || opts.toastCount > 0 ? layout.height : 0;
}

/** An action toast (the conductor store's Toast). */
interface ToastLike {
  seq: number;
  tone: 'success' | 'error';
  at: number;
}

export interface PlacedChip<T extends ToastLike> {
  toast: T;
  /** Rows of the box it takes (an error takes every row it may). */
  rows: 1 | 2;
  /** Lines its text wraps onto (an ellipsis ends what doesn't fit). */
  lines: number;
}

export interface ChipPlacement<T extends ToastLike> {
  /** The chips that show, oldest first (top to bottom, or left to right). */
  chips: PlacedChip<T>[];
  /** Rows left for the battle log: all of them beside a chip column; under
   *  chips over the lines, the rows they leave. */
  logRows: 0 | 1 | 2;
}

/** Lines of chip text that fit a chip `rows` rows tall. */
export function chipLines(rows: 1 | 2): number {
  const room =
    rows * MESSAGE_BAR_ROW_PX - 2 * MESSAGE_BAR_CHIP_BORDER_PX - MESSAGE_BAR_CHIP_TEXT_PAD_PX;
  return Math.floor(room / MESSAGE_BAR_CHIP_LINE_PX);
}

function newestError<T extends ToastLike>(toasts: readonly T[]): T | undefined {
  let error: T | undefined;
  for (const toast of toasts) if (toast.tone === 'error') error = toast;
  return error;
}

/** The newest error (if any) and the newest others, `max` in all, oldest
 *  first: a newer success never hides an error still up. */
export function pickToasts<T extends ToastLike>(toasts: readonly T[], max: number): T[] {
  if (max <= 0) return [];
  const error = newestError(toasts);
  if (!error) return toasts.slice(-max);
  const others = max > 1 ? toasts.filter((toast) => toast !== error).slice(-(max - 1)) : [];
  return [error, ...others].sort((a, b) => a.seq - b.seq);
}

/**
 * Which toasts show as chips, how tall, and the rows that leaves the battle
 * log. With the battle log, an error up takes every row of the chips' place
 * (its reason is what matters; successes wait, and still reach the live
 * region and the Pokédex): the column beside the lines, or the whole box of a
 * narrow bar. Otherwise the newest successes, one per row beside the lines,
 * or the newest over the top row of a narrow bar. Without the battle log: one
 * row of chips side by side, the newest error among them (pickToasts).
 */
export function placeChips<T extends ToastLike>(
  toasts: readonly T[],
  layout: MessageBarLayout,
  battleLog: boolean,
): ChipPlacement<T> {
  const chip = (toast: T, rows: 1 | 2): PlacedChip<T> => ({ toast, rows, lines: chipLines(rows) });
  if (!battleLog) {
    return { chips: pickToasts(toasts, layout.maxChips).map((t) => chip(t, 1)), logRows: 0 };
  }
  const beside = layout.chips === 'side';
  const error = newestError(toasts);
  if (error) return { chips: [chip(error, layout.rows)], logRows: beside ? layout.rows : 0 };
  const successes = toasts.slice(-layout.maxChips).map((t) => chip(t, 1));
  if (beside || successes.length === 0) return { chips: successes, logRows: layout.rows };
  return { chips: successes, logRows: layout.rows === 2 ? 1 : 0 };
}

/** When a toast leaves: TOAST_VISIBLE_MS after it arrived (an error
 *  TOAST_ERROR_VISIBLE_MS), and at least TOAST_RESUME_MS after the pointer
 *  or focus last left its chip (`resumedAt`). Held, it doesn't leave. */
export function toastExpiresAt(toast: ToastLike, resumedAt?: number): number {
  const visible = toast.tone === 'error' ? TOAST_ERROR_VISIBLE_MS : TOAST_VISIBLE_MS;
  return Math.max(toast.at + visible, resumedAt === undefined ? 0 : resumedAt + TOAST_RESUME_MS);
}

/** The newest toast of each tone heard so far (its seq, 0 for none). */
export interface HeardToasts {
  success: number;
  error: number;
}

/**
 * What the bar's two live regions hold: the newest success (polite) and the
 * newest error (assertive), each only while it is the newest of its tone ever
 * heard and still up. A region is never refilled with an older toast when the
 * newer one leaves, so nothing is read out twice. `heard` is the caller's
 * state; keep the returned one.
 */
export function liveToasts<T extends ToastLike>(
  toasts: readonly T[],
  heard: HeardToasts,
): { heard: HeardToasts; status: T | null; alert: T | null } {
  const next = { ...heard };
  for (const toast of toasts) {
    if (toast.seq > next[toast.tone]) next[toast.tone] = toast.seq;
  }
  return {
    heard: next.success === heard.success && next.error === heard.error ? heard : next,
    status: toasts.find((t) => t.tone === 'success' && t.seq === next.success) ?? null,
    alert: toasts.find((t) => t.tone === 'error' && t.seq === next.error) ?? null,
  };
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
