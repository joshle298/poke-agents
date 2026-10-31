import {
  MUSIC_PILL_MAX_WIDTH_PX,
  MUSIC_PILL_MOBILE_OFFSET_PX,
  MUSIC_PILL_Z_INDEX,
} from './constants.js';
import { pillText } from './format.js';
import { Marquee } from './Marquee.js';
import { musicStore, useMusic } from './musicStore.js';
import { JUKEBOX_UI_ATTRIBUTE } from './resumeOnGesture.js';

/** 'toolbar': in the stack under the desktop toolbar, right-aligned (the
 *  office's top bar places it). 'phone': fixed under the top buttons, mounted
 *  at App's top level (position: fixed must not sit inside the mobile shell's
 *  transformed track). */
type NowPlayingPlacement = 'toolbar' | 'phone';

/**
 * While Jukebox music plays: a small pill with the track and album, just
 * under the toolbar on desktop and under the top buttons on a phone. A click
 * opens the Jukebox.
 */
export function NowPlayingPill({ placement }: { placement: NowPlayingPlacement }) {
  const text = useMusic(pillText);
  const open = useMusic((s) => s.open);
  if (!text || open) return null;
  const attrs = { [JUKEBOX_UI_ATTRIBUTE]: '' };
  const phone = placement === 'phone';
  return (
    <button
      {...attrs}
      type="button"
      onClick={() => musicStore.setOpen(true)}
      className={`pixel-panel flex items-center gap-6 py-2 px-8 text-sm cursor-pointer ${
        phone ? 'fixed left-8 mobile-safe-top' : 'relative pointer-events-auto'
      }`}
      style={{
        zIndex: MUSIC_PILL_Z_INDEX,
        maxWidth: MUSIC_PILL_MAX_WIDTH_PX,
        ...(phone ? { marginTop: MUSIC_PILL_MOBILE_OFFSET_PX } : {}),
      }}
      title="Open the Jukebox"
      aria-label={`Now playing: ${text}. Open the Jukebox`}
      data-testid="music-now-playing"
    >
      <span className="material-symbols-sharp text-accent shrink-0" aria-hidden="true">
        music_note
      </span>
      <Marquee text={text} className="min-w-0 flex-1" />
    </button>
  );
}
