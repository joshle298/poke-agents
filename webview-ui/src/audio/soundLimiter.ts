/**
 * How many of the sounds the policy asks for actually play. Pure, with an
 * explicit clock, so the Node runner can test it.
 *
 * - SoundLimiter admits or drops a whole SoundEvent: at most
 *   SOUND_MAX_EVENTS_PER_SECOND events per second, a per-agent cooldown per
 *   event, and a minimum gap between noisy events across agents. Events a
 *   user started (opening a Pokédex) always pass, and count toward the rate.
 * - CryQueue keeps cries one at a time: a cry asked for while another loads
 *   or plays waits (at most SOUND_CRY_QUEUE_MAX of them); more are dropped,
 *   and a waiting cry older than SOUND_CRY_STALE_MS is dropped instead of
 *   played late. A user's cry interrupts the one playing.
 */

import {
  SOUND_AGENT_COOLDOWN_MS,
  SOUND_CRY_END_GRACE_MS,
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
  /** The longest per-agent cooldown: older lastByAgent entries are dropped. */
  private readonly maxCooldownMs: number;
  /** Times of admitted events inside the rate window, oldest first. */
  private recent: number[] = [];
  private readonly lastByAgent = new Map<string, number>();
  private readonly lastByEvent = new Map<SoundEventName, number>();
  private lastPruneAt = Number.NEGATIVE_INFINITY;

  constructor(opts: SoundLimiterOptions = {}) {
    this.maxEvents = opts.maxEventsPerWindow ?? SOUND_MAX_EVENTS_PER_SECOND;
    this.windowMs = opts.windowMs ?? SOUND_RATE_WINDOW_MS;
    this.agentCooldownMs = opts.agentCooldownMs ?? SOUND_AGENT_COOLDOWN_MS;
    this.eventMinGapMs = opts.eventMinGapMs ?? SOUND_EVENT_MIN_GAP_MS;
    this.maxCooldownMs = Math.max(0, ...Object.values(this.agentCooldownMs));
  }

  /** Per-agent cooldowns still being tracked (bounded by the longest cooldown). */
  get trackedAgentCount(): number {
    return this.lastByAgent.size;
  }

  /** True when `event` may play now; records it if so. */
  admit(event: SoundEvent, now: number): boolean {
    this.recent = this.recent.filter((t) => now - t < this.windowMs);
    this.prune(now);
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

  /** Forget cooldowns that can no longer hold anything back (agent ids keep
   *  growing in a long-running office). At most once per longest cooldown. */
  private prune(now: number): void {
    if (now - this.lastPruneAt < this.maxCooldownMs) return;
    this.lastPruneAt = now;
    for (const [key, at] of this.lastByAgent) {
      if (now - at >= this.maxCooldownMs) this.lastByAgent.delete(key);
    }
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
  endGraceMs?: number;
}

export class CryQueue {
  private readonly maxQueued: number;
  private readonly staleMs: number;
  private readonly maxPlayMs: number;
  private readonly endGraceMs: number;
  private queue: CryRequest[] = [];
  /** Until when the current cry holds the queue; null when none does. */
  private busyUntil: number | null = null;

  constructor(opts: CryQueueOptions = {}) {
    this.maxQueued = opts.maxQueued ?? SOUND_CRY_QUEUE_MAX;
    this.staleMs = opts.staleMs ?? SOUND_CRY_STALE_MS;
    this.maxPlayMs = opts.maxPlayMs ?? SOUND_CRY_MAX_PLAY_MS;
    this.endGraceMs = opts.endGraceMs ?? SOUND_CRY_END_GRACE_MS;
  }

  /** A cry is loading or playing (and hasn't overrun its watchdog). */
  isPlaying(now: number): boolean {
    return this.busyUntil !== null && now < this.busyUntil;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /**
   * Ask to play a cry. 'play': start it now, after stopping any cry still
   * sounding (a user cry always gets 'play'). 'queued': wait for `finished`.
   * 'dropped': forget it.
   */
  request(req: CryRequest, now: number): CryVerdict {
    if (req.user || !this.isPlaying(now)) {
      this.busyUntil = now + this.maxPlayMs;
      return 'play';
    }
    if (this.queue.length >= this.maxQueued) return 'dropped';
    this.queue.push(req);
    return 'queued';
  }

  /** The cry that got 'play' loaded and sounds for `durationMs`: it holds
   *  the queue that long, whatever its load took (a slow load plus a long,
   *  slowed-down faint cry can outlast the load watchdog). */
  started(now: number, durationMs: number): void {
    this.busyUntil = now + durationMs + this.endGraceMs;
  }

  /** The playing cry ended (or failed). Returns the next fresh one to play
   *  now, if any, already marked as playing. */
  finished(now: number): CryRequest | null {
    this.busyUntil = null;
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (now - next.at <= this.staleMs) {
        this.busyUntil = now + this.maxPlayMs;
        return next;
      }
    }
    return null;
  }

  /** Forget everything (sound switched off, socket dropped). */
  clear(): void {
    this.queue = [];
    this.busyUntil = null;
  }
}
