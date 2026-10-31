/**
 * The sound limiter: the global rate, per-agent cooldowns, the gap between
 * noisy events, user sounds, and the one-cry-at-a-time queue.
 */

import { describe, expect, it } from 'vitest';

import { SOUND_AGENT_COOLDOWN_MS } from '../src/audio/constants.js';
import type { SoundEvent, SoundEventName } from '../src/audio/soundEvents.js';
import { sfx } from '../src/audio/soundEvents.js';
import { CryQueue, SoundLimiter } from '../src/audio/soundLimiter.js';

const event = (name: SoundEventName, agentId?: number, user = false): SoundEvent => ({
  name,
  agentId,
  cues: [sfx('blip')],
  user,
});

describe('SoundLimiter', () => {
  it('admits at most four events per second', () => {
    const limiter = new SoundLimiter();
    const t = 10_000;
    const admitted = [1, 2, 3, 4, 5, 6].map((id) => limiter.admit(event('needsYou', id), t + id));
    expect(admitted).toEqual([true, true, true, true, false, false]);
    expect(limiter.admit(event('needsYou', 7), t + 1_001)).toBe(true);
  });

  it('keeps a per-agent cooldown per event', () => {
    const limiter = new SoundLimiter();
    expect(limiter.admit(event('faint', 1), 0)).toBe(true);
    expect(limiter.admit(event('faint', 1), 5_000)).toBe(false);
    expect(limiter.admit(event('faint', 2), 5_000)).toBe(true);
    expect(limiter.admit(event('revived', 1), 5_000)).toBe(true);
    expect(limiter.admit(event('faint', 1), SOUND_AGENT_COOLDOWN_MS.faint!)).toBe(true);
  });

  it('plays at most one level-up per agent per 10 s', () => {
    const limiter = new SoundLimiter();
    expect(limiter.admit(event('levelUp', 1), 0)).toBe(true);
    expect(limiter.admit(event('levelUp', 1), 9_999)).toBe(false);
    expect(limiter.admit(event('levelUp', 1), 10_000)).toBe(true);
  });

  it('spaces noisy events across agents (a burst of arrivals pops once)', () => {
    const limiter = new SoundLimiter();
    const results = [1, 2, 3, 4].map((id) => limiter.admit(event('arrived', id), id * 100));
    expect(results).toEqual([true, false, false, false]);
    expect(limiter.admit(event('arrived', 5), 1_700)).toBe(true);
  });

  it('forgets per-agent cooldowns once they can no longer hold anything back', () => {
    const limiter = new SoundLimiter({
      maxEventsPerWindow: 1_000,
      eventMinGapMs: {},
      agentCooldownMs: { faint: 1_000, recall: 2_000 },
    });
    for (let id = 0; id < 50; id++) limiter.admit(event('recall', id), id * 10);
    expect(limiter.trackedAgentCount).toBe(50);
    // At 2.3 s the recalls from 0-300 ms are past the longest cooldown (2 s).
    expect(limiter.admit(event('faint', 99), 2_300)).toBe(true);
    expect(limiter.trackedAgentCount).toBe(50 - 31 + 1);
    expect(limiter.admit(event('faint', 100), 5_000)).toBe(true);
    expect(limiter.trackedAgentCount).toBe(1);
    // Pruning never lifts a cooldown early.
    expect(limiter.admit(event('faint', 100), 5_500)).toBe(false);
  });

  it('always admits what a user started, and counts it', () => {
    const limiter = new SoundLimiter();
    for (let i = 0; i < 4; i++) expect(limiter.admit(event('pokedex', 1, true), i)).toBe(true);
    expect(limiter.admit(event('pokedex', 1, true), 10)).toBe(true);
    expect(limiter.admit(event('needsYou', 2), 20)).toBe(false);
  });
});

describe('CryQueue', () => {
  const req = (dex: number, at: number, user = false) => ({ dex, semitones: 0, at, user });

  it('plays one cry at a time, queues two, drops the rest', () => {
    const queue = new CryQueue();
    expect(queue.request(req(1, 0), 0)).toBe('play');
    expect(queue.request(req(2, 10), 10)).toBe('queued');
    expect(queue.request(req(3, 20), 20)).toBe('queued');
    expect(queue.request(req(4, 30), 30)).toBe('dropped');
    expect(queue.finished(500)?.dex).toBe(2);
    expect(queue.finished(900)?.dex).toBe(3);
    expect(queue.finished(1_300)).toBeNull();
    expect(queue.isPlaying(1_300)).toBe(false);
  });

  it('drops a waiting cry that went stale', () => {
    const queue = new CryQueue({ staleMs: 1_000 });
    queue.request(req(1, 0), 0);
    queue.request(req(2, 100), 100);
    queue.request(req(3, 1_900), 1_900);
    expect(queue.finished(2_000)?.dex).toBe(3);
  });

  it('a user cry interrupts the one playing', () => {
    const queue = new CryQueue();
    queue.request(req(1, 0), 0);
    expect(queue.request(req(2, 10, true), 10)).toBe('play');
    expect(queue.isPlaying(20)).toBe(true);
  });

  it('recovers when a cry never reports its end', () => {
    const queue = new CryQueue({ maxPlayMs: 3_000 });
    queue.request(req(1, 0), 0);
    expect(queue.request(req(2, 100), 100)).toBe('queued');
    expect(queue.request(req(3, 3_100), 3_100)).toBe('play');
  });

  it('a cry that loaded slowly holds the queue for its whole duration', () => {
    const queue = new CryQueue({ maxPlayMs: 3_000, endGraceMs: 500 });
    queue.request(req(1, 0), 0);
    // Loaded after 1.4 s; a faint cry slowed down to 2.5 s sounds until 3.9 s.
    queue.started(1_400, 2_500);
    expect(queue.request(req(2, 3_100), 3_100)).toBe('queued');
    expect(queue.isPlaying(4_350)).toBe(true);
    expect(queue.isPlaying(4_400)).toBe(false);
  });

  it('clear forgets the queue and the playing cry', () => {
    const queue = new CryQueue();
    queue.request(req(1, 0), 0);
    queue.request(req(2, 0), 0);
    queue.clear();
    expect(queue.queuedCount).toBe(0);
    expect(queue.isPlaying(1)).toBe(false);
    expect(queue.request(req(3, 1), 1)).toBe('play');
  });
});
