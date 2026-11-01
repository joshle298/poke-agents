import { describe, expect, it } from 'vitest';

import {
  barLines,
  chipLines,
  liveToasts,
  messageBarHeight,
  messageBarLayout,
  messageBarStripHeight,
  pickToasts,
  placeChips,
  toastExpiresAt,
  typedLength,
  typeDurationMs,
} from '../src/components/messageBarLayout.js';
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
} from '../src/constants.js';

describe('messageBarHeight', () => {
  it('is the margin, frame and padding around the rows', () => {
    const chrome = 2 * (MESSAGE_BAR_MARGIN_PX + MESSAGE_BAR_FRAME_PX + MESSAGE_BAR_PAD_Y_PX);
    expect(messageBarHeight(1)).toBe(chrome + MESSAGE_BAR_ROW_PX);
    expect(messageBarHeight(2)).toBe(chrome + 2 * MESSAGE_BAR_ROW_PX);
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

  it('puts one chip over the lines of a narrow bar', () => {
    expect(messageBarLayout(PHONE, true)).toEqual({
      rows: 2,
      chips: 'over',
      maxChips: 1,
      height: messageBarHeight(2),
    });
    const justWideEnough = { width: MESSAGE_BAR_SIDE_CHIPS_MIN_PX, height: 900 };
    expect(messageBarLayout(justWideEnough, true).chips).toBe('side');
  });

  it('puts the chips over the lines on phones, however wide', () => {
    // A tablet in the phone shell: its chips are drawn outside the track.
    expect(messageBarLayout(DESKTOP, true, { chipsOver: true })).toMatchObject({
      rows: 2,
      chips: 'over',
      maxChips: 1,
    });
  });

  it('is one row of chips, side by side, without the battle log', () => {
    expect(messageBarLayout(DESKTOP, false)).toEqual({
      rows: 1,
      chips: 'over',
      maxChips: 2,
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

describe('messageBarStripHeight', () => {
  const withLog = messageBarLayout({ width: 1200, height: 900 }, true);
  const chipsOnly = messageBarLayout({ width: 1200, height: 900 }, false);

  it('keeps its height with the battle log, empty or not', () => {
    for (const toastCount of [0, 2]) {
      expect(messageBarStripHeight(withLog, { battleLog: true, notices: false, toastCount })).toBe(
        withLog.height,
      );
    }
  });

  it('keeps a row for chips without the battle log while outcomes can arrive', () => {
    // So a toast never resizes the canvas (and re-centres the town).
    for (const toastCount of [0, 1]) {
      expect(
        messageBarStripHeight(chipsOnly, { battleLog: false, notices: true, toastCount }),
      ).toBe(messageBarHeight(1));
    }
  });

  it('is closed where no outcome can arrive, unless one does', () => {
    expect(
      messageBarStripHeight(chipsOnly, { battleLog: false, notices: false, toastCount: 0 }),
    ).toBe(0);
    expect(
      messageBarStripHeight(chipsOnly, { battleLog: false, notices: false, toastCount: 1 }),
    ).toBe(messageBarHeight(1));
  });
});

describe('toast chips', () => {
  const T = 1_000_000;
  let seq = 0;
  interface TestToast {
    seq: number;
    tone: 'success' | 'error';
    at: number;
  }
  const success = (): TestToast => ({ seq: ++seq, tone: 'success', at: T });
  const error = (): TestToast => ({ seq: ++seq, tone: 'error', at: T });
  const seqs = (toasts: readonly { seq: number }[]) => toasts.map((t) => t.seq);

  describe('pickToasts', () => {
    it('takes the newest ones, oldest first', () => {
      const [a, b, c] = [success(), success(), success()];
      expect(pickToasts([a, b, c], 2)).toEqual([b, c]);
      expect(pickToasts([a, b, c], 1)).toEqual([c]);
      expect(pickToasts([a], 0)).toEqual([]);
    });

    it('never lets a newer success hide an error still up', () => {
      const [failed, sent, sentAgain] = [error(), success(), success()];
      expect(pickToasts([failed, sent], 1)).toEqual([failed]);
      expect(pickToasts([failed, sent, sentAgain], 2)).toEqual([failed, sentAgain]);
    });

    it('shows the newest error when there are several', () => {
      const [first, second, sent] = [error(), error(), success()];
      expect(pickToasts([first, second, sent], 1)).toEqual([second]);
      expect(pickToasts([first, second, sent], 2)).toEqual([second, sent]);
    });
  });

  describe('placeChips', () => {
    const side = messageBarLayout({ width: 1200, height: 900 }, true);
    const over = messageBarLayout({ width: 390, height: 754 }, true);
    const chipsOnly = messageBarLayout({ width: 1200, height: 900 }, false);

    it('stacks one chip per row beside two lines', () => {
      const [first, second, third] = [success(), success(), success()];
      const placed = placeChips([first, second, third], side, true);
      expect(placed.logRows).toBe(2);
      expect(placed.chips.map((c) => [c.toast.seq, c.rows, c.lines])).toEqual([
        [second.seq, 1, chipLines(1)],
        [third.seq, 1, chipLines(1)],
      ]);
    });

    it('lets an error take both rows beside the lines, over a newer success', () => {
      const [failed, sent] = [error(), success()];
      expect(placeChips([failed, sent], side, true)).toEqual({
        chips: [{ toast: failed, rows: 2, lines: chipLines(2) }],
        logRows: 2,
      });
      const short = messageBarLayout({ width: 1200, height: 400 }, true);
      expect(placeChips([failed], short, true)).toMatchObject({
        chips: [{ rows: 1, lines: chipLines(1) }],
        logRows: 1,
      });
    });

    it('puts a success over the top row of a narrow bar, the newest line under it', () => {
      const sent = success();
      expect(placeChips([sent], over, true)).toEqual({
        chips: [{ toast: sent, rows: 1, lines: chipLines(1) }],
        logRows: 1,
      });
      expect(placeChips([], over, true)).toEqual({ chips: [], logRows: 2 });
      const shortOver = messageBarLayout({ width: 390, height: 400 }, true);
      expect(placeChips([sent], shortOver, true).logRows).toBe(0);
    });

    it('lets an error take every row of a narrow bar, over a newer success', () => {
      const [failed, sent] = [error(), success()];
      expect(placeChips([failed, sent], over, true)).toEqual({
        chips: [{ toast: failed, rows: 2, lines: chipLines(2) }],
        logRows: 0,
      });
      const shortOver = messageBarLayout({ width: 390, height: 400 }, true);
      expect(placeChips([failed], shortOver, true)).toMatchObject({
        chips: [{ rows: 1 }],
        logRows: 0,
      });
    });

    it('shows the newest error when there are several', () => {
      const [first, second] = [error(), error()];
      expect(seqs(placeChips([first, second], side, true).chips.map((c) => c.toast))).toEqual([
        second.seq,
      ]);
    });

    it('puts chips side by side in a bar without the battle log', () => {
      const [failed, sent, sentAgain] = [error(), success(), success()];
      const placed = placeChips([failed, sent, sentAgain], chipsOnly, false);
      expect(placed.logRows).toBe(0);
      expect(placed.chips.map((c) => [c.toast.seq, c.rows])).toEqual([
        [failed.seq, 1],
        [sentAgain.seq, 1],
      ]);
    });
  });

  it('fits two lines of chip text in a row, four in two', () => {
    expect(chipLines(1)).toBe(2);
    expect(chipLines(2)).toBe(4);
    const lines = (rows: 1 | 2) =>
      chipLines(rows) * MESSAGE_BAR_CHIP_LINE_PX + MESSAGE_BAR_CHIP_TEXT_PAD_PX;
    expect(lines(1)).toBeLessThanOrEqual(MESSAGE_BAR_ROW_PX - 2 * MESSAGE_BAR_CHIP_BORDER_PX);
    expect(lines(2)).toBeLessThanOrEqual(2 * MESSAGE_BAR_ROW_PX - 2 * MESSAGE_BAR_CHIP_BORDER_PX);
  });

  describe('toastExpiresAt', () => {
    it('keeps an error up longer than a success', () => {
      expect(toastExpiresAt(success())).toBe(T + TOAST_VISIBLE_MS);
      expect(toastExpiresAt(error())).toBe(T + TOAST_ERROR_VISIBLE_MS);
      expect(TOAST_ERROR_VISIBLE_MS).toBeGreaterThan(TOAST_VISIBLE_MS);
    });

    it('gives a chip let go late a little more time, never less', () => {
      const sent = success();
      const late = T + TOAST_VISIBLE_MS + 5_000;
      expect(toastExpiresAt(sent, late)).toBe(late + TOAST_RESUME_MS);
      // Let go early: its own time still runs out first.
      expect(toastExpiresAt(sent, T)).toBe(T + TOAST_VISIBLE_MS);
    });
  });

  describe('liveToasts', () => {
    it('reads each new toast once, in the region for its tone', () => {
      const sent = success();
      let live = liveToasts([sent], { success: 0, error: 0 });
      expect(live.status).toBe(sent);
      expect(live.alert).toBeNull();
      const failed = error();
      live = liveToasts([sent, failed], live.heard);
      expect([live.status, live.alert]).toEqual([sent, failed]);
      expect(live.heard).toEqual({ success: sent.seq, error: failed.seq });
    });

    it('keeps the same heard object while nothing new arrives', () => {
      const sent = success();
      const heard = { success: sent.seq, error: 0 };
      expect(liveToasts([sent], heard).heard).toBe(heard);
    });

    it('never falls back to an older toast when the newest leaves', () => {
      const [older, newer] = [error(), error()];
      const { heard } = liveToasts([older, newer], { success: 0, error: 0 });
      expect(seqs([liveToasts([older, newer], heard).alert!])).toEqual([newer.seq]);
      // The newer one dismissed: the older one is not read out again.
      expect(liveToasts([older], heard).alert).toBeNull();
    });
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
