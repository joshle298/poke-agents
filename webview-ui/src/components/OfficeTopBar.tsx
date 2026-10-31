import type { ReactNode } from 'react';

import {
  OFFICE_TOOLBAR_Z_INDEX,
  OFFICE_TOP_BAR_EDGE_PX,
  OFFICE_TOP_BAR_GAP_PX,
  OFFICE_TOP_BAR_STACK_GAP_PX,
  ZOOM_CONTROLS_RIGHT_PX,
} from '../constants.js';
import { useBoxSize } from '../hooks/useBoxSize.js';
import { Toasts } from './Toasts.js';
import { placeTopBar } from './topBarLayout.js';

interface OfficeTopBarProps {
  /** What covers the office's right edge, as a CSS length (the upstream card
   *  column, the Pokédex drawer): everything here stays left of it. */
  rightInset: string;
  /** The toolbar; null in a read-only office. */
  toolbar: ReactNode;
  /** Right-aligned under the toolbar (the now-playing pill, the first-run
   *  tooltip). Each item takes its own pointer events and z-index. */
  belowToolbar: ReactNode;
  /** The top-centre pills, stacked (EditActionBar, the rotate hint, the zoom
   *  level, the connection status, "View only"). */
  centre: ReactNode;
}

/**
 * The desktop office's top chrome, in the free area left of whatever covers
 * the office's right edge (the party bar and a docked Pokédex sit outside the
 * office region already): the toolbar in the top-right corner with the
 * now-playing pill and the first-run tooltip under it, the top-centre pills,
 * and the toast stack. Sizes are measured and placed by `placeTopBar`, which
 * moves the centre pills under the toolbar when they don't fit beside it.
 *
 * The area and the column set no z-index, so each piece keeps its own place in
 * the page's stacking order (the toolbar over the characters' labels, toasts
 * over the modals); the wrappers pass pointer events through to the office.
 */
export function OfficeTopBar({ rightInset, toolbar, belowToolbar, centre }: OfficeTopBarProps) {
  const [areaRef, area] = useBoxSize<HTMLDivElement>();
  const [columnRef, column] = useBoxSize<HTMLDivElement>();
  const [toolbarRef, toolbarBox] = useBoxSize<HTMLDivElement>();
  const [laneRef, lane] = useBoxSize<HTMLDivElement>();
  const placement = placeTopBar({
    areaWidth: area.width,
    toolbarWidth: toolbarBox.width,
    columnHeight: column.height,
    laneWidth: lane.width,
    laneHeight: lane.height,
  });

  return (
    <div
      ref={areaRef}
      className="absolute top-0 bottom-0 left-0 pointer-events-none"
      style={{ right: rightInset }}
    >
      <div
        className="absolute left-0 right-0 z-20 flex justify-center"
        style={{ top: placement.laneTop }}
      >
        <div
          ref={laneRef}
          className="flex flex-col items-center"
          style={{ gap: OFFICE_TOP_BAR_STACK_GAP_PX }}
        >
          {centre}
        </div>
      </div>
      <div
        ref={columnRef}
        className="absolute flex flex-col items-end"
        style={{
          top: OFFICE_TOP_BAR_EDGE_PX,
          right: OFFICE_TOP_BAR_EDGE_PX,
          gap: OFFICE_TOP_BAR_STACK_GAP_PX,
          // Never over the zoom buttons: a toolbar wider than the room left
          // wraps onto a second row instead.
          maxWidth: `calc(100% - ${OFFICE_TOP_BAR_EDGE_PX + ZOOM_CONTROLS_RIGHT_PX + OFFICE_TOP_BAR_GAP_PX}px)`,
        }}
      >
        {toolbar && (
          <div
            ref={toolbarRef}
            className="relative max-w-full"
            style={{ zIndex: OFFICE_TOOLBAR_Z_INDEX }}
          >
            {toolbar}
          </div>
        )}
        {belowToolbar}
      </div>
      <Toasts officeTopPx={placement.toastsTop} />
    </div>
  );
}
