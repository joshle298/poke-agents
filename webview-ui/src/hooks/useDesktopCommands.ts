import { useEffect, useRef, useState } from 'react';

import { DESKTOP_OPEN_SESSION_WAIT_MS } from '../constants.js';
import { desktopBridge, parseDesktopCommand } from '../desktopApp.js';

export interface DesktopCommandHandlers {
  /** Whether the agent is in the office now. */
  isInOffice: (agentId: number) => boolean;
  /** A notification for this session was clicked: show its Pokédex. */
  openSession: (agentId: number) => void;
  /** Poke Agents > Settings… (Cmd-,). */
  openSettings: () => void;
}

/**
 * Commands from the desktop app (its menu, a notification click), through
 * the preload's bridge. A browser has no bridge, so nothing subscribes. A
 * session that isn't in the office yet (the click opened a new window, still
 * loading) opens when it arrives, if it does within a few seconds.
 */
export function useDesktopCommands(handlers: DesktopCommandHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    if (!desktopBridge) return;
    return desktopBridge.onCommand((raw) => {
      const command = parseDesktopCommand(raw);
      if (command?.type === 'openSession') setPending(command.agentId);
      else if (command?.type === 'openSettings') latest.current.openSettings();
    });
  }, []);

  const pendingInOffice = pending !== null && handlers.isInOffice(pending);
  useEffect(() => {
    if (pending === null) return;
    if (pendingInOffice) {
      latest.current.openSession(pending);
      setPending(null);
      return;
    }
    const timer = setTimeout(() => setPending(null), DESKTOP_OPEN_SESSION_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pending, pendingInOffice]);
}
