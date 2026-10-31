/**
 * WAI-ARIA tabs, the keyboard part (DOM-free, Node-tested): which tab an
 * arrow key (wrapping), Home or End moves to.
 */

/** The tab index `key` moves to from `index` among `count` tabs, or null
 *  when the key doesn't move between tabs. */
export function tabKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const from = Math.min(Math.max(index, 0), count - 1);
  switch (key) {
    case 'ArrowRight':
      return (from + 1) % count;
    case 'ArrowLeft':
      return (from - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** The id of one tab, and of the panel the tabs control. */
export function tabButtonId(prefix: string, tab: string): string {
  return `${prefix}-tab-${tab}`;
}

export function tabPanelId(prefix: string): string {
  return `${prefix}-panel`;
}
