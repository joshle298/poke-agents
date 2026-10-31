import { useCallback, useEffect } from 'react';

import { requestMusicLibrary } from './actions.js';
import { JukeboxPanel } from './JukeboxPanel.js';
import { musicStore, useMusic } from './musicStore.js';
import { NowPlayingPill } from './NowPlayingPill.js';
import { useMusicFeed } from './useMusicFeed.js';

/**
 * The Jukebox: background music from Poke Agents Radio (freely licensed
 * tracks the server downloads on first play), music the user owns (the music
 * folder) or plays in their own apps (Music, Spotify). A local nicety that
 * never touches Conductor. Mount once at App's top level, for privileged
 * standalone offices only; it renders the panel while open and, on a phone,
 * the now-playing pill (on desktop the office's top bar shows the pill under
 * the toolbar).
 */
export function Jukebox({ isMobile }: { isMobile: boolean }) {
  useMusicFeed();
  const open = useMusic((s) => s.open);
  const close = useCallback(() => musicStore.setOpen(false), []);

  // Opening rescans the folder, so music added a moment ago shows up.
  useEffect(() => {
    if (open) requestMusicLibrary();
  }, [open]);

  return (
    <>
      {open && <JukeboxPanel onClose={close} />}
      {isMobile && <NowPlayingPill placement="phone" />}
    </>
  );
}
