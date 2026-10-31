/**
 * The office window's preload: a small bridge and nothing else. The office
 * (the local server's page, sandboxed with context isolation) can ask the app
 * to reconnect to Conductor, ask for a Conductor API key on the clipboard
 * (the Connect card: main answers only key-shaped text, only to the focused
 * office window), and receives app commands: open a session's Pokédex after a
 * notification click, open Settings from the menu. Main checks that every
 * request comes from the office window.
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
  readClipboardKey: async (): Promise<string | null> => {
    const key: unknown = await ipcRenderer.invoke(IPC_READ_CLIPBOARD_KEY);
    return typeof key === 'string' ? key : null;
  },
  onCommand: (listener: Listener): (() => void) => {
    listeners.add(listener);
    for (const command of early.splice(0)) listener(command);
    return () => {
      listeners.delete(listener);
    };
  },
});
