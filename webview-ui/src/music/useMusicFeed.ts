import { useEffect } from 'react';

import { transport } from '../transport/index.js';
import { requestMusicLibrary, sendMusicCommand } from './actions.js';
import { MUSIC_APP_POLL_MS } from './constants.js';
import { existingFolderPlayer, folderPlayer } from './controls.js';
import { type AppSource, musicStore, useMusic } from './musicStore.js';
import { readMusicPrefs } from './preferences.js';

/** Elements inside the Jukebox carry this attribute: a click there is its own
 *  command, never the gesture that resumes remembered music. */
export const JUKEBOX_UI_ATTRIBUTE = 'data-jukebox';

function isAppSource(source: string): source is AppSource {
  return source === 'apple' || source === 'spotify';
}

/**
 * Keeps the Jukebox store fed: server messages in, the library on start, the
 * app's now-playing while it matters, and the remembered folder music resumed
 * on the page's first click or key press (browsers allow audio only after a
 * gesture, and the Jukebox never plays on its own before one).
 */
export function useMusicFeed(): void {
  // Server messages, and the library once at start (cheap: a bounded scan).
  useEffect(() => {
    const off = transport.onMessage((msg) => {
      musicStore.apply(msg);
      if (msg.type === 'musicLibrary') existingFolderPlayer()?.setLibrary(msg);
    });
    requestMusicLibrary();
    return off;
  }, []);

  // Ask the app what it is playing while its tab is open, or while it is the
  // source the user started in this page, and the page is visible.
  const activeSource = useMusic((s) => s.activeSource);
  const appStarted = useMusic((s) => s.appStarted);
  const open = useMusic((s) => s.open);
  const tab = useMusic((s) => s.tab);
  const pollSource: AppSource | null =
    open && isAppSource(tab) ? tab : appStarted && isAppSource(activeSource) ? activeSource : null;
  const appAvailable = useMusic(
    (s) =>
      pollSource !== null &&
      (s.library?.sources ?? []).some((x) => x.id === pollSource && x.available),
  );
  useEffect(() => {
    if (!pollSource || !appAvailable) return;
    const refresh = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      sendMusicCommand({ action: 'refresh', source: pollSource });
    };
    refresh();
    const timer = setInterval(refresh, MUSIC_APP_POLL_MS);
    return () => clearInterval(timer);
  }, [pollSource, appAvailable]);

  // Folder music that was playing when the page closed resumes on the first
  // gesture outside the Jukebox, once the library is here.
  const libraryReady = useMusic((s) => s.library !== null);
  useEffect(() => {
    if (!libraryReady) return;
    const prefs = readMusicPrefs();
    if (!prefs.playing || prefs.source !== 'folder' || !prefs.station) return;
    const onGesture = (e: Event) => {
      const target = e.target as Element | null;
      if (target?.closest?.(`[${JUKEBOX_UI_ATTRIBUTE}]`)) return;
      cleanup();
      // The user may have paused or switched sources since the page loaded.
      const now = readMusicPrefs();
      if (!now.playing || now.source !== 'folder') return;
      if (!folderPlayer().isPlaying()) folderPlayer().resume();
    };
    const cleanup = () => {
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
    return cleanup;
  }, [libraryReady]);
}
