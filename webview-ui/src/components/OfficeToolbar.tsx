import type { RefObject } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Directory } from '../hooks/useExtensionMessages.js';
import { JukeboxButton } from '../music/JukeboxButton.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { LaunchDrawer } from './LaunchDrawer.js';
import { balancedRowWidth } from './topBarLayout.js';
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
  /** The most the panel may be wide (CSS px): past it the buttons wrap onto
   *  balanced rows. Undefined: as wide as one row. */
  maxWidth?: number;
}

/** The panel's buttons and its frame, measured (CSS px). */
interface RowMetrics {
  items: number[];
  gap: number;
  /** Padding and border, both sides. */
  frame: number;
}

/**
 * The panel's button widths, gap and frame, kept current as buttons come and
 * go (Sessions and PC follow Conductor) and change size (the pixel font
 * loading). They don't depend on how the row wraps.
 */
function useRowMetrics(panelRef: RefObject<HTMLDivElement | null>): RowMetrics | null {
  const [metrics, setMetrics] = useState<RowMetrics | null>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => {
      const style = getComputedStyle(panel);
      const px = (value: string) => parseFloat(value) || 0;
      const next: RowMetrics = {
        items: Array.from(panel.children, (child) => child.getBoundingClientRect().width),
        gap: px(style.columnGap),
        frame:
          px(style.paddingLeft) +
          px(style.paddingRight) +
          px(style.borderLeftWidth) +
          px(style.borderRightWidth),
      };
      setMetrics((prev) =>
        prev &&
        prev.gap === next.gap &&
        prev.frame === next.frame &&
        prev.items.length === next.items.length &&
        prev.items.every((width, i) => width === next.items[i])
          ? prev
          : next,
      );
    };
    const sizes = new ResizeObserver(measure);
    const observeItems = () => {
      sizes.disconnect();
      for (const child of panel.children) sizes.observe(child);
      measure();
    };
    observeItems();
    const items = new MutationObserver(observeItems);
    items.observe(panel, { childList: true });
    return () => {
      sizes.disconnect();
      items.disconnect();
    };
  }, [panelRef]);
  return metrics;
}

/**
 * The office's toolbar: + Agent (with its launch drawer) when Claude Code feeds
 * the office, Sessions and PC when Conductor does, then Music, Layout and
 * Settings. One row in the office's top-right corner, placed by OfficeTopBar
 * (left of the party bar and the Pokédex); it wraps onto balanced rows only
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
  maxWidth,
}: OfficeToolbarProps) {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const launchRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const row = useRowMetrics(panelRef);

  // Too narrow for one row: as wide as the widest of the fewest balanced
  // rows, so the panel hugs them instead of stretching to maxWidth.
  const oneRow = row
    ? row.items.reduce((sum, w) => sum + w, 0) + row.gap * (row.items.length - 1)
    : 0;
  const wrapped = row !== null && maxWidth !== undefined && oneRow + row.frame > maxWidth;
  const panelWidth = wrapped
    ? Math.ceil(balancedRowWidth(row.items, row.gap, maxWidth - row.frame)) + row.frame
    : undefined;

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
    <div
      ref={panelRef}
      className="flex flex-wrap justify-end items-center gap-4 pixel-panel p-4 pointer-events-auto"
      style={{ width: panelWidth }}
    >
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
