/**
 * Which sounds the office plays for what happens to each session.
 *
 * Pure and DOM-free so the Node runner can test it: `SoundDirector` reads the
 * same ServerMessages as the rest of the office, keeps its own small memory
 * per agent (species, level, status), and answers each message with the
 * SoundEvents it deserves. The limiter (soundLimiter.ts) then decides which
 * of those actually play, and the engine (audioEngine.ts) plays them.
 *
 * | Happening                                    | Event       | Sounds                         |
 * | -------------------------------------------- | ----------- | ------------------------------ |
 * | needs your answer or a permission            | needsYou    | alert, then its cry            |
 * | errors (faints)                              | faint       | its cry 4 semitones down, faint|
 * | error cleared by new activity                | revived     | heal                           |
 * | level goes up (live, a small step)           | levelUp     | level-up                       |
 * | evolves                                      | evolution   | evolution, then the new cry    |
 * | new session created by a Lead (live)         | spawned     | capsule throw, pop, its cry    |
 * | any other new session (live)                 | arrived     | pop, its cry                   |
 * | one session messages another (live)          | message     | whoosh                         |
 * | leaves the office (hidden, archived, scope)  | recall      | recall                         |
 * | the selected or a pinned session finished    | done        | soft two-note                  |
 * | you open its Pokédex                         | pokedex     | its cry (user)                 |
 *
 * Every sound is for stream agents (Conductor sessions) only: upstream
 * agents keep the office's chime (notificationSound.ts, chimePolicy.ts) and
 * VS Code sounds as it always did. Nothing sounds for a `silent`
 * status, for SOUND_QUIET_AFTER_CONNECT_MS after the socket connects or the
 * server replays the office, or for the arrivals and level fills of the
 * initial load. With the Pokémon theme off only the alert sounds remain.
 */

import type { ServerMessage } from '../../../core/src/messages.js';
import { crossesEvolutionLevel } from '../conductor/conductorStore.js';
import {
  SOUND_ALERT_CRY_DELAY_MS,
  SOUND_ARRIVAL_CHAIN_MS,
  SOUND_EVOLUTION_CRY_DELAY_MS,
  SOUND_FAINT_CRY_SEMITONES,
  SOUND_FAINT_SFX_DELAY_MS,
  SOUND_LEVEL_SETTLE_MS,
  SOUND_MAX_LEVEL_UP_STEP,
  SOUND_POP_CRY_DELAY_MS,
  SOUND_QUIET_AFTER_CONNECT_MS,
  SOUND_SPAWN_DEDUPE_MS,
  SOUND_THROW_POP_DELAY_MS,
} from './constants.js';
import type { SoundCue, SoundEvent } from './soundEvents.js';
import { cry, keepCues, sfx, SFX_CATEGORY, sfxAfterCry } from './soundEvents.js';

export interface DirectorContext {
  now: number;
  /** The office's selected character (OfficeState.selectedAgentId). */
  selectedAgentId: number | null;
}

export interface SoundDirectorOptions {
  quietMs?: number;
  arrivalChainMs?: number;
  maxLevelUpStep?: number;
  levelSettleMs?: number;
  spawnDedupeMs?: number;
}

interface AgentMemory {
  /** Fed by a stream provider (providerId set). */
  stream: boolean;
  species?: number;
  level?: number;
  /** The level when the current species was set (evolution detection). */
  speciesLevel?: number;
  /** An agentDetails carried messageCount: the level is the real one. */
  hasMessageCount: boolean;
  status?: 'active' | 'waiting' | 'error';
  awaiting: boolean;
  permission: boolean;
  /** When this client learned about the agent. */
  knownSince: number;
  /** When its arrival sound was asked for (spawn dedupe). */
  arrivalSoundAt?: number;
}

export class SoundDirector {
  private readonly quietMs: number;
  private readonly arrivalChainMs: number;
  private readonly maxLevelUpStep: number;
  private readonly levelSettleMs: number;
  private readonly spawnDedupeMs: number;
  private readonly agents = new Map<number, AgentMemory>();
  private pinned: ReadonlySet<number> = new Set();
  private theme = true;
  private quietUntil = Number.NEGATIVE_INFINITY;
  private arrivalChainUntil = Number.NEGATIVE_INFINITY;

  constructor(opts: SoundDirectorOptions = {}) {
    this.quietMs = opts.quietMs ?? SOUND_QUIET_AFTER_CONNECT_MS;
    this.arrivalChainMs = opts.arrivalChainMs ?? SOUND_ARRIVAL_CHAIN_MS;
    this.maxLevelUpStep = opts.maxLevelUpStep ?? SOUND_MAX_LEVEL_UP_STEP;
    this.levelSettleMs = opts.levelSettleMs ?? SOUND_LEVEL_SETTLE_MS;
    this.spawnDedupeMs = opts.spawnDedupeMs ?? SOUND_SPAWN_DEDUPE_MS;
  }

  /** The socket connected (first time or after a drop): what follows is a replay. */
  connected(now: number): void {
    this.startQuiet(now);
  }

  /** The species an agent shows, if known. */
  speciesOf(agentId: number): number | undefined {
    return this.agents.get(agentId)?.species;
  }

  /** Fold one ServerMessage in; returns the sounds it deserves. */
  handle(msg: ServerMessage, ctx: DirectorContext): SoundEvent[] {
    const events = this.reduce(msg, ctx);
    return this.theme ? events : alertsOnly(events);
  }

  /** The user opened an agent's Pokédex: its cry (a blip when it has none). */
  pokedexOpened(agentId: number): SoundEvent[] {
    const species = this.agents.get(agentId)?.species;
    const cues = this.theme && species !== undefined ? [cry(species)] : [sfx('blip')];
    return [{ name: 'pokedex', agentId, cues, user: true }];
  }

  pokedexClosed(): SoundEvent[] {
    return [{ name: 'uiBlip', cues: [sfx('blip')], user: true }];
  }

  /** The agent is in the office as far as this director knows. */
  isPresent(agentId: number): boolean {
    return this.agents.has(agentId);
  }

  // ── Reducer ────────────────────────────────────────────────

  private reduce(msg: ServerMessage, ctx: DirectorContext): SoundEvent[] {
    const { now } = ctx;
    switch (msg.type) {
      case 'settingsLoaded':
        this.theme = msg.pokemonTheme !== false;
        return [];
      case 'pokemonThemeUpdated':
        this.theme = msg.enabled === true;
        return [];
      case 'conductorSessions': {
        const pinned = new Set<number>();
        for (const s of Array.isArray(msg.sessions) ? msg.sessions : []) {
          if (s.pinned === true && typeof s.agentId === 'number') pinned.add(s.agentId);
        }
        this.pinned = pinned;
        return [];
      }
      case 'existingAgents': {
        this.startQuiet(now);
        const listed = new Set(Array.isArray(msg.agents) ? msg.agents : []);
        // The office as it is now: forget agents that left while we weren't looking.
        for (const id of this.agents.keys()) if (!listed.has(id)) this.agents.delete(id);
        for (const id of listed) {
          const mem = this.memory(id, now);
          const meta = msg.agentMeta?.[String(id)];
          if (meta?.species !== undefined) mem.species = meta.species;
        }
        return [];
      }
      case 'agentCreated':
        return this.onCreated(msg, now);
      case 'agentClosed': {
        const mem = this.agents.get(msg.id);
        this.agents.delete(msg.id);
        if (!mem?.stream || this.isQuiet(now)) return [];
        return [{ name: 'recall', agentId: msg.id, cues: [sfx('recall')] }];
      }
      case 'agentDetails':
        return this.onDetails(msg, now);
      case 'agentStatus':
        return this.onStatus(msg, ctx);
      case 'agentToolPermission': {
        const mem = this.memory(msg.id, now);
        const neededYou = mem.awaiting || mem.permission;
        mem.permission = true;
        if (neededYou || !mem.stream || this.isQuiet(now)) return [];
        return [this.needsYou(msg.id, mem)];
      }
      case 'agentToolPermissionClear': {
        const mem = this.agents.get(msg.id);
        if (mem) mem.permission = false;
        return [];
      }
      case 'agentMessage': {
        if (this.isQuiet(now)) return [];
        if (msg.kind === 'messaged') {
          return [{ name: 'message', agentId: msg.toId, cues: [sfx('message')] }];
        }
        if (msg.kind === 'spawned') {
          const child = this.agents.get(msg.toId);
          const arrivedAt = child?.arrivalSoundAt;
          if (arrivedAt !== undefined && now - arrivedAt < this.spawnDedupeMs) return [];
          return [{ name: 'spawned', agentId: msg.toId, cues: [sfx('ballThrow')] }];
        }
        return [];
      }
      default:
        return [];
    }
  }

  private onCreated(
    msg: Extract<ServerMessage, { type: 'agentCreated' }>,
    now: number,
  ): SoundEvent[] {
    const known = this.agents.has(msg.id);
    const mem = this.memory(msg.id, now);
    if (msg.providerId !== undefined) mem.stream = true;
    if (msg.species !== undefined && msg.species !== mem.species) {
      mem.species = msg.species;
      mem.speciesLevel = msg.level ?? mem.level;
    }
    if (msg.level !== undefined) mem.level = msg.level;
    mem.speciesLevel ??= mem.level;

    // The initial load: the quiet window, and arrivals chained to it.
    if (this.isQuiet(now) || now < this.arrivalChainUntil) {
      this.arrivalChainUntil = Math.max(this.arrivalChainUntil, now + this.arrivalChainMs);
      return [];
    }
    if (known || !mem.stream) return [];
    mem.arrivalSoundAt = now;
    const species = mem.species;
    if (msg.parentAgentId !== undefined) {
      const cues: SoundCue[] = [sfx('ballThrow'), sfx('ballPop', SOUND_THROW_POP_DELAY_MS)];
      if (species !== undefined) {
        cues.push(cry(species, SOUND_THROW_POP_DELAY_MS + SOUND_POP_CRY_DELAY_MS));
      }
      return [{ name: 'spawned', agentId: msg.id, cues }];
    }
    const cues: SoundCue[] = [sfx('ballPop')];
    if (species !== undefined) cues.push(cry(species, SOUND_POP_CRY_DELAY_MS));
    return [{ name: 'arrived', agentId: msg.id, cues }];
  }

  private onDetails(
    msg: Extract<ServerMessage, { type: 'agentDetails' }>,
    now: number,
  ): SoundEvent[] {
    const known = this.agents.has(msg.id);
    const mem = this.memory(msg.id, now);
    if (msg.providerId !== undefined) mem.stream = true;
    const prevSpecies = mem.species;
    const prevLevel = mem.level;
    const prevSpeciesLevel = mem.speciesLevel ?? prevLevel;
    const filledIn = !mem.hasMessageCount && msg.messageCount !== undefined;
    if (msg.messageCount !== undefined) mem.hasMessageCount = true;
    const level = msg.level ?? prevLevel;
    if (msg.species !== undefined && msg.species !== prevSpecies) {
      mem.species = msg.species;
      mem.speciesLevel = level;
    }
    if (msg.level !== undefined) mem.level = msg.level;
    mem.speciesLevel ??= mem.level;

    if (!known || !mem.stream || this.isQuiet(now)) return [];
    // A level that jumps, arrives with the first message count, or changes
    // right after the agent arrived is being filled in, not earned.
    const fill =
      filledIn ||
      now - mem.knownSince < this.levelSettleMs ||
      (prevLevel !== undefined && level !== undefined && level - prevLevel > this.maxLevelUpStep);
    if (fill) return [];

    if (
      prevSpecies !== undefined &&
      msg.species !== undefined &&
      msg.species !== prevSpecies &&
      crossesEvolutionLevel(prevSpeciesLevel, level)
    ) {
      return [
        {
          name: 'evolution',
          agentId: msg.id,
          cues: [sfx('evolution'), cry(msg.species, SOUND_EVOLUTION_CRY_DELAY_MS)],
        },
      ];
    }
    if (prevLevel !== undefined && msg.level !== undefined && msg.level > prevLevel) {
      return [{ name: 'levelUp', agentId: msg.id, cues: [sfx('levelUp')] }];
    }
    return [];
  }

  private onStatus(
    msg: Extract<ServerMessage, { type: 'agentStatus' }>,
    ctx: DirectorContext,
  ): SoundEvent[] {
    const { now } = ctx;
    const mem = this.memory(msg.id, now);
    const prevStatus = mem.status;
    const neededYou = mem.awaiting || mem.permission;
    mem.status = msg.status;
    mem.awaiting = msg.status === 'waiting' && msg.awaitingInput === true;
    // A turn that ended or failed has no permission prompt open any more.
    if (msg.status !== 'active') mem.permission = false;

    if (msg.silent === true || !mem.stream || this.isQuiet(now)) return [];
    if (mem.awaiting && !neededYou) return [this.needsYou(msg.id, mem)];
    if (msg.status === 'error' && prevStatus !== 'error') {
      const cues: SoundCue[] =
        mem.species !== undefined
          ? [
              cry(mem.species, 0, SOUND_FAINT_CRY_SEMITONES),
              sfxAfterCry('faint', SOUND_FAINT_SFX_DELAY_MS),
            ]
          : [sfx('faint')];
      return [{ name: 'faint', agentId: msg.id, cues }];
    }
    if (msg.status === 'active' && prevStatus === 'error') {
      return [{ name: 'revived', agentId: msg.id, cues: [sfx('heal')] }];
    }
    if (
      msg.status === 'waiting' &&
      !mem.awaiting &&
      prevStatus !== 'waiting' &&
      (ctx.selectedAgentId === msg.id || this.pinned.has(msg.id))
    ) {
      return [{ name: 'done', agentId: msg.id, cues: [sfx('done')] }];
    }
    return [];
  }

  // ── Helpers ────────────────────────────────────────────────

  private needsYou(id: number, mem: AgentMemory): SoundEvent {
    const cues: SoundCue[] = [sfx('alert')];
    if (mem.species !== undefined) cues.push(cry(mem.species, SOUND_ALERT_CRY_DELAY_MS));
    return { name: 'needsYou', agentId: id, cues };
  }

  private memory(id: number, now: number): AgentMemory {
    let mem = this.agents.get(id);
    if (!mem) {
      mem = {
        stream: false,
        hasMessageCount: false,
        awaiting: false,
        permission: false,
        knownSince: now,
      };
      this.agents.set(id, mem);
    }
    return mem;
  }

  private startQuiet(now: number): void {
    this.quietUntil = Math.max(this.quietUntil, now + this.quietMs);
    this.arrivalChainUntil = Math.max(
      this.arrivalChainUntil,
      this.quietUntil + this.arrivalChainMs,
    );
  }

  private isQuiet(now: number): boolean {
    return now < this.quietUntil;
  }
}

/** Theme off: only the sounds that say something about a session remain. */
function alertsOnly(events: SoundEvent[]): SoundEvent[] {
  const out: SoundEvent[] = [];
  for (const event of events) {
    const cues = keepCues(event.cues, (c) => c.kind === 'sfx' && SFX_CATEGORY[c.name] === 'alerts');
    if (cues.length > 0) out.push({ ...event, cues });
  }
  return out;
}
