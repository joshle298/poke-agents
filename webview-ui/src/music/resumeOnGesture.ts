/**
 * Folder music that was playing when the page closed comes back on the first
 * gesture after a reload, never before: browsers start audio only after a user
 * activation. DOM-free (the event target is injected) so the rules are tested
 * in Node.
 */

/** Elements inside the Jukebox carry this attribute: a gesture there is its own
 *  command, never the one that resumes remembered music. */
export const JUKEBOX_UI_ATTRIBUTE = 'data-jukebox';

/** The events that can carry user activation (HTML "activation triggering
 *  input events"). */
export const ACTIVATION_EVENTS = ['keydown', 'pointerdown', 'pointerup', 'touchend'] as const;

interface GestureEvent {
  type: string;
  key?: string;
  pointerType?: string;
  target?: unknown;
}

/**
 * Whether this event gives the page user activation, so audio may start in
 * its handler: a key press other than Escape, a mouse button going down, a
 * touch or pen lifting. A touch's pointerdown, and Escape, don't.
 */
export function grantsUserActivation(e: GestureEvent): boolean {
  switch (e.type) {
    case 'keydown':
      return e.key !== 'Escape';
    case 'pointerdown':
      return e.pointerType === 'mouse';
    case 'pointerup':
      return e.pointerType !== undefined && e.pointerType !== 'mouse';
    case 'touchend':
      return true;
    default:
      return false;
  }
}

export function isInsideJukebox(target: unknown): boolean {
  const closest = (target as { closest?: (selector: string) => unknown } | null)?.closest;
  return typeof closest === 'function'
    ? closest.call(target, `[${JUKEBOX_UI_ATTRIBUTE}]`) !== null
    : false;
}

export interface GestureEventTarget {
  addEventListener(type: string, listener: (e: GestureEvent) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (e: GestureEvent) => void, capture: boolean): void;
}

export interface ResumeOnGestureDeps {
  /** The window (capture phase, so nothing under it can swallow the event). */
  target: GestureEventTarget;
  /** Still worth resuming: remembered as playing, folder source, not already
   *  playing (the user may have paused or switched since the page loaded). */
  shouldResume(): boolean;
  /** Start the music; `onBlocked` when the browser refused (no activation). */
  resume(onBlocked: () => void): void;
}

/**
 * Listen for the first activating gesture outside the Jukebox and resume the
 * remembered music in it. A blocked start (the browser didn't count the
 * gesture) listens again; the remembered state is left alone. Returns the
 * cleanup.
 */
export function resumeOnGesture(deps: ResumeOnGestureDeps): () => void {
  let disposed = false;
  let armed = false;

  const arm = () => {
    if (disposed || armed) return;
    armed = true;
    for (const type of ACTIVATION_EVENTS) deps.target.addEventListener(type, onGesture, true);
  };
  const disarm = () => {
    if (!armed) return;
    armed = false;
    for (const type of ACTIVATION_EVENTS) deps.target.removeEventListener(type, onGesture, true);
  };
  function onGesture(e: GestureEvent): void {
    if (!grantsUserActivation(e) || isInsideJukebox(e.target)) return;
    disarm();
    if (deps.shouldResume()) deps.resume(arm);
  }

  arm();
  return () => {
    disposed = true;
    disarm();
  };
}
