/**
 * Run a poll now and every `intervalMs`, but only while the page is visible
 * (DOM-free core, Node-tested; the Pokédex binds it to the document).
 *
 * Each Pokédex refresh keeps its session in the server's Focus poll tier,
 * the most expensive one. A Pokédex left open in a background or minimized
 * window should let that lapse, so polling stops while the page is hidden
 * and resumes, with an immediate refresh, when it shows again.
 */

export interface VisibilitySource {
  isHidden(): boolean;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onChange(listener: () => void): () => void;
}

export interface IntervalTimers {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Start polling; returns the function that stops it for good. */
export function startVisibleInterval(
  run: () => void,
  intervalMs: number,
  visibility: VisibilitySource,
  timers: IntervalTimers,
): () => void {
  let handle: unknown = null;
  const stopTimer = () => {
    if (handle !== null) timers.clearInterval(handle);
    handle = null;
  };
  const sync = () => {
    if (visibility.isHidden()) {
      stopTimer();
      return;
    }
    if (handle !== null) return;
    run();
    handle = timers.setInterval(run, intervalMs);
  };
  sync();
  const unsubscribe = visibility.onChange(sync);
  return () => {
    unsubscribe();
    stopTimer();
  };
}
