/**
 * Office sound constants (webview-ui/src/audio/). Kept beside the module,
 * like server/src/pokemon/constants.ts, because nothing outside it reads them.
 */

import type { SoundEventName } from './soundEvents.js';

// ── Policy (soundPolicy.ts) ─────────────────────────────────────
/** No automatic sound for this long after the socket (re)connects or the
 *  server replays the office (existingAgents): replays are not news. */
export const SOUND_QUIET_AFTER_CONNECT_MS = 5_000;
/** Arrivals that keep coming within this gap of the quiet window (the
 *  server adopting sessions one by one at startup) are still the initial
 *  load: no throw or pop sounds until the stream pauses this long. */
export const SOUND_ARRIVAL_CHAIN_MS = 2_000;
/** A level jump bigger than this is a level being filled in (a session's
 *  real level arriving after a placeholder), not a level-up. */
export const SOUND_MAX_LEVEL_UP_STEP = 3;
/** A level change within this long of an agent's arrival (or of the office
 *  connecting) is its real level being filled in by the tail replay after
 *  adoption, not a level-up. */
export const SOUND_LEVEL_SETTLE_MS = 10_000;
/** A `spawned` message this soon after its child's arrival sound adds
 *  nothing: the arrival already threw the orb. */
export const SOUND_SPAWN_DEDUPE_MS = 5_000;
/** Cry pitch shift for a fainting Pokémon. */
export const SOUND_FAINT_CRY_SEMITONES = -4;

// ── Cue timing inside one event ─────────────────────────────────
export const SOUND_ALERT_CRY_DELAY_MS = 380;
export const SOUND_FAINT_SFX_DELAY_MS = 450;
export const SOUND_THROW_POP_DELAY_MS = 420;
export const SOUND_POP_CRY_DELAY_MS = 260;
/** The office's evolution flash lasts 1.2 s; the new cry follows it. */
export const SOUND_EVOLUTION_CRY_DELAY_MS = 1_150;

// ── Limiter (soundLimiter.ts) ───────────────────────────────────
export const SOUND_MAX_EVENTS_PER_SECOND = 4;
export const SOUND_RATE_WINDOW_MS = 1_000;
/** At most this many cries wait behind the one playing; more are dropped. */
export const SOUND_CRY_QUEUE_MAX = 2;
/** A queued cry older than this is dropped instead of played late. */
export const SOUND_CRY_STALE_MS = 2_500;
/** A cry that got its turn but never started (or never reported its end)
 *  frees the queue after this long. Longer than SOUND_CRY_LOAD_WAIT_MS. */
export const SOUND_CRY_MAX_PLAY_MS = 3_000;
/** A playing cry holds the queue for its duration plus this much, in case
 *  its `ended` event never comes. */
export const SOUND_CRY_END_GRACE_MS = 500;
/** Per agent: the same event for the same agent stays quiet this long. */
export const SOUND_AGENT_COOLDOWN_MS: Readonly<Partial<Record<SoundEventName, number>>> = {
  needsYou: 10_000,
  faint: 10_000,
  revived: 10_000,
  levelUp: 10_000,
  evolution: 5_000,
  spawned: 5_000,
  arrived: 5_000,
  message: 2_000,
  recall: 3_000,
  done: 5_000,
};
/** Across agents: noisy events at most once per this gap (a burst of
 *  arrivals after a scope change pops once, not twenty times). */
export const SOUND_EVENT_MIN_GAP_MS: Readonly<Partial<Record<SoundEventName, number>>> = {
  arrived: 1_500,
  spawned: 800,
  recall: 600,
  message: 400,
  levelUp: 800,
};

// ── Engine (audioEngine.ts) ─────────────────────────────────────
/** Bus levels before the user's volume. */
export const SOUND_BUS_GAIN_CRIES = 0.6;
export const SOUND_BUS_GAIN_ALERTS = 0.6;
export const SOUND_BUS_GAIN_EFFECTS = 0.5;
/** Decoded files (cries, sound pack) are brought to this RMS before their
 *  bus: about the synth's own level (loudness.ts). Cries are mastered 6-10 dB
 *  hotter than the effects and differ by species. */
export const SOUND_FILE_TARGET_RMS = 0.12;
export const SOUND_FILE_GAIN_MIN = 0.1;
export const SOUND_FILE_GAIN_MAX = 2;
/** Samples quieter than this don't count toward a file's loudness. */
export const SOUND_FILE_SILENCE = 0.001;
/** Effects drop to this fraction while a cry plays. */
export const SOUND_DUCK_GAIN = 0.4;
export const SOUND_DUCK_ATTACK_SEC = 0.04;
export const SOUND_DUCK_RELEASE_SEC = 0.18;
/** Fade at both ends of a cry or pack file, against clicks. */
export const SOUND_BUFFER_FADE_SEC = 0.006;
/** Fade-out of a cry cut short (a click on another Pokémon, Sounds off). */
export const SOUND_CRY_STOP_FADE_SEC = 0.012;
/** Gain ramps for volume changes. */
export const SOUND_VOLUME_RAMP_SEC = 0.05;
/** Quantization levels of the synth's bit-crush shaper. */
export const SOUND_CRUSH_LEVELS = 64;
/** How long a cry may take to load before its cue is dropped. */
export const SOUND_CRY_LOAD_WAIT_MS = 1_500;
/** After a cry or pack file failed to load, don't ask again for this long. */
export const SOUND_LOAD_RETRY_MS = 60_000;

// ── Preferences (soundPrefs.ts) ─────────────────────────────────
export const SOUND_PREF_VOLUME_KEY = 'pixel-agents.sound.volume';
export const SOUND_PREF_CRIES_KEY = 'pixel-agents.sound.cries';
export const SOUND_PREF_ALERTS_KEY = 'pixel-agents.sound.alerts';
export const SOUND_PREF_EFFECTS_KEY = 'pixel-agents.sound.effects';
export const SOUND_DEFAULT_VOLUME = 0.6;

// ── Sound pack (soundPack.ts) ───────────────────────────────────
export const SOUND_PACK_LIST_URL = '/api/sounds';
export const SOUND_PACK_FILE_URL_PREFIX = '/api/sounds/';
/** Shown in Settings: where the user drops sound pack files. */
export const SOUND_PACK_FOLDER_LABEL = '~/.pixel-agents/sounds';

// ── Credits ─────────────────────────────────────────────────────
/** Where the cries come from (Settings → Credits). */
export const POKEAPI_CRIES_REPO_URL = 'https://github.com/PokeAPI/cries';
