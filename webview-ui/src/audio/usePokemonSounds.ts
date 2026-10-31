/**
 * Wires the office's Pokémon sounds: every ServerMessage goes through the
 * SoundDirector (what deserves a sound), the SoundLimiter (how many play)
 * and the AudioEngine (playing them), gated by the server's sound switch
 * and the per-device Cries / Alerts / Effects toggles.
 *
 * Subscribes to the transport itself, so the message handlers in
 * useExtensionMessages stay untouched apart from leaving stream agents'
 * status chimes to this module.
 */

import { useEffect, useRef } from 'react';

import type { ServerMessage } from '../../../core/src/messages.js';
import { isSoundEnabled, unlockAudio } from '../notificationSound.js';
import { isBrowserRuntime, isE2E } from '../runtime.js';
import { transport } from '../transport/index.js';
import { audioEngine } from './audioEngine.js';
import type { SfxName, SoundCue, SoundEvent } from './soundEvents.js';
import { cueCategory } from './soundEvents.js';
import { SoundLimiter } from './soundLimiter.js';
import { getSoundPack, refreshSoundPack, subscribeSoundPack } from './soundPack.js';
import { SoundDirector } from './soundPolicy.js';
import { getSoundPrefs, subscribeSoundPrefs } from './soundPrefs.js';

const director = new SoundDirector();
const limiter = new SoundLimiter();
let selectedAgentId: () => number | null = () => null;

/** E2E: log each played event beside the chime log (testHooks.ts). */
function recordForTests(event: SoundEvent): void {
  if (!isE2E || typeof window === 'undefined') return;
  const hooks = (window.__pixelAgentsTestHooks ??= {});
  (hooks.playedSounds ??= []).push({ kind: `pokemon:${event.name}`, at: Date.now() });
}

/** A cue the user's toggles allow and the engine can play. */
function allowed(cue: SoundCue): boolean {
  if (!getSoundPrefs()[cueCategory(cue)]) return false;
  return cue.kind !== 'cry' || audioEngine.hasCry(cue.dex);
}

function dispatch(events: SoundEvent[]): void {
  if (events.length === 0 || !isSoundEnabled()) return;
  for (const event of events) {
    // Nothing playable: don't spend the event's cooldown on silence.
    if (!event.cues.some(allowed)) continue;
    if (event.user) {
      if (!limiter.admit(event, Date.now())) continue;
      recordForTests(event);
      void audioEngine.playUserEvent(event, allowed);
      continue;
    }
    // Before the first click the context is locked: drop, never queue.
    if (!audioEngine.isRunning() || !limiter.admit(event, Date.now())) continue;
    recordForTests(event);
    audioEngine.playEvent(event, allowed);
  }
}

function onMessage(msg: ServerMessage): void {
  if (msg.type === 'pokemonSpeciesLoaded' && typeof msg.cry === 'string') {
    audioEngine.setCryUrl(msg.dex, msg.cry);
    if (isSoundEnabled() && getSoundPrefs().cries) audioEngine.prefetchCry(msg.dex);
  }
  dispatch(director.handle(msg, { now: Date.now(), selectedAgentId: selectedAgentId() }));
}

/** The cry the Settings "Cry" test plays: the selected Pokémon's, else any. */
export function testCryDex(): number | undefined {
  const selected = selectedAgentId();
  const species = selected !== null ? director.speciesOf(selected) : undefined;
  return species !== undefined && audioEngine.hasCry(species) ? species : audioEngine.anyCryDex();
}

/** Play a UI blip (a Pokédex tab, a panel), if effects are on. */
export function playUiBlip(): void {
  dispatch([{ name: 'uiBlip', cues: [{ kind: 'sfx', name: 'blip', delayMs: 0 }], user: true }]);
}

/** Settings → Test sounds. Plays whatever the toggles say. */
export function testSound(name: SfxName | 'cry'): void {
  if (name !== 'cry') {
    void audioEngine.testSfx(name);
    return;
  }
  const dex = testCryDex();
  if (dex !== undefined) void audioEngine.testCry(dex);
}

/**
 * Mount once in App, right after useConductorFeed (before
 * useExtensionMessages sends webviewReady). `getSelectedAgentId` reads the
 * office's selected character for the "done" rule.
 */
export function usePokemonSounds(getSelectedAgentId: () => number | null): void {
  useEffect(() => {
    selectedAgentId = getSelectedAgentId;
    const offMessage = transport.onMessage(onMessage);
    // A (re)connect is followed by a replay: keep it quiet.
    if (transport.state === 'connected') director.connected(Date.now());
    const offState = transport.onStateChange((state) => {
      if (state === 'connected') director.connected(Date.now());
      else audioEngine.stopAll();
    });
    // Any gesture unlocks the AudioContext (the canvas does too).
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    audioEngine.setVolume(getSoundPrefs().volume);
    const offPrefs = subscribeSoundPrefs(() => audioEngine.setVolume(getSoundPrefs().volume));
    const offPack = subscribeSoundPack(() => audioEngine.setPackOverrides(getSoundPack()));
    if (isBrowserRuntime) void refreshSoundPack();
    return () => {
      offMessage();
      offState();
      offPrefs();
      offPack();
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
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
    if (detailAgentId === before) return;
    if (detailAgentId !== null) dispatch(director.pokedexOpened(detailAgentId));
    else if (before !== null && director.isPresent(before)) dispatch(director.pokedexClosed());
  }, [detailAgentId]);
}
