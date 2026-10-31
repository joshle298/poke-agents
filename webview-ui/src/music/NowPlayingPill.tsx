import { MUSIC_PILL_BOTTOM_PX, MUSIC_PILL_MAX_WIDTH_PX, MUSIC_PILL_Z_INDEX } from './constants.js';
import { pillText } from './format.js';
import { Marquee } from './Marquee.js';
import { musicStore, useMusic } from './musicStore.js';
import { JUKEBOX_UI_ATTRIBUTE } from './useMusicFeed.js';

/**
 * While Jukebox music plays: a small pill with the track and album. Desktop:
 * above the bottom toolbar; mobile: under the top buttons. A click opens the
 * Jukebox. Mounted at App's top level (position: fixed must not sit inside
 * the mobile shell's transformed track).
 */
export function NowPlayingPill({ isMobile }: { isMobile: boolean }) {
  const text = useMusic(pillText);
  const open = useMusic((s) => s.open);
  if (!text || open) return null;
  const attrs = { [JUKEBOX_UI_ATTRIBUTE]: '' };
  return (
    <button
      {...attrs}
      type="button"
      onClick={() => musicStore.setOpen(true)}
      className={`fixed pixel-panel flex items-center gap-6 py-2 px-8 text-sm cursor-pointer ${
        isMobile ? 'left-8 mobile-safe-top' : 'left-10'
      }`}
      style={{
        zIndex: MUSIC_PILL_Z_INDEX,
        maxWidth: MUSIC_PILL_MAX_WIDTH_PX,
        ...(isMobile ? { marginTop: 40 } : { bottom: MUSIC_PILL_BOTTOM_PX }),
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
