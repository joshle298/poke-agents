import { app, Notification } from 'electron';

import type { AttentionNotice, AttentionTracker, AttentionUpdate } from '../attention.js';
import { MAX_RETAINED_NOTIFICATIONS } from '../constants.js';
import type { OfficeMessage } from '../officeFeed.js';

const isMac = process.platform === 'darwin';

/**
 * Turns office messages into native notifications and the Dock badge. The
 * tracker decides; this shows. A notification is skipped (but still counted
 * by the tracker's dedupe) while the office window has focus: the office
 * already shows the "!" and plays its chime.
 *
 * Each notification has the tracker's stable id, so a repeat replaces it in
 * Notification Center, and it is taken down there when the session moves on.
 * Notices the rate limit held back come out as one summary when it allows.
 */
export class Notifier {
  private badge = -1;
  /** Shown notifications by id, kept alive so their click handlers survive GC. */
  private readonly shown = new Map<string, Notification>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly tracker: AttentionTracker,
    private readonly hooks: {
      /** True while an office window has focus. */
      windowFocused: () => boolean;
      /** True while an office window exists (its own chime plays). */
      windowOpen: () => boolean;
      /** Bring the office forward (creating the window if it was closed). */
      focusOffice: () => void;
      /** Bring the office forward on this session's Pokédex. */
      openSession: (agentId: number) => void;
    },
  ) {}

  handle(message: OfficeMessage): void {
    this.apply(this.tracker.handle(message));
  }

  /**
   * Once, at a calm moment (the first successful connection): say what
   * notifications will bring. Showing it is also what makes macOS ask for
   * permission, which the Dock badge needs too, so that prompt never takes
   * the place of a real "needs your answer".
   */
  introduce(): void {
    if (!Notification.isSupported()) return;
    this.post({
      id: 'introduction',
      kind: 'summary',
      title: 'Watching your Conductor sessions',
      body: "You'll get a notification here when one needs your answer or a permission, or faints.",
    });
  }

  /** Forget the office (it restarted, or the feed reconnects): take every
   *  notification down and clear the badge. */
  reset(): void {
    this.tracker.reset();
    this.clearFlushTimer();
    this.takeDownAll();
    this.updateBadge();
  }

  /** On quit: nothing will keep these notifications true any more. */
  dispose(): void {
    this.clearFlushTimer();
    this.takeDownAll();
  }

  private apply(update: AttentionUpdate): void {
    for (const id of update.withdrawn) this.takeDown(id);
    this.updateBadge();
    if (update.notices.length > 0 && !this.hooks.windowFocused() && Notification.isSupported()) {
      for (const notice of update.notices) this.post(notice);
    }
    this.scheduleFlush();
  }

  private post(notice: AttentionNotice): void {
    this.takeDown(notice.id);
    const notification = new Notification({
      id: notice.id,
      groupId: notice.agentId !== undefined ? String(notice.agentId) : undefined,
      title: notice.title,
      body: notice.body,
      // With the office open, its chime is the sound (and the user's
      // Settings switch governs it); with the window closed, use the system's.
      silent: this.hooks.windowOpen(),
    });
    const { agentId } = notice;
    notification.on('click', () => {
      if (agentId !== undefined) this.hooks.openSession(agentId);
      else this.hooks.focusOffice();
    });
    notification.on('close', () => {
      if (this.shown.get(notice.id) === notification) this.shown.delete(notice.id);
    });
    this.shown.set(notice.id, notification);
    // macOS may never report 'close' for one moved to Notification Center.
    if (this.shown.size > MAX_RETAINED_NOTIFICATIONS) {
      const oldest = this.shown.keys().next().value;
      if (oldest !== undefined) this.shown.delete(oldest);
    }
    notification.show();
  }

  /** Take one notification down, on screen and in Notification Center. */
  private takeDown(id: string): void {
    const notification = this.shown.get(id);
    this.shown.delete(id);
    notification?.close();
    if (isMac) Notification.remove(id);
  }

  private takeDownAll(): void {
    for (const notification of this.shown.values()) notification.close();
    this.shown.clear();
    if (isMac) Notification.removeAll();
  }

  /** Send held notices when the rate limit next has room. */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const at = this.tracker.nextFlushAt();
    if (at === null) return;
    this.flushTimer = setTimeout(
      () => {
        this.flushTimer = null;
        this.apply(this.tracker.flush());
      },
      Math.max(0, at - Date.now()),
    );
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private updateBadge(): void {
    const count = this.tracker.needsYouCount();
    if (count === this.badge) return;
    this.badge = count;
    app.setBadgeCount(count);
  }
}
