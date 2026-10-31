import {
  NOTIFICATION_NOTE_1_HZ,
  NOTIFICATION_NOTE_1_START_SEC,
  NOTIFICATION_NOTE_2_HZ,
  NOTIFICATION_NOTE_2_START_SEC,
  NOTIFICATION_NOTE_DURATION_SEC,
  NOTIFICATION_VOLUME,
  PERMISSION_NOTE_1_HZ,
  PERMISSION_NOTE_1_START_SEC,
  PERMISSION_NOTE_2_HZ,
  PERMISSION_NOTE_2_START_SEC,
  PERMISSION_NOTE_DURATION_SEC,
  PERMISSION_VOLUME,
} from './constants.js';
import { isE2E } from './runtime.js';

let soundEnabled = true;
let audioCtx: AudioContext | null = null;

/** E2E test hook: append every (attempted) sound invocation to a window-side log
 *  under window.__pixelAgentsTestHooks.playedSounds (namespace and type
 *  declared by testHooks.ts). Records BEFORE the soundEnabled gate so tests
 *  verify dispatch independent of user audio prefs. Gated on the e2e harness
 *  flag so this unbounded log never grows in a real session. */
function recordSoundForTests(kind: 'done' | 'permission'): void {
  if (!isE2E || typeof window === 'undefined') return;
  if (!window.__pixelAgentsTestHooks) window.__pixelAgentsTestHooks = {};
  if (!window.__pixelAgentsTestHooks.playedSounds) {
    window.__pixelAgentsTestHooks.playedSounds = [];
  }
  window.__pixelAgentsTestHooks.playedSounds.push({ kind, at: Date.now() });
}

/** Which sound an agentStatus deserves: the done chime, the attention tap,
 *  or none. */
export type StatusChime = 'done' | 'attention' | null;

export interface StatusChimeInput {
  status: string;
  /** status is 'waiting' and the agent asked the user something. */
  awaitingInput: boolean;
  /** A seeding / reconnect resend — never a sound. */
  silent: boolean;
  /** Fed by a stream provider (Conductor): dozens of them run at once. */
  streamAgent: boolean;
  /** The agent is the office's selected character. */
  selected: boolean;
  /** The status differs from the last one this client saw for the agent. */
  changed: boolean;
}

/**
 * Chime policy. Upstream agents keep the upstream rule (every finished turn
 * chimes). A stream agent chimes only when it needs an answer, when the
 * selected agent errors (attention tap), or when the selected agent's status
 * changes to an inactive form — an office of forty cloud sessions would
 * otherwise chime constantly. Silent resends never sound. The Settings sound
 * switch still gates playback itself.
 */
export function statusChimeFor(input: StatusChimeInput): StatusChime {
  if (input.silent) return null;
  if (!input.streamAgent) return input.status === 'waiting' ? 'done' : null;
  if (input.status === 'waiting' && input.awaitingInput) return 'done';
  if (!input.selected) return null;
  if (input.status === 'error') return 'attention';
  if (input.status === 'waiting' && input.changed) return 'done';
  return null;
}

export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled;
}

export function isSoundEnabled(): boolean {
  return soundEnabled;
}

function playNote(
  ctx: AudioContext,
  freq: number,
  startOffset: number,
  duration: number = NOTIFICATION_NOTE_DURATION_SEC,
  volume: number = NOTIFICATION_VOLUME,
): void {
  const t = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);

  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(t);
  osc.stop(t + duration);
}

export async function playDoneSound(): Promise<void> {
  recordSoundForTests('done');
  if (!soundEnabled) return;
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext();
    }
    // Resume suspended context (webviews suspend until user gesture)
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    // Ascending two-note chime: E5 → B5
    playNote(audioCtx, NOTIFICATION_NOTE_1_HZ, NOTIFICATION_NOTE_1_START_SEC);
    playNote(audioCtx, NOTIFICATION_NOTE_2_HZ, NOTIFICATION_NOTE_2_START_SEC);
  } catch {
    // Audio may not be available
  }
}

export async function playPermissionSound(): Promise<void> {
  recordSoundForTests('permission');
  if (!soundEnabled) return;
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    // Descending two-note tap: A5 → E5
    playNote(
      audioCtx,
      PERMISSION_NOTE_1_HZ,
      PERMISSION_NOTE_1_START_SEC,
      PERMISSION_NOTE_DURATION_SEC,
      PERMISSION_VOLUME,
    );
    playNote(
      audioCtx,
      PERMISSION_NOTE_2_HZ,
      PERMISSION_NOTE_2_START_SEC,
      PERMISSION_NOTE_DURATION_SEC,
      PERMISSION_VOLUME,
    );
  } catch {
    // Audio may not be available
  }
}

/** Call from any user-gesture handler to ensure AudioContext is unlocked */
export function unlockAudio(): void {
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  } catch {
    // ignore
  }
}
