/**
 * How many of the sounds the policy asks for actually play. Pure, with an
 * explicit clock, so the Node runner can test it.
 *
 * - SoundLimiter admits or drops a whole SoundEvent: at most
 *   SOUND_MAX_EVENTS_PER_SECOND events per second, a per-agent cooldown per
 *   event, and a minimum gap between noisy events across agents. Events a
 *   user started (opening a Pokédex) always pass, and count toward the rate.
 * - CryQueue keeps cries one at a time: a cry asked for while another plays
 *   waits (at most SOUND_CRY_QUEUE_MAX of them); more are dropped, and a
 *   waiting cry older than SOUND_CRY_STALE_MS is dropped instead of played
 *   late. A user's cry interrupts the one playing.
 */

import {
  SOUND_AGENT_COOLDOWN_MS,
  SOUND_CRY_MAX_PLAY_MS,
  SOUND_CRY_QUEUE_MAX,
  SOUND_CRY_STALE_MS,
  SOUND_EVENT_MIN_GAP_MS,
  SOUND_MAX_EVENTS_PER_SECOND,
  SOUND_RATE_WINDOW_MS,
} from './constants.js';
import type { SoundEvent, SoundEventName } from './soundEvents.js';

export interface SoundLimiterOptions {
  maxEventsPerWindow?: number;
  windowMs?: number;
  agentCooldownMs?: Readonly<Partial<Record<SoundEventName, number>>>;
  eventMinGapMs?: Readonly<Partial<Record<SoundEventName, number>>>;
}

export class SoundLimiter {
  private readonly maxEvents: number;
  private readonly windowMs: number;
  private readonly agentCooldownMs: Readonly<Partial<Record<SoundEventName, number>>>;
  private readonly eventMinGapMs: Readonly<Partial<Record<SoundEventName, number>>>;
  /** Times of admitted events inside the rate window, oldest first. */
  private recent: number[] = [];
  private readonly lastByAgent = new Map<string, number>();
  private readonly lastByEvent = new Map<SoundEventName, number>();

  constructor(opts: SoundLimiterOptions = {}) {
    this.maxEvents = opts.maxEventsPerWindow ?? SOUND_MAX_EVENTS_PER_SECOND;
    this.windowMs = opts.windowMs ?? SOUND_RATE_WINDOW_MS;
    this.agentCooldownMs = opts.agentCooldownMs ?? SOUND_AGENT_COOLDOWN_MS;
    this.eventMinGapMs = opts.eventMinGapMs ?? SOUND_EVENT_MIN_GAP_MS;
  }

  /** True when `event` may play now; records it if so. */
  admit(event: SoundEvent, now: number): boolean {
    this.recent = this.recent.filter((t) => now - t < this.windowMs);
    const agentKey = event.agentId !== undefined ? `${event.name}:${event.agentId}` : null;
    if (!event.user) {
      if (this.recent.length >= this.maxEvents) return false;
      const gap = this.eventMinGapMs[event.name] ?? 0;
      const lastEvent = this.lastByEvent.get(event.name);
      if (gap > 0 && lastEvent !== undefined && now - lastEvent < gap) return false;
      const cooldown = this.agentCooldownMs[event.name] ?? 0;
      const lastAgent = agentKey !== null ? this.lastByAgent.get(agentKey) : undefined;
      if (cooldown > 0 && lastAgent !== undefined && now - lastAgent < cooldown) return false;
    }
    this.recent.push(now);
    this.lastByEvent.set(event.name, now);
    if (agentKey !== null) this.lastByAgent.set(agentKey, now);
    return true;
  }
}

/** A cry waiting for its turn. */
export interface CryRequest {
  dex: number;
  semitones: number;
  /** When it was asked for (staleness). */
  at: number;
  user?: boolean;
}

export type CryVerdict = 'play' | 'queued' | 'dropped';

export interface CryQueueOptions {
  maxQueued?: number;
  staleMs?: number;
  maxPlayMs?: number;
}

export class CryQueue {
  private readonly maxQueued: number;
  private readonly staleMs: number;
  private readonly maxPlayMs: number;
  private queue: CryRequest[] = [];
  private playingSince: number | null = null;

  constructor(opts: CryQueueOptions = {}) {
    this.maxQueued = opts.maxQueued ?? SOUND_CRY_QUEUE_MAX;
    this.staleMs = opts.staleMs ?? SOUND_CRY_STALE_MS;
    this.maxPlayMs = opts.maxPlayMs ?? SOUND_CRY_MAX_PLAY_MS;
  }

  /** A cry is playing (and hasn't overrun SOUND_CRY_MAX_PLAY_MS). */
  isPlaying(now: number): boolean {
    return this.playingSince !== null && now - this.playingSince < this.maxPlayMs;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /**
   * Ask to play a cry. 'play': start it now (for a user cry, after stopping
   * the one playing). 'queued': wait for `finished`. 'dropped': forget it.
   */
  request(req: CryRequest, now: number): CryVerdict {
    if (req.user || !this.isPlaying(now)) {
      this.playingSince = now;
      return 'play';
    }
    if (this.queue.length >= this.maxQueued) return 'dropped';
    this.queue.push(req);
    return 'queued';
  }

  /** The playing cry ended (or failed). Returns the next fresh one to play
   *  now, if any, already marked as playing. */
  finished(now: number): CryRequest | null {
    this.playingSince = null;
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (now - next.at <= this.staleMs) {
        this.playingSince = now;
        return next;
      }
    }
    return null;
  }

  /** Forget everything (sound switched off, socket dropped). */
  clear(): void {
    this.queue = [];
    this.playingSince = null;
  }
}
