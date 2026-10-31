/**
 * What the Jukebox's buttons do, for every source. Folder music plays in the
 * page (folderPlayer); the Music and Spotify apps get musicCommands. Starting
 * one source pauses the other, so two soundtracks never play at once.
 */

import type { MusicSourceId } from '../../../core/src/messages.js';
import { sendMusicCommand } from './actions.js';
import { FolderPlayer, type MediaSessionPort } from './folderPlayer.js';
import { type AppSource, musicStore } from './musicStore.js';
import { writeMusicPrefs } from './preferences.js';
import { activateSource } from './sourceSwitch.js';
import { musicTrackUrl } from './trackUrl.js';

let player: FolderPlayer | null = null;

/** The page's folder player, created on first use (it owns two <audio>s). */
export function folderPlayer(): FolderPlayer {
  if (!player) {
    player = new FolderPlayer(
      {
        createAudio: () => new Audio(),
        mediaSession: browserMediaSession(),
        urlFor: musicTrackUrl,
        isServed: async (id) => {
          try {
            const res = await fetch(musicTrackUrl(id), { method: 'HEAD', cache: 'no-store' });
            return res.ok;
          } catch {
            return false;
          }
        },
        now: () => performance.now(),
        rng: Math.random,
        onChange: (state) => {
          musicStore.setFolder(state);
          writeMusicPrefs({ shuffle: state.shuffle, volume: state.volume });
        },
        onNotice: (text) => musicStore.showNotice(text),
        persist: (state) => writeMusicPrefs(state),
      },
      musicStore.getState().folder,
    );
    const library = musicStore.getState().library;
    if (library) player.setLibrary(library);
  }
  return player;
}

/** navigator.mediaSession as the player uses it, so the OS media keys and
 *  Now Playing show and control folder music. */
function browserMediaSession(): MediaSessionPort | undefined {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return undefined;
  const session = navigator.mediaSession;
  return {
    setActionHandler: (action, handler) => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // This browser doesn't support that action.
      }
    },
    setMetadata: ({ title, album }) => {
      if (typeof MediaMetadata !== 'undefined') {
        session.metadata = new MediaMetadata({ title, album });
      }
    },
  };
}

/** The folder player if it exists (never creates one). */
export function existingFolderPlayer(): FolderPlayer | null {
  return player;
}

function activate(source: MusicSourceId): void {
  activateSource(source, {
    store: musicStore,
    pauseFolder: () => player?.pause(),
    pauseApp: (app) => sendMusicCommand({ action: 'pause', source: app }),
    remember: (s) => writeMusicPrefs({ source: s }),
  });
}

/** Play a folder station ('all' or an album id), optionally from a track. */
export function playFolder(station: string, options: { shuffle?: boolean; startId?: string } = {}) {
  activate('folder');
  folderPlayer().playStation(station, options);
}

/** Play in an app: a Music library album or saved link, a Spotify link, or
 *  (Music, no station) every Pokémon album. */
export function playApp(source: AppSource, stationId?: string, shuffle?: boolean): void {
  activate(source);
  sendMusicCommand({
    action: 'play',
    source,
    ...(stationId !== undefined ? { stationId } : {}),
    ...(shuffle !== undefined ? { shuffle } : {}),
  });
}

export function togglePlay(source: MusicSourceId): void {
  if (source === 'folder') {
    const p = folderPlayer();
    if (!p.isPlaying()) activate('folder');
    p.toggle();
    return;
  }
  const playing = musicStore.getState().apps[source]?.playing === true;
  if (!playing) activate(source);
  sendMusicCommand({ action: playing ? 'pause' : 'resume', source });
}

export function skip(source: MusicSourceId, direction: 'next' | 'previous'): void {
  if (source === 'folder') {
    if (direction === 'next') folderPlayer().next();
    else folderPlayer().previous();
    return;
  }
  sendMusicCommand({ action: direction, source });
}

export function setShuffle(source: MusicSourceId, shuffle: boolean): void {
  if (source === 'folder') folderPlayer().setShuffle(shuffle);
  else sendMusicCommand({ action: 'setShuffle', source, shuffle });
}

/** Folder: 0..1, applied at once. Apps: sent as 0..100 by the caller's debounce. */
export function setFolderVolume(volume: number): void {
  folderPlayer().setVolume(volume);
}

export function setAppVolume(source: AppSource, volume: number): void {
  sendMusicCommand({ action: 'setVolume', source, volume: Math.round(volume) });
}
