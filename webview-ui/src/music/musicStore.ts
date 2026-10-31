/**
 * Jukebox UI store: the library the server sent, what the Music and Spotify
 * apps are playing, the page player's state (radio and folder music), which
 * tab is open, and the last failure to show. DOM-free and transport-free like
 * conductorStore, so the Node test runner can drive it; React reads it
 * through `useMusic`.
 */

import { useSyncExternalStore } from 'react';

import type {
  MusicCommandAction,
  MusicLibrary,
  MusicSourceId,
  MusicState,
  ServerMessage,
} from '../../../core/src/messages.js';
import type { MusicPrefs } from './preferences.js';
import { readMusicPrefs } from './preferences.js';

/** Sources that play in the page, through the folder player. */
export type PageSource = Extract<MusicSourceId, 'radio' | 'folder'>;
/** Sources that play in an app on this Mac. */
export type AppSource = Exclude<MusicSourceId, PageSource>;

export function isPageSource(source: MusicSourceId): source is PageSource {
  return source === 'radio' || source === 'folder';
}

/** The page player's state (radio or folder music), as the panel and the
 *  pill show it. */
export interface FolderPlayback {
  playing: boolean;
  trackId: string | null;
  /** The station playing ('radio', 'all' or an album id), or the last one. */
  station: string | null;
  shuffle: boolean;
  /** 0..1 */
  volume: number;
  /** Tracks this browser can't play (format, or a failed load). */
  unplayable: readonly string[];
}

export interface MusicNotice {
  seq: number;
  text: string;
  tone: 'error' | 'info';
}

export interface MusicStoreState {
  library: MusicLibrary | null;
  apps: Readonly<Partial<Record<AppSource, MusicState>>>;
  /** `${source}:${action}` commands waiting for their result. */
  pending: Readonly<Record<string, true>>;
  notice: MusicNotice | null;
  open: boolean;
  /** The tab shown in the panel. */
  tab: MusicSourceId;
  /** The source the user last played from: the pill follows it. */
  activeSource: MusicSourceId;
  /** The user started an app source in this page, so its now-playing is
   *  polled (never on a bare page load: that could raise the macOS
   *  Automation prompt without a click). */
  appStarted: boolean;
  folder: FolderPlayback;
}

type Listener = () => void;

export function pendingKey(source: MusicSourceId, action: MusicCommandAction): string {
  return `${source}:${action}`;
}

export function initialMusicState(prefs: MusicPrefs): MusicStoreState {
  return {
    library: null,
    apps: {},
    pending: {},
    notice: null,
    open: false,
    tab: prefs.source,
    activeSource: prefs.source,
    appStarted: false,
    folder: {
      playing: false,
      trackId: prefs.track,
      station: prefs.station,
      shuffle: prefs.shuffle,
      volume: prefs.volume,
      unplayable: [],
    },
  };
}

/** Whether a source works on this server (false until the library says). */
export function sourceAvailable(state: MusicStoreState, source: MusicSourceId): boolean {
  return state.library?.sources.some((s) => s.id === source && s.available) ?? false;
}

/** The tab to show: the chosen one while it works here, else the radio, else
 *  the music folder (which always works on the Poke Agents server). */
export function usableTab(state: MusicStoreState): MusicSourceId {
  if (sourceAvailable(state, state.tab)) return state.tab;
  return sourceAvailable(state, 'radio') ? 'radio' : 'folder';
}

export class MusicStore {
  private state: MusicStoreState;
  private readonly listeners = new Set<Listener>();
  private seq = 0;

  constructor(prefs: MusicPrefs = readMusicPrefs()) {
    this.state = initialMusicState(prefs);
  }

  getState = (): MusicStoreState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: MusicStoreState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** Fold one server message in; anything not about music is ignored. */
  apply(msg: ServerMessage): void {
    const state = this.state;
    switch (msg.type) {
      case 'musicLibrary': {
        const next: MusicStoreState = { ...state, library: msg };
        this.set({ ...next, tab: usableTab(next) });
        return;
      }
      case 'musicState':
        if (isPageSource(msg.source)) return;
        this.set({ ...state, apps: { ...state.apps, [msg.source]: msg } });
        return;
      case 'musicActionResult': {
        const key = pendingKey(msg.source, msg.action);
        let next = state;
        if (state.pending[key]) {
          const pending = { ...state.pending };
          delete pending[key];
          next = { ...next, pending };
        }
        if (!msg.ok && msg.message) next = this.withNotice(next, msg.message, 'error');
        this.set(next);
        return;
      }
      default:
        return;
    }
  }

  markPending(source: MusicSourceId, action: MusicCommandAction): void {
    this.set({
      ...this.state,
      pending: { ...this.state.pending, [pendingKey(source, action)]: true },
    });
  }

  /** The connection dropped: replies to what was sent before are lost, so
   *  nothing may stay pending (a stuck "Looking…" or disabled button). */
  clearPending(): void {
    if (Object.keys(this.state.pending).length > 0) this.set({ ...this.state, pending: {} });
  }

  setOpen(open: boolean): void {
    if (this.state.open !== open) this.set({ ...this.state, open });
  }

  setTab(tab: MusicSourceId): void {
    if (this.state.tab !== tab) this.set({ ...this.state, tab });
  }

  setActiveSource(source: MusicSourceId): void {
    const appStarted = !isPageSource(source);
    if (this.state.activeSource !== source || this.state.appStarted !== appStarted) {
      this.set({ ...this.state, activeSource: source, appStarted });
    }
  }

  setFolder(folder: FolderPlayback): void {
    this.set({ ...this.state, folder });
  }

  showNotice(text: string, tone: MusicNotice['tone'] = 'error'): void {
    this.set(this.withNotice(this.state, text, tone));
  }

  dismissNotice(seq: number): void {
    if (this.state.notice?.seq === seq) this.set({ ...this.state, notice: null });
  }

  private withNotice(state: MusicStoreState, text: string, tone: MusicNotice['tone']) {
    return { ...state, notice: { seq: ++this.seq, text, tone } };
  }
}

export const musicStore = new MusicStore();

export function useMusic<T>(selector: (state: MusicStoreState) => T): T {
  return useSyncExternalStore(musicStore.subscribe, () => selector(musicStore.getState()));
}
