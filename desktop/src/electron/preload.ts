/**
 * The office window's preload: a small bridge and nothing else. The office
 * (the local server's page, sandboxed with context isolation) can ask the app
 * to reconnect to Conductor, ask for a Conductor API key on the clipboard
 * (the Connect card's Paste, sent only during a user's click; and the one
 * suggestion after "Get an API key"; main answers only key-shaped text, only
 * to the focused office window, see clipboardKey.ts), and receives app
 * commands: open a session's Pokédex after a notification click, open
 * Settings from the menu. Main checks that every request comes from the
 * office window.
 */

import { contextBridge, ipcRenderer } from 'electron';

import {
  DESKTOP_BRIDGE_GLOBAL,
  IPC_OFFICE_COMMAND,
  IPC_READ_CLIPBOARD_KEY,
  IPC_RECONNECT_CONDUCTOR,
  MAX_EARLY_COMMANDS,
} from '../constants.js';

type Listener = (command: unknown) => void;

/** Whether a user's click (or key press) is still in effect for this page:
 *  Chromium's transient user activation, shared with the page's own world. */
function userIsActing(): boolean {
  const nav = (globalThis as { navigator?: { userActivation?: { isActive?: boolean } } }).navigator;
  return nav?.userActivation?.isActive === true;
}

function keyOrNull(answer: unknown): string | null {
  return typeof answer === 'string' ? answer : null;
}

const listeners = new Set<Listener>();
/** Commands that arrive before the office subscribes (a notification click
 *  that opened a new window), delivered on subscribe. */
const early: unknown[] = [];

ipcRenderer.on(IPC_OFFICE_COMMAND, (_event, command: unknown) => {
  if (listeners.size === 0) {
    if (early.length < MAX_EARLY_COMMANDS) early.push(command);
    return;
  }
  for (const listener of listeners) listener(command);
});

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_GLOBAL, {
  reconnectConductor: (): void => ipcRenderer.send(IPC_RECONNECT_CONDUCTOR),
  // Paste: only while the user's click is in effect, so a script in the page
  // can't read the clipboard on its own.
  readClipboardKey: async (): Promise<string | null> =>
    userIsActing() ? keyOrNull(await ipcRenderer.invoke(IPC_READ_CLIPBOARD_KEY, 'paste')) : null,
  // The suggestion: main answers once per "Get an API key" (it opened the page).
  clipboardKeySuggestion: async (): Promise<string | null> =>
    keyOrNull(await ipcRenderer.invoke(IPC_READ_CLIPBOARD_KEY, 'suggest')),
  onCommand: (listener: Listener): (() => void) => {
    listeners.add(listener);
    for (const command of early.splice(0)) listener(command);
    return () => {
      listeners.delete(listener);
    };
  },
});
