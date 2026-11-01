import type { ReactNode } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

import { DROPDOWN_VIEWPORT_MARGIN_PX } from '../../constants.js';

/** Which side of its anchor a Dropdown opens on. */
export type DropdownPlacement = 'up' | 'down';

interface DropdownProps {
  isOpen: boolean;
  children: ReactNode;
  className?: string;
  /** 'up' (the default) opens above the anchor, 'down' below it. */
  placement?: DropdownPlacement;
  /**
   * Cap the panel's height at the room between its anchor and the edge on the
   * side it opens to: the viewport's opening up; opening down, the bottom of
   * the region that clips it (the office region ends above the message bar),
   * and its width at the room to the right of it in that region. The app
   * hides overflow, so content taller or wider than that room would otherwise
   * be cut off.
   * The panel becomes a flex column: give the child that should scroll
   * `min-h-0 overflow-y-auto` and pin the rest with `shrink-0`.
   */
  fitViewport?: boolean;
}

/** The right and bottom edges (viewport px) of the nearest ancestor that clips
 *  overflow (the office region: beside the party bar, above the message bar),
 *  else of the viewport. */
function clipEdges(element: HTMLElement): { right: number; bottom: number } {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowX !== 'visible') {
      const { right, bottom } = node.getBoundingClientRect();
      return { right, bottom: Math.min(bottom, window.innerHeight) };
    }
  }
  return { right: window.innerWidth, bottom: window.innerHeight };
}

export function Dropdown({
  isOpen,
  children,
  className = '',
  placement = 'up',
  fitViewport = false,
}: DropdownProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [maxSize, setMaxSize] = useState<{ height?: number; width?: number }>({});

  // Measured rather than expressed in CSS: the anchor sits at a different
  // place on every shell (desktop toolbar at the top, phone card bar above a
  // software keyboard, a short VS Code panel), and only its live position
  // says how much room is left. The panel's edge facing the anchor is pinned
  // to it, so its far edge is that room whatever height it currently has.
  useLayoutEffect(() => {
    if (!isOpen || !fitViewport) return;
    const measure = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const box = panel.getBoundingClientRect();
      const margin = DROPDOWN_VIEWPORT_MARGIN_PX;
      if (placement === 'up') {
        setMaxSize({ height: Math.max(0, Math.floor(box.bottom - margin)) });
        return;
      }
      const clip = clipEdges(panel);
      setMaxSize({
        height: Math.max(0, Math.floor(clip.bottom - box.top - margin)),
        width: Math.max(0, Math.floor(clip.right - box.left - margin)),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [isOpen, fitViewport, placement]);

  if (!isOpen) return null;

  return (
    // The padding bridges the gap to the anchor, so a pointer moving from the
    // anchor onto the panel never leaves the pair (the launch drawer closes
    // on mouse leave).
    <div
      className={`absolute left-0 z-10 ${placement === 'up' ? 'bottom-full pb-10' : 'top-full pt-10'}`}
    >
      <div
        ref={panelRef}
        style={fitViewport ? { maxHeight: maxSize.height, maxWidth: maxSize.width } : undefined}
        className={`bg-bg border-2 border-border rounded-none shadow-pixel p-4 ${
          fitViewport ? 'flex flex-col' : ''
        } ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

interface DropdownItemProps {
  onClick: () => void;
  children: ReactNode;
  className?: string;
}

export function DropdownItem({ onClick, children, className = '' }: DropdownItemProps) {
  return (
    <button
      onClick={onClick}
      className={`block w-full text-left py-2 px-12 bg-transparent border-none rounded-none cursor-pointer whitespace-nowrap hover:bg-btn-bg ${className}`}
    >
      {children}
    </button>
  );
}
