import { Button } from '../components/ui/Button.js';
import { MenuItem } from '../components/ui/MenuItem.js';
import { isBrowserRuntime } from '../runtime.js';
import { musicStore, useMusic } from './musicStore.js';
import { JUKEBOX_UI_ATTRIBUTE } from './useMusicFeed.js';

const attrs = { [JUKEBOX_UI_ATTRIBUTE]: '' };

/** The ♪ toolbar button: opens and closes the Jukebox (standalone only). */
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
      aria-label="Jukebox"
      className={className}
    >
      <span className="material-symbols-sharp block" aria-hidden="true">
        music_note
      </span>
    </Button>
  );
}

/** Settings → Jukebox… (standalone only). */
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
