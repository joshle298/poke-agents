import { useEffect, useState } from 'react';

import { transport } from '../transport/index.js';
import { requestMusicLibrary, sendMusicCommand } from './actions.js';
import { canSend, pollWhileConnected, watchConnection } from './connection.js';
import { MUSIC_APP_POLL_MS } from './constants.js';
import { existingFolderPlayer, folderPlayer } from './controls.js';
import { type AppSource, musicStore, useMusic } from './musicStore.js';
import { readMusicPrefs } from './preferences.js';
import { resumeOnGesture } from './resumeOnGesture.js';

function isAppSource(source: string): source is AppSource {
  return source === 'apple' || source === 'spotify';
}

/** Folder music was playing when the page closed. */
function rememberedFolderPlaying(): boolean {
  const prefs = readMusicPrefs();
  return prefs.playing && prefs.source === 'folder';
}

/**
 * Whether the socket can carry commands. When it drops, pending commands are
 * cleared (their replies are lost with it); when it comes back, the library is
 * asked for again (the server may have restarted and forgotten the Music
 * library scan).
 */
function useConnected(): boolean {
  const [connected, setConnected] = useState(() => canSend(transport.state));
  useEffect(() => {
    setConnected(canSend(transport.state));
    return watchConnection(transport, {
      onDrop: () => {
        musicStore.clearPending();
        setConnected(false);
      },
      onReturn: () => {
        requestMusicLibrary();
        setConnected(true);
      },
    });
  }, []);
  return connected;
}

/**
 * Keeps the Jukebox store fed: server messages in, the library on start, the
 * app's now-playing while it matters, and the remembered folder music resumed
 * on the page's first gesture (browsers allow audio only after one, and the
 * Jukebox never plays on its own before it).
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

  const connected = useConnected();

  // Ask the app what it is playing while its tab is open, or while it is the
  // source the user started in this page, the page is visible and the socket
  // is up (a reconnect asks at once).
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
    if (!pollSource || !appAvailable || !connected) return;
    return pollWhileConnected({
      transport,
      refresh: () => sendMusicCommand({ action: 'refresh', source: pollSource }),
      hidden: () => typeof document !== 'undefined' && document.hidden,
      intervalMs: MUSIC_APP_POLL_MS,
    });
  }, [pollSource, appAvailable, connected]);

  // Folder music that was playing when the page closed resumes on the first
  // gesture outside the Jukebox, once the library is here.
  const libraryReady = useMusic((s) => s.library !== null);
  useEffect(() => {
    if (!libraryReady || !rememberedFolderPlaying() || readMusicPrefs().station === null) return;
    return resumeOnGesture({
      target: window,
      shouldResume: () => rememberedFolderPlaying() && !folderPlayer().isPlaying(),
      resume: (onBlocked) => folderPlayer().resume({ onBlocked }),
    });
  }, [libraryReady]);
}
