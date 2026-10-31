import { app, Notification } from 'electron';

import type { AttentionTracker } from '../attention.js';
import { MAX_RETAINED_NOTIFICATIONS } from '../constants.js';
import type { OfficeMessage } from '../officeFeed.js';

/**
 * Turns office messages into native notifications and the Dock badge. The
 * tracker decides; this shows. A notification is skipped (but still counted
 * by the tracker's dedupe) while the office window has focus: the office
 * already shows the "!" and plays its chime.
 */
export class Notifier {
  private badge = -1;
  /** Shown notifications, kept alive until closed so their click handlers survive GC. */
  private readonly shown = new Set<Notification>();

  constructor(
    private readonly tracker: AttentionTracker,
    private readonly hooks: {
      /** True while an office window has focus. */
      windowFocused: () => boolean;
      /** True while an office window exists (its own chime plays). */
      windowOpen: () => boolean;
      /** Bring the office forward (creating the window if it was closed). */
      focusOffice: () => void;
    },
  ) {}

  handle(message: OfficeMessage): void {
    const notices = this.tracker.handle(message);
    this.updateBadge();
    if (notices.length === 0 || this.hooks.windowFocused() || !Notification.isSupported()) return;
    for (const notice of notices) {
      const notification = new Notification({
        title: notice.title,
        body: notice.body,
        // With the office open, its chime is the sound (and the user's
        // Settings switch governs it); with the window closed, use the system's.
        silent: this.hooks.windowOpen(),
      });
      notification.on('click', () => this.hooks.focusOffice());
      notification.on('close', () => this.shown.delete(notification));
      this.shown.add(notification);
      // macOS may never report 'close' for one moved to Notification Center.
      if (this.shown.size > MAX_RETAINED_NOTIFICATIONS) {
        this.shown.delete(this.shown.values().next().value as Notification);
      }
      notification.show();
    }
  }

  /** Forget the office (it restarted, or the feed reconnects): clear the badge. */
  reset(): void {
    this.tracker.reset();
    this.updateBadge();
  }

  private updateBadge(): void {
    const count = this.tracker.needsYouCount();
    if (count === this.badge) return;
    this.badge = count;
    app.setBadgeCount(count);
  }
}
