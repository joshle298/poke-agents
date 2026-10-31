import { useEffect, useRef, useState } from 'react';

import type { Directory } from '../hooks/useExtensionMessages.js';
import { JukeboxButton } from '../music/JukeboxButton.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { LaunchDrawer } from './LaunchDrawer.js';
import { Button } from './ui/Button.js';

interface OfficeToolbarProps {
  isEditMode: boolean;
  onToggleEditMode: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  directories: Directory[];
  /** Drawer's pinned `+ Directory` row — opens the Directory modal empty. */
  onAddDirectory: () => void;
  /** Pencil on a user-defined row — opens the modal pre-filled. */
  onEditDirectory: (directory: Directory) => void;
  /** Standalone: server has a working PTY, so agents can be launched here. */
  terminalAvailable: boolean;
  /** Why the terminal is off (shown on the disabled button's tooltip). */
  terminalUnavailableReason: string | null;
  /** Claude Code feeds this office: + Agent launches it. Without it (a
   *  Conductor-only office) there is nothing to launch. */
  claudeActive: boolean;
  /** Conductor feeds this office: show Sessions and PC. */
  conductorActive: boolean;
  isSessionsOpen: boolean;
  onOpenSessions: () => void;
  isPcBoxOpen: boolean;
  onOpenPcBox: () => void;
}

/**
 * The office's toolbar: + Agent (with its launch drawer) when Claude Code feeds
 * the office, Sessions and PC when Conductor does, then Music, Layout and
 * Settings. One row in the office's top-right corner, placed by OfficeTopBar
 * (left of the party bar and the Pokédex); it wraps onto a second row only
 * when the office is too narrow for one.
 */
export function OfficeToolbar({
  isEditMode,
  onToggleEditMode,
  isSettingsOpen,
  onToggleSettings,
  directories,
  onAddDirectory,
  onEditDirectory,
  terminalAvailable,
  terminalUnavailableReason,
  claudeActive,
  conductorActive,
  isSessionsOpen,
  onOpenSessions,
  isPcBoxOpen,
  onOpenPcBox,
}: OfficeToolbarProps) {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const launchRef = useRef<HTMLDivElement>(null);

  // Close the launch drawer on outside press (the dropdown convention here).
  useEffect(() => {
    if (!isDrawerOpen) return;
    const handlePress = (e: PointerEvent) => {
      if (launchRef.current && !launchRef.current.contains(e.target as Node)) {
        setIsDrawerOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePress);
    return () => document.removeEventListener('pointerdown', handlePress);
  }, [isDrawerOpen]);

  // A plain press never launches: it opens the drawer, and the launch happens
  // from a Directory row. Opening (not toggling) so a click that follows the
  // hover — which already opened the drawer — doesn't close it.
  const handleAgentClick = () => {
    setIsDrawerOpen(true);
  };

  const handleDirectorySelect = (directory: Directory) => {
    setIsDrawerOpen(false);
    transport.send({ type: 'launchAgent', directoryPath: directory.path });
  };

  // Standalone can launch agents whenever the server has a working PTY. When it
  // doesn't, show the button disabled with the reason rather than hiding it —
  // silently missing UI reads as a bug, and the cause (a native module that
  // couldn't install) is not something a user would otherwise ever discover.
  const canLaunch = claudeActive && (!isBrowserRuntime || terminalAvailable);
  const showUnavailable = claudeActive && isBrowserRuntime && !terminalAvailable;

  return (
    <div className="flex flex-wrap justify-end items-center gap-4 pixel-panel p-4 pointer-events-auto">
      {showUnavailable && (
        <Button
          variant="disabled"
          disabled
          title={terminalUnavailableReason ?? 'Terminal unavailable on this server.'}
        >
          + Agent
        </Button>
      )}
      {canLaunch && (
        <div
          ref={launchRef}
          className="relative"
          // Hover is the desktop secondary gesture (long-press is the mobile
          // one): it opens the drawer without committing to a launch.
          onMouseEnter={() => setIsDrawerOpen(true)}
          onMouseLeave={() => setIsDrawerOpen(false)}
        >
          <Button
            variant="accent"
            onClick={handleAgentClick}
            className={isDrawerOpen ? 'bg-accent-bright' : 'bg-accent hover:bg-accent-bright'}
          >
            + Agent
          </Button>
          <LaunchDrawer
            isOpen={isDrawerOpen}
            placement="down"
            directories={directories}
            onSelect={handleDirectorySelect}
            onAddDirectory={() => {
              setIsDrawerOpen(false);
              onAddDirectory();
            }}
            onEditDirectory={(directory) => {
              setIsDrawerOpen(false);
              onEditDirectory(directory);
            }}
          />
        </div>
      )}
      {conductorActive && (
        <>
          <Button
            variant={isSessionsOpen ? 'active' : 'accent'}
            onClick={onOpenSessions}
            title="Choose which Conductor sessions are in the office"
          >
            Sessions
          </Button>
          <Button
            variant={isPcBoxOpen ? 'active' : 'default'}
            onClick={onOpenPcBox}
            title="PC Box: deposited (archived) sessions"
          >
            PC
          </Button>
        </>
      )}
      <JukeboxButton />
      <Button
        variant={isEditMode ? 'active' : 'default'}
        onClick={onToggleEditMode}
        title="Edit office layout"
      >
        Layout
      </Button>
      <Button
        variant={isSettingsOpen ? 'active' : 'default'}
        onClick={onToggleSettings}
        title="Settings"
      >
        Settings
      </Button>
    </div>
  );
}
