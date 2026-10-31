import type { CSSProperties } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { Button } from '../components/ui/Button.js';
import { Checkbox } from '../components/ui/Checkbox.js';
import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { SOUND_PACK_FOLDER_LABEL } from './constants.js';
import type { SfxName, SoundCategory } from './soundEvents.js';
import { getSoundPack, refreshSoundPack, subscribeSoundPack } from './soundPack.js';
import {
  getSoundPrefs,
  setSoundCategory,
  setSoundVolume,
  subscribeSoundPrefs,
} from './soundPrefs.js';
import { canTestSound, stopAllSounds, testSound } from './usePokemonSounds.js';

const CATEGORIES: ReadonlyArray<{ category: SoundCategory; label: string }> = [
  { category: 'cries', label: 'Cries' },
  { category: 'alerts', label: 'Alerts' },
  { category: 'effects', label: 'Effects' },
];

const TESTS: ReadonlyArray<{ sound: SfxName | 'cry'; label: string }> = [
  { sound: 'cry', label: 'Cry' },
  { sound: 'alert', label: 'Alert' },
  { sound: 'done', label: 'Done' },
  { sound: 'faint', label: 'Faint' },
  { sound: 'heal', label: 'Heal' },
  { sound: 'levelUp', label: 'Level up' },
  { sound: 'evolution', label: 'Evolution' },
  { sound: 'ballThrow', label: 'Throw' },
  { sound: 'ballPop', label: 'Pop' },
  { sound: 'recall', label: 'Recall' },
  { sound: 'message', label: 'Message' },
  { sound: 'blip', label: 'Blip' },
];

/**
 * Settings → Sound: the server's on/off switch, then this device's volume,
 * Cries / Alerts / Effects toggles, a test button per sound and the sound
 * pack files in use. Mounted only while Settings is open, so it reads the
 * current switch each time it opens.
 */
export function SoundSettings() {
  const [soundOn, setSoundOn] = useState(isSoundEnabled);
  const prefs = useSyncExternalStore(subscribeSoundPrefs, getSoundPrefs);
  const pack = useSyncExternalStore(subscribeSoundPack, getSoundPack);
  const volumePct = Math.round(prefs.volume * 100);

  // Pick up files dropped into the sound pack folder since the last look.
  useEffect(() => {
    if (isBrowserRuntime) void refreshSoundPack();
  }, []);

  return (
    <>
      <div className="mx-10 my-4 border-b border-border" />
      <div className="pt-2 px-10 text-xs text-accent">Sound</div>
      <Checkbox
        label="Sounds"
        checked={soundOn}
        onChange={() => {
          const next = !isSoundEnabled();
          setSoundEnabled(next);
          setSoundOn(next);
          if (!next) stopAllSounds();
          transport.send({ type: 'setSoundEnabled', enabled: next });
        }}
      />
      <label className="flex items-center gap-8 py-4 px-10">
        <span className="w-64 shrink-0">Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          value={volumePct}
          aria-label="Volume"
          onChange={(e) => setSoundVolume(Number(e.target.value) / 100)}
          // A blip at the new level once the slider is let go (Sounds and Effects on).
          onPointerUp={() => testSound('blip')}
          onKeyUp={() => testSound('blip')}
          className="pixel-range flex-1 min-w-0"
          style={{ '--range-fill': `${volumePct}%` } as CSSProperties}
        />
        <span className="w-32 text-right shrink-0 tabular-nums">{volumePct}</span>
      </label>
      {CATEGORIES.map(({ category, label }) => (
        <Checkbox
          key={category}
          label={label}
          checked={prefs[category]}
          onChange={() => setSoundCategory(category, !prefs[category])}
        />
      ))}
      <div className="flex flex-col gap-4 py-4 px-10">
        <span>Test sounds</span>
        <div className="flex flex-wrap gap-4">
          {TESTS.map(({ sound, label }) => {
            // Off with the Sounds switch or the sound's category toggle.
            const playable = soundOn && canTestSound(sound);
            return (
              <Button
                key={sound}
                variant={playable ? 'default' : 'disabled'}
                size="sm"
                disabled={!playable}
                onClick={() => testSound(sound)}
              >
                {label}
              </Button>
            );
          })}
        </div>
      </div>
      {isBrowserRuntime && (
        <div
          className="py-4 px-10 text-xs text-text-muted break-words"
          title={`Files in ${SOUND_PACK_FOLDER_LABEL} replace these sounds`}
        >
          Sound pack:{' '}
          {pack.length === 0
            ? `none (${SOUND_PACK_FOLDER_LABEL})`
            : pack.map((o) => `${o.event}.${o.format}`).join(', ')}
        </div>
      )}
      <div className="mx-10 my-4 border-b border-border" />
    </>
  );
}
