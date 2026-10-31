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
  | {
      kind: 'sfx';
      name: SfxName;
      delayMs: number;
      /** The delay only lets the event's cry go first: with no cry left
       *  (Cries off, theme off, no cry for the species) it plays at once. */
      afterCry?: boolean;
    }
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

/** An effect that waits `delayMs` for the event's cry, and only for it. */
export const sfxAfterCry = (name: SfxName, delayMs: number): SoundCue => ({
  kind: 'sfx',
  name,
  delayMs,
  afterCry: true,
});

/** The cues `keep` lets through. When no cry is left, a cue that only
 *  waited for one (`afterCry`) plays at once instead. */
export function keepCues(cues: readonly SoundCue[], keep: (cue: SoundCue) => boolean): SoundCue[] {
  const kept = cues.filter(keep);
  if (kept.some((c) => c.kind === 'cry')) return kept;
  return kept.map((c) => (c.kind === 'sfx' && c.afterCry ? sfx(c.name) : c));
}

export const cry = (dex: number, delayMs = 0, semitones = 0): SoundCue => ({
  kind: 'cry',
  dex,
  semitones,
  delayMs,
});
