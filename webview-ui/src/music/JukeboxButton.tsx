import { Button } from '../components/ui/Button.js';
import { MenuItem } from '../components/ui/MenuItem.js';
import { isBrowserRuntime } from '../runtime.js';
import { musicStore, useMusic } from './musicStore.js';
import { JUKEBOX_UI_ATTRIBUTE } from './resumeOnGesture.js';

const attrs = { [JUKEBOX_UI_ATTRIBUTE]: '' };

/** The Music toolbar button: opens and closes the Jukebox (standalone only).
 *  A text label like its neighbours (Sessions, PC, Layout, Settings), so it
 *  shares their height and padding; an icon glyph's tighter line box made it
 *  render smaller than the rest of the row. */
export function JukeboxButton({
  size = 'lg',
  className = '',
}: {
  size?: 'sm' | 'lg';
  className?: string;
}) {
  const open = useMusic((s) => s.open);
  if (!isBrowserRuntime) return null;
  return (
    <Button
      {...attrs}
      variant={open ? 'active' : 'default'}
      size={size}
      onClick={() => musicStore.setOpen(!open)}
      title="Jukebox"
      className={className}
    >
      Music
    </Button>
  );
}

/** Settings → Sound → Jukebox… (standalone only). */
export function JukeboxMenuItem({ onBeforeOpen }: { onBeforeOpen: () => void }) {
  if (!isBrowserRuntime) return null;
  return (
    <div {...attrs}>
      <MenuItem
        onClick={() => {
          onBeforeOpen();
          musicStore.setOpen(true);
        }}
      >
        Jukebox…
      </MenuItem>
    </div>
  );
}
