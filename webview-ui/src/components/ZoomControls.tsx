import { useEffect, useRef, useState } from 'react';

import {
  ZOOM_LEVEL_FADE_DELAY_MS,
  ZOOM_LEVEL_FADE_DURATION_SEC,
  ZOOM_LEVEL_HIDE_DELAY_MS,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../constants.js';
import { Button } from './ui/Button.js';

interface ZoomControlsProps {
  zoom: number;
  onZoomChange: (zoom: number) => void;
}

/** The zoom level ("3x"), shown briefly after each change. A pill with no
 *  position of its own: OfficeTopBar stacks it with the top-centre pills. */
export function ZoomLevelIndicator({ zoom }: { zoom: number }) {
  const [showLevel, setShowLevel] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevZoomRef = useRef(zoom);

  // Show zoom level briefly when zoom changes
  useEffect(() => {
    if (zoom === prevZoomRef.current) return;
    prevZoomRef.current = zoom;

    // Clear existing timers
    if (timerRef.current) clearTimeout(timerRef.current);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);

    setShowLevel(true);
    setFadeOut(false);

    // Start fade after delay
    fadeTimerRef.current = setTimeout(() => {
      setFadeOut(true);
    }, ZOOM_LEVEL_FADE_DELAY_MS);

    // Hide completely after delay
    timerRef.current = setTimeout(() => {
      setShowLevel(false);
      setFadeOut(false);
    }, ZOOM_LEVEL_HIDE_DELAY_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, [zoom]);

  if (!showLevel) return null;
  return (
    <div
      className="pixel-panel pb-4 px-16 text-lg select-none pointer-events-none"
      style={{
        opacity: fadeOut ? 0 : 1,
        transition: `opacity ${ZOOM_LEVEL_FADE_DURATION_SEC}s ease-out`,
      }}
    >
      {zoom}x
    </div>
  );
}

export function ZoomControls({ zoom, onZoomChange }: ZoomControlsProps) {
  const minDisabled = zoom <= ZOOM_MIN;
  const maxDisabled = zoom >= ZOOM_MAX;

  return (
    // Vertically stacked buttons, top-left (ZOOM_CONTROLS_RIGHT_PX and
    // ZOOM_CONTROLS_BOTTOM_PX are their outer edges).
    <div className="absolute top-8 left-8 z-10 flex flex-col gap-4">
      <Button
        size="icon_lg"
        onClick={() => onZoomChange(zoom + 1)}
        disabled={maxDisabled}
        className="border-border! shadow-pixel disabled:hover:bg-btn-bg disabled:cursor-default disabled:opacity-(--btn-disabled-opacity)"
        title="Zoom in (Ctrl+Scroll)"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <line
            x1="9"
            y1="3"
            x2="9"
            y2="15"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <line
            x1="3"
            y1="9"
            x2="15"
            y2="9"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </Button>
      <Button
        size="icon_lg"
        onClick={() => onZoomChange(zoom - 1)}
        disabled={minDisabled}
        className="border-border! shadow-pixel disabled:hover:bg-btn-bg disabled:cursor-default disabled:opacity-(--btn-disabled-opacity)"
        title="Zoom out (Ctrl+Scroll)"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <line
            x1="3"
            y1="9"
            x2="15"
            y2="9"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </Button>
    </div>
  );
}
