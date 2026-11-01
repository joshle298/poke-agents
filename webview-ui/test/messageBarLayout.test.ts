import { describe, expect, it } from 'vitest';

import {
  barLines,
  messageBarHeight,
  messageBarLayout,
  messageBarOpen,
  typedLength,
  typeDurationMs,
} from '../src/components/messageBarLayout.js';
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
} from '../src/constants.js';

describe('messageBarHeight', () => {
  it('is the margin, frame and padding around the rows', () => {
    const chrome = 2 * (MESSAGE_BAR_MARGIN_PX + MESSAGE_BAR_BORDER_PX + MESSAGE_BAR_PAD_Y_PX);
    expect(messageBarHeight(1)).toBe(chrome + MESSAGE_BAR_ROW_PX);
    expect(messageBarHeight(2)).toBe(chrome + 2 * MESSAGE_BAR_ROW_PX + MESSAGE_BAR_ROW_GAP_PX);
  });
});

describe('messageBarLayout', () => {
  // Office pages measured in the demo office: 1400 × 900 beside the wide
  // party bar, 860 × 900 beside the compact one, a 390 × 844 phone.
  const DESKTOP = { width: 1200, height: 900 };
  const DRAWER = { width: 788, height: 900 };
  const PHONE = { width: 390, height: 754 };

  it('puts two rows and a chip column beside them on a desktop office', () => {
    for (const page of [DESKTOP, DRAWER]) {
      expect(messageBarLayout(page, true)).toEqual({
        rows: 2,
        chips: 'side',
        maxChips: 2,
        height: messageBarHeight(2),
      });
    }
  });

  it('keeps one row on a short office page', () => {
    const short = { width: 1200, height: MESSAGE_BAR_TWO_ROWS_MIN_PAGE_PX - 1 };
    expect(messageBarLayout(short, true)).toEqual({
      rows: 1,
      chips: 'side',
      maxChips: 1,
      height: messageBarHeight(1),
    });
    const tallEnough = { ...short, height: MESSAGE_BAR_TWO_ROWS_MIN_PAGE_PX };
    expect(messageBarLayout(tallEnough, true).rows).toBe(2);
  });

  it('puts the newest chip over the top row of a narrow bar', () => {
    expect(messageBarLayout(PHONE, true)).toEqual({
      rows: 2,
      chips: 'top',
      maxChips: 1,
      height: messageBarHeight(2),
    });
    const justWideEnough = { width: MESSAGE_BAR_SIDE_CHIPS_MIN_PX, height: 900 };
    expect(messageBarLayout(justWideEnough, true).chips).toBe('side');
  });

  it('is one row of chips, side by side, without the battle log', () => {
    expect(messageBarLayout(DESKTOP, false)).toEqual({
      rows: 1,
      chips: 'top',
      maxChips: TOAST_MAX_VISIBLE,
      height: messageBarHeight(1),
    });
    expect(messageBarLayout(PHONE, false).maxChips).toBe(1);
  });

  it('reads an unmeasured page as roomy', () => {
    expect(messageBarLayout({ width: 0, height: 0 }, true)).toMatchObject({
      rows: 2,
      chips: 'side',
    });
  });
});

describe('messageBarOpen', () => {
  it('stays open while the battle log is on, empty or not', () => {
    expect(messageBarOpen(true, 0)).toBe(true);
    expect(messageBarOpen(true, 2)).toBe(true);
  });

  it('opens without the battle log only while a toast shows', () => {
    expect(messageBarOpen(false, 0)).toBe(false);
    expect(messageBarOpen(false, 1)).toBe(true);
  });
});

describe('barLines', () => {
  const T = 1_000_000;
  const entry = (seq: number, at: number) => ({ seq, text: `line ${seq}`, at });
  const fadeAt = (at: number) => at + BATTLE_LOG_VISIBLE_MS - BATTLE_LOG_FADE_MS;
  const goneAt = (at: number) => at + BATTLE_LOG_VISIBLE_MS;

  it('shows nothing with an empty log', () => {
    expect(barLines([], T)).toEqual({ newest: null, previous: null, nextChangeAt: null });
  });

  it('shows the newest line until it fades, then fading until it leaves', () => {
    const log = [entry(1, T)];
    expect(barLines(log, T)).toEqual({
      newest: { ...log[0], fading: false },
      previous: null,
      nextChangeAt: fadeAt(T),
    });
    expect(barLines(log, fadeAt(T))).toMatchObject({
      newest: { seq: 1, fading: true },
      nextChangeAt: goneAt(T),
    });
    expect(barLines(log, goneAt(T))).toEqual({ newest: null, previous: null, nextChangeAt: null });
  });

  it('keeps the line before the newest while it is still up itself', () => {
    const log = [entry(1, T), entry(2, T + 1_000)];
    const lines = barLines(log, T + 1_000);
    expect(lines.previous).toMatchObject({ seq: 1, fading: false });
    expect(lines.newest).toMatchObject({ seq: 2, fading: false });
    // The previous line changes first.
    expect(lines.nextChangeAt).toBe(fadeAt(T));

    const later = barLines(log, goneAt(T));
    expect(later.previous).toBeNull();
    expect(later.newest).toMatchObject({ seq: 2 });
    expect(later.nextChangeAt).toBe(fadeAt(T + 1_000));
  });

  it('only ever shows the two newest lines', () => {
    const log = [entry(1, T), entry(2, T + 10), entry(3, T + 20)];
    const lines = barLines(log, T + 20);
    expect([lines.previous?.seq, lines.newest?.seq]).toEqual([2, 3]);
  });
});

describe('typewriter', () => {
  it('takes a fixed time per character, capped for long lines', () => {
    expect(typeDurationMs(10)).toBe(10 * MESSAGE_BAR_TYPE_MS_PER_CHAR);
    expect(typeDurationMs(1_000)).toBe(MESSAGE_BAR_TYPE_MAX_MS);
  });

  it('reveals the line from nothing to whole over that time', () => {
    const text = 'Pikachu used Bash!';
    const duration = typeDurationMs(text.length);
    expect(typedLength(text, 0)).toBe(0);
    expect(typedLength(text, -50)).toBe(0);
    expect(typedLength(text, duration / 2)).toBe(Math.floor(text.length / 2));
    expect(typedLength(text, duration)).toBe(text.length);
    expect(typedLength(text, duration * 10)).toBe(text.length);
  });

  it('counts code points, so an accent or emoji is never split', () => {
    const text = 'Flabébé used 🔥!';
    const chars = Array.from(text).length;
    expect(chars).toBeLessThan(text.length);
    expect(typedLength(text, typeDurationMs(chars))).toBe(chars);
    expect(typedLength(text, MESSAGE_BAR_TYPE_MS_PER_CHAR * 14)).toBe(14);
  });

  it('reveals a long line whole within the cap', () => {
    const text = 'x'.repeat(200);
    expect(typedLength(text, MESSAGE_BAR_TYPE_MAX_MS - 1)).toBeLessThan(200);
    expect(typedLength(text, MESSAGE_BAR_TYPE_MAX_MS)).toBe(200);
  });
});
