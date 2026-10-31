/**
 * Wires the office's Pokémon sounds to the page: the transport's messages,
 * the selected character, the Sounds switch, the per-device preferences and
 * the sound pack go into one SoundController (soundController.ts), which
 * plays through the office's AudioEngine.
 *
 * Subscribes to the transport itself, so the message handlers in
 * useExtensionMessages stay untouched apart from leaving stream agents'
 * status chimes to this module (audio/chimeHandoff.ts).
 */

import { useEffect, useRef } from 'react';

import { isSoundEnabled, sharedAudioContext, unlockAudio } from '../notificationSound.js';
import { isBrowserRuntime, isE2E } from '../runtime.js';
import { transport } from '../transport/index.js';
import { AudioEngine } from './audioEngine.js';
import { SoundController } from './soundController.js';
import type { SfxName, SoundEvent } from './soundEvents.js';
import { SoundLimiter } from './soundLimiter.js';
import { getSoundPack, refreshSoundPack, subscribeSoundPack } from './soundPack.js';
import { SoundDirector } from './soundPolicy.js';
import { getSoundPrefs, subscribeSoundPrefs } from './soundPrefs.js';

let selectedAgentId: () => number | null = () => null;

/** E2E: log each played event beside the chime log (testHooks.ts). */
function recordForTests(event: SoundEvent): void {
  if (!isE2E || typeof window === 'undefined') return;
  const hooks = (window.__pixelAgentsTestHooks ??= {});
  (hooks.playedSounds ??= []).push({ kind: `pokemon:${event.name}`, at: Date.now() });
}

/** The office's one engine, on the AudioContext the chimes share. */
const audioEngine = new AudioEngine({ context: sharedAudioContext, unlock: unlockAudio });

const controller = new SoundController({
  director: new SoundDirector(),
  limiter: new SoundLimiter(),
  engine: audioEngine,
  soundEnabled: isSoundEnabled,
  prefs: getSoundPrefs,
  selectedAgentId: () => selectedAgentId(),
  onPlayed: recordForTests,
});

/**
 * Activation-triggering events. A touch `pointerdown` isn't one in Chrome or
 * WebKit; its `pointerup`, `touchend` and `click` are.
 */
const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;

/**
 * Play a UI blip (a Pokédex tab, a panel), if effects are on. For the
 * Pokédex tabs, which live outside this module.
 * @public
 */
export function playUiBlip(): void {
  controller.blip();
}

/** Settings → Test sounds: plays only what the Sounds switch and the
 *  Cries / Alerts / Effects toggles allow. */
export function testSound(name: SfxName | 'cry'): void {
  controller.test(name);
}

/** Silence every Pokémon sound now (Sounds switched off). */
export function stopAllSounds(): void {
  audioEngine.stopAll();
}

/** Whether testSound(name) can make a sound right now. */
export function canTestSound(name: SfxName | 'cry'): boolean {
  return controller.canTest(name);
}

/**
 * Mount once in App, right after useConductorFeed (before
 * useExtensionMessages sends webviewReady). `getSelectedAgentId` reads the
 * office's selected character for the "done" rule.
 */
export function usePokemonSounds(getSelectedAgentId: () => number | null): void {
  useEffect(() => {
    selectedAgentId = getSelectedAgentId;
    const offMessage = transport.onMessage((msg) => controller.handle(msg));
    // A (re)connect is followed by a replay: keep it quiet.
    if (transport.state === 'connected') controller.connected();
    const offState = transport.onStateChange((state) => {
      if (state === 'connected') controller.connected();
      else audioEngine.stopAll();
    });
    // Any gesture unlocks the AudioContext (the canvas does too).
    const unlock = () => {
      unlockAudio();
      controller.gesture();
    };
    for (const type of GESTURE_EVENTS) window.addEventListener(type, unlock, { capture: true });
    audioEngine.setVolume(getSoundPrefs().volume);
    const offPrefs = subscribeSoundPrefs(() => audioEngine.setVolume(getSoundPrefs().volume));
    const offPack = subscribeSoundPack(() => audioEngine.setPackOverrides(getSoundPack()));
    if (isBrowserRuntime) void refreshSoundPack();
    return () => {
      offMessage();
      offState();
      offPrefs();
      offPack();
      for (const type of GESTURE_EVENTS) {
        window.removeEventListener(type, unlock, { capture: true });
      }
      audioEngine.stopAll();
    };
  }, [getSelectedAgentId]);
}

/** Opening a Pokédex plays its Pokémon's cry; closing it, a blip. */
export function usePokedexSounds(detailAgentId: number | null): void {
  const previous = useRef<number | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = detailAgentId;
    controller.pokedexChanged(detailAgentId, before);
  }, [detailAgentId]);
}
