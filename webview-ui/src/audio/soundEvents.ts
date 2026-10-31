/**
 * The office's sound vocabulary: synthesized effects (SfxName), cues that
 * play one sound, and events that group the cues one happening triggers.
 * Pure types and tables, shared by the policy, the limiter and the engine.
 */

/** Synthesized effects. Also the sound pack's file names (`<name>.ogg`). */
export const SFX_NAMES = [
  'alert',
  'done',
  'faint',
  'heal',
  'levelUp',
  'evolution',
  'ballThrow',
  'ballPop',
  'recall',
  'message',
  'blip',
] as const;
export type SfxName = (typeof SFX_NAMES)[number];

/** The three Settings toggles. */
export type SoundCategory = 'cries' | 'alerts' | 'effects';

/** Alerts are the sounds that tell you something about your sessions;
 *  effects are flavour. */
export const SFX_CATEGORY: Readonly<Record<SfxName, SoundCategory>> = {
  alert: 'alerts',
  done: 'alerts',
  faint: 'alerts',
  heal: 'effects',
  levelUp: 'effects',
  evolution: 'effects',
  ballThrow: 'effects',
  ballPop: 'effects',
  recall: 'effects',
  message: 'effects',
  blip: 'effects',
};

/** One sound, `delayMs` after its event fires. */
export type SoundCue =
  | { kind: 'sfx'; name: SfxName; delayMs: number }
  | { kind: 'cry'; dex: number; semitones: number; delayMs: number };

export function cueCategory(cue: SoundCue): SoundCategory {
  return cue.kind === 'cry' ? 'cries' : SFX_CATEGORY[cue.name];
}

export type SoundEventName =
  /** Waiting on your answer or a permission. */
  | 'needsYou'
  | 'faint'
  /** An errored session working again. */
  | 'revived'
  | 'levelUp'
  | 'evolution'
  /** A new session thrown out by its Lead. */
  | 'spawned'
  /** Any other new session. */
  | 'arrived'
  | 'message'
  | 'recall'
  /** The selected or a pinned session finished its turn. */
  | 'done'
  /** The user opened a Pokédex (clicked a Pokémon). */
  | 'pokedex'
  /** A user-interface blip (Pokédex closed, a tab). */
  | 'uiBlip';

/** What one happening sounds like. The limiter admits or drops it whole. */
export interface SoundEvent {
  name: SoundEventName;
  /** The agent it is about (per-agent cooldowns). */
  agentId?: number;
  cues: SoundCue[];
  /** Started by a user gesture: no quiet window, cooldown or rate limit. */
  user?: boolean;
}

export const sfx = (name: SfxName, delayMs = 0): SoundCue => ({ kind: 'sfx', name, delayMs });

export const cry = (dex: number, delayMs = 0, semitones = 0): SoundCue => ({
  kind: 'cry',
  dex,
  semitones,
  delayMs,
});
