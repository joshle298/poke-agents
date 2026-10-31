import type { KeyboardEvent, ReactNode } from 'react';

import { Button } from './Button.js';
import { tabButtonId, tabKeyTarget, tabPanelId } from './tabKeys.js';

interface TabListProps<T extends string> {
  /** The tab list's accessible name. */
  label: string;
  /** Prefix of the tab and panel ids (unique on the page). */
  idPrefix: string;
  tabs: ReadonlyArray<{ id: T; label: ReactNode }>;
  selected: T;
  onSelect: (id: T) => void;
  className?: string;
}

/**
 * A row of tabs (the WAI-ARIA tab pattern): the selected tab is the one Tab
 * stop, arrow keys, Home and End move between tabs and select them. Render the
 * content in an element with role="tabpanel", id={tabPanelId(idPrefix)} and
 * aria-labelledby={tabButtonId(idPrefix, selected)}.
 */
export function TabList<T extends string>({
  label,
  idPrefix,
  tabs,
  selected,
  onSelect,
  className = '',
}: TabListProps<T>) {
  const index = tabs.findIndex((t) => t.id === selected);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = tabKeyTarget(e.key, index, tabs.length);
    if (next === null) return;
    e.preventDefault();
    onSelect(tabs[next].id);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className={`flex gap-4 ${className}`}
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab, i) => {
        const isSelected = tab.id === selected;
        return (
          <Button
            key={tab.id}
            id={tabButtonId(idPrefix, tab.id)}
            role="tab"
            aria-selected={isSelected}
            aria-controls={tabPanelId(idPrefix)}
            tabIndex={isSelected || (index === -1 && i === 0) ? 0 : -1}
            size="sm"
            variant={isSelected ? 'active' : 'default'}
            className="flex-1"
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </Button>
        );
      })}
    </div>
  );
}
