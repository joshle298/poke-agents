import { describe, expect, it, vi } from 'vitest';

import type { MusicSourceId } from '../../core/src/messages.js';
import { MusicStore } from '../src/music/musicStore.js';
import type { MusicPrefs } from '../src/music/preferences.js';
import { activateSource } from '../src/music/sourceSwitch.js';

const PREFS: MusicPrefs = {
  source: 'folder',
  station: null,
  track: null,
  shuffle: false,
  volume: 0.6,
  playing: false,
};

function setup(prefs: Partial<MusicPrefs> = {}) {
  const store = new MusicStore({ ...PREFS, ...prefs });
  const deps = {
    store,
    pauseFolder: vi.fn(),
    pauseApp: vi.fn(),
    remember: vi.fn<(source: MusicSourceId) => void>(),
  };
  return { store, deps };
}

describe('activateSource', () => {
  it('pauses folder music when an app starts', () => {
    const { store, deps } = setup();
    activateSource('spotify', deps);
    expect(deps.pauseFolder).toHaveBeenCalledTimes(1);
    expect(deps.pauseApp).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ activeSource: 'spotify', appStarted: true });
    expect(deps.remember).toHaveBeenCalledWith('spotify');
  });

  it('pauses the app that is playing when folder music starts', () => {
    const { store, deps } = setup({ source: 'apple' });
    store.apply({ type: 'musicState', source: 'apple', running: true, playing: true });
    activateSource('folder', deps);
    expect(deps.pauseApp).toHaveBeenCalledWith('apple');
    expect(deps.pauseFolder).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ activeSource: 'folder', appStarted: false });
  });

  it('pauses the other app when switching between apps, but not an idle one', () => {
    const { store, deps } = setup({ source: 'apple' });
    store.apply({ type: 'musicState', source: 'apple', running: true, playing: true });
    activateSource('spotify', deps);
    expect(deps.pauseApp).toHaveBeenCalledWith('apple');

    const idle = setup({ source: 'apple' });
    idle.store.apply({ type: 'musicState', source: 'apple', running: true, playing: false });
    activateSource('spotify', idle.deps);
    expect(idle.deps.pauseApp).not.toHaveBeenCalled();
  });

  it('leaves the source alone when it is started again', () => {
    const { store, deps } = setup({ source: 'apple' });
    store.apply({ type: 'musicState', source: 'apple', running: true, playing: true });
    activateSource('apple', deps);
    expect(deps.pauseApp).not.toHaveBeenCalled();
  });
});
